# AGENTS.md

## プロジェクト概要
- 求人票の抽出・判定・確認を行うChrome拡張機能。
- JavaScript、Chrome Extensions Manifest V3を使用。
- ローカルLLMとしてOllamaを利用する。

## 開発環境
- Node.js 20以上
- 依存関係のインストール: npm.cmd ci

## テスト
- 単体テスト: npm.cmd test
- フォーマット確認: npm.cmd run format:check
- ブラウザ結合テスト: npm.cmd run test:browser
- LLM分析のブラウザテスト: npm.cmd run test:analysis
- 修正に関係するテストを実行し、結果を報告する。

## 設計上の制約
- 求人情報の未取得項目を推測で補完しない。
- 抽出データと利用者による修正値を区別する。
- 根拠不足の場合は判定保留とする。
- 外部サイトへの無断通信を追加しない。
- 本番Manifestの権限追加は事前確認を必要とする。
- テスト用HTMLでの成功を実サイトでの検証済みと扱わない。

## 開発ルール
- 変更前に関連する既存実装と仕様書を確認する。
- 変更範囲を必要最小限にする。
- 仕様に影響する変更では関連ドキュメントも更新する。
- GitのpushやPR作成はユーザーの指示がある場合に行う。

## 参照文書
- docs/job-page-detection.md
- docs/local-llm-analysis.md
- docs/implementation-status.md
