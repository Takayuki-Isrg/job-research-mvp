# フローティングAIボタン：設計調査

作成日：2026-11-13
状態：設計調査のみ。コードは未実装。

## 1. 目的と範囲

求人ページの右下に固定表示するボタンを追加し、左クリックで既存の「この求人を調べる」（右クリックメニュー）と同じ処理を起動できるようにする。

- 起動するのは既存の求人取得・判定・確認画面まで。Ollama分析は従来どおり確認画面で手動実行する。
- 外部口コミサイト等の企業調査は実装しない。
- 拡張を常時動作させる仕組みは追加しない。
- 既存処理を重複実装しない。
- ボタン画像は仮アイコンとする。

## 2. 結論

既存の `captureJob()` をそのまま呼び出せる。新たに必要なのは次の3点。

- ページにボタンを表示するContent Script
- Background側のメッセージ受付
- 表示を切り替える設定

最大の論点は権限である。Content Script上のボタンのクリックでは `activeTab` が付与されないため、ボタンを表示するサイトには別途host権限が必要になる。

## 3. 既存処理の調査と再利用

- 右クリックの起点は `extension/background.js` の `contextMenus.onClicked` で、`captureJob(chrome, tab, info.pageUrl)` を呼ぶだけである。
- `extension/workflow.js` の `captureJob(api, tab, pageUrl)` はメニュー固有の情報を使わない。使うのは `tab.id` とURLのみ。
- 取得中のページ移動の検出、確認タブの作成、`documentId` による同一文書の確認、`chrome.storage.session` への保存は、すべて同関数内で完結している。
- したがって、Backgroundで `captureJob(chrome, sender.tab, sender.url)` を呼べば再利用できる。

### 権限上の制約

- 現在は右クリックメニューの操作で `activeTab` が付与され、`scripting.executeScript` が成功している。
- ボタンのクリックではこの権限が付与されない。対象サイトのhost権限がないと、`captureJob` 内の `executeScript` が失敗する。同じ理由で `tabs.get` の `url` も取得できない。
- 「全サイトに表示」には `<all_urls>` が必要になる。README の「右クリックしたページだけを読み取り」という方針に反するため推奨しない。

## 4. 構成・対象サイト・権限

### 推奨：任意権限と動的登録

| 項目 | 内容 |
|---|---|
| manifest | `"optional_host_permissions": ["https://mypage.r-agent.com/*"]` を追加する。既存の `permissions`・`host_permissions` は変えず、インストール時の権限は増やさない |
| 有効化 | 希望条件の管理画面のチェックボックス操作時に `chrome.permissions.request()` を呼ぶ（拡張画面での利用者操作が必要） |
| 登録 | 許可後に `chrome.scripting.registerContentScripts()` で `floating-button.js` を登録する（既存の `scripting` 権限で足りる） |
| 無効化 | `unregisterContentScripts()` を呼び、必要に応じて `permissions.remove()` も呼ぶ |
| 対象の限定 | matchは `https://mypage.r-agent.com/*` とし、スクリプト側で `location.pathname` が `^/joboffers/\d+/?$` に一致するときだけ表示する。match patternでは数値IDまで絞れず、一覧から詳細への画面内遷移にも対応するため |

### 次点：静的manifest

manifestに `content_scripts` とhost権限を静的に記述する方法。実装は簡単だが、全利用者に常時の読み取り権限が付く。パッケージ配布時は更新で権限が増えたことにより拡張が無効化される（開発者モードでの読み込みでは問題ない）。最小権限の方針に合わないため次点とする。

### 常時動作について

Content Scriptは対象ページを開いている間だけ動作し、Service Workerはメッセージ受信時だけ起動する。常駐の仕組みは追加しない。

## 5. 懸念と対策

| 懸念 | 対策 |
|---|---|
| ページの切り替え（画面内遷移） | 対象外のURLではボタンを隠す。`navigation` の `navigatesuccess`、`popstate`、`location.href` の軽量な監視の順で検討する。`navigation` APIがContent Scriptの実行環境でイベントを受け取れるかは実機確認が必要 |
| 連続クリック | ボタン側は応答まで `disabled` にして「取得中」と表示する。Background側はタブIDごとの処理中Setで二重起動を拒否する。`captureJob` は呼ぶたびに確認タブを作成するため |
| 二重表示 | 固定IDのホスト要素が既にあれば作成しない。拡張の再読み込み後は古いスクリプトが残るため、古い要素を削除してから作り直す |
| 再読み込み後の古いボタン | `chrome.runtime.id` が未定義、または `sendMessage` が失敗した場合は「ページを再読み込みしてください」と表示してボタンを削除する |
| サイト側CSSとの干渉 | closed Shadow DOM内で描画する。ホスト要素にはインラインで `all: initial`・`position: fixed`・`z-index: 2147483647` を `!important` 付きで指定する（外側の `* {}` 指定はホスト要素にも効くため）。`popover` による最前面表示も選択肢とする |
| 抽出結果への混入 | ボタンの文字はclosed Shadow DOM内に置く。`extractPage` の本文走査（`childNodes`）と応募ボタン検出（`querySelectorAll`）はShadow DOM内を参照しないため、判定に影響しない。ホスト要素の通常DOMには文字を置かない |
| 送信元の検証 | `sender.id === chrome.runtime.id`、`sender.tab` の存在、`sender.frameId === 0`、`sender.url` が対象パターンに一致することを確認する。メッセージは `{ type: 'inspect-job' }` のみとし、URLはメッセージから受け取らない |

## 6. 表示の切り替え

- 希望条件の管理画面に「求人ページにAIボタンを表示する」チェックボックスを追加する。
- 設定は `chrome.storage.local` の新しいキー（例：`floatingButton`）に保存し、既存の `sharedPreferences` とは分ける。
- Content Scriptは `storage.onChanged` を受けて、開いているタブでも即座に表示・非表示を切り替える。
- `chrome://extensions` から権限が外された場合に備え、`permissions.onRemoved` で設定と登録を同期する。

## 7. 影響ファイル

| ファイル | 変更 |
|---|---|
| `extension/floating-button.js`（新規） | 外部ファイルを読み込まない単独スクリプト（登録型Content Scriptはモジュールにできない）。表示・URL判定・クリック時のメッセージ送信のみを担当 |
| `extension/floating-button-settings.js`（新規） | 権限要求、登録・解除、設定の読み書き。管理画面とBackgroundの双方から使う |
| `extension/background.js` | `onMessage` に `inspect-job` の分岐を追加する。既存の `revise` の判定は条件不一致で先に `return false` するため、`revise` の処理を変えないよう分岐の順序に注意する。処理中Setと `permissions.onRemoved` も追加する |
| `extension/manifest.json` | `optional_host_permissions` を追加する |
| `extension/preferences.html` / `preferences.js` | チェックボックス欄を追加する。既存の自動保存とは別処理にする |
| `extension/workflow.js` | エラー文言「右クリックから再実行」を「もう一度実行」等に変更する（処理は変えない） |
| README / docs | 起点・権限・切り替え方法の説明を更新する |
| アイコン | 仮のSVGをスクリプト内に直接記述する。`web_accessible_resources` は不要 |

抽出・判定・修正（`extract-page.js`・`classify.js`・`review.*`）とOllama分析（`local-llm.js`・`analysis-*`）は変更しない。

## 8. 必要なテスト

### 単体テスト（node:test・jsdom）

- `background.test.js`：`inspect-job` で `captureJob` が `sender.tab` と `sender.url` で呼ばれること。不正な送信元（別の拡張、サブフレーム、対象外のURL、拡張ページ）を拒否すること。同一タブの同時要求が1回だけ実行されること。`revise` が従来どおり動作すること。
- `floating-button.test.js`：対象URLでのみ表示されること。二重実行でも1つだけ表示されること。画面内遷移に合わせて表示・非表示が切り替わること。処理中は `disabled` になること。`storage.onChanged` で切り替わること。拡張再読み込み後の失敗時の表示。
- 設定処理：許可拒否時は設定を変更しないこと。登録・解除が設定と一致すること。

### 抽出の回帰テスト

ボタンを差し込んだ状態のRA再現用HTMLで、`extractPage` の結果と判定が差し込み前と同一であること。

### ブラウザテスト（Playwright、既存の `browser-smoke.js` を拡張）

既存のRA通信の横取り（`context.route`）と、一時コピーでのhost権限付与を利用する。ボタンの表示、クリックで確認タブが開き状態が `ready` になること、連続クリックで確認タブが1つだけになること、強いCSSを当てた再現用HTMLでも表示が崩れないこと、`pushState` での遷移を確認する。

### 手動確認

- `permissions.request` の確認ダイアログ
- 実際のRAページでの画面内遷移の挙動

## 9. 懸念事項・未確認事項

1. RAが画面内遷移する作りかは未確認。クラス名の形式からNext.jsと推測しているが検証していない。実ページで一覧から詳細へ移った際にURL監視が機能するか確認が必要。
2. 推奨案（任意権限）は利用者の操作が1つ増える。管理画面でオンにして許可ダイアログを承認する必要がある。初期状態で表示したい場合は静的manifest案となり権限が増える。どちらを採るかは要判断。
3. RA以外のサイトへの拡大は別途判断する。拡大する場合はサイトごとに任意権限を追加する形を推奨する。
4. `captureJob` は失敗時も確認タブを先に開く。対象外ページでも確認タブが開いてエラーを表示するが、これは既存と同じ挙動である。
5. 自動テストでは `permissions.request` のダイアログを操作できないため、manifestで権限を与えて代替する。実際の許可の流れは手動確認となる。
