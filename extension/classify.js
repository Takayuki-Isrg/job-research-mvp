export const FIELD_LABELS = Object.freeze({
  company: '企業名（雇用主）',
  title: '募集職種',
  description: '仕事内容',
  qualifications: '応募資格',
  location: '勤務地',
  salary: '給与',
  employmentType: '雇用形態',
});

export function effectiveFields(snapshot, overrides = {}) {
  return Object.fromEntries(
    Object.keys(FIELD_LABELS).map((key) => [
      key,
      Object.hasOwn(overrides, key) ? overrides[key].trim() : (snapshot.fields[key]?.value ?? ''),
    ]),
  );
}

export function classify(snapshot, overrides = {}) {
  const values = effectiveFields(snapshot, overrides);
  const has = (key) => Boolean(values[key]);
  const signals = snapshot.signals;
  const reasons = [...snapshot.warnings];
  const conditions = ['qualifications', 'location', 'salary', 'employmentType'].filter(has);
  const core = has('title') && has('description');

  const conflictKeys = { 企業名: 'company', 募集職種: 'title' };
  const remainingConflicts = signals.conflicts.filter((label) => !Object.hasOwn(overrides, conflictKeys[label] ?? ''));
  if (signals.conflicts.length && remainingConflicts.length < signals.conflicts.length)
    reasons.push('相違のあった項目に利用者の修正値を使用しています。外部確認済みの情報ではありません。');
  let status;

  // 表示中のページが求人票かどうかを判別
  if (signals.isList) {
    status = '対象外';
    reasons.push('求人一覧・検索結果のため、調査対象の個別求人を特定できません。');
  } else if (signals.ambiguousStructured) {
    status = '判定保留';
    reasons.push('複数のJobPostingがあり、表示中の主な求人を一意に特定できません。');
  } else if (remainingConflicts.length) {
    status = '判定保留';
    reasons.push(`構造化データと表示内容に相違があります：${remainingConflicts.join('、')}。`);
  } else if (core && (signals.structuredMatched || conditions.length || signals.hasApply)) {
    status = '求人票';
    reasons.push(
      signals.structuredMatched
        ? '表示中の職種・仕事内容と対応する個別のJobPostingを確認しました。'
        : '個別の募集職種・仕事内容と、募集条件または応募導線を確認しました。',
    );
  } else if (has('description') || has('qualifications') || signals.recruitmentHint || signals.structuredCount) {
    status = '判定保留';
    reasons.push('求人の可能性がありますが、個別の職種・仕事内容・募集条件の根拠が不足しています。');
  } else {
    status = '対象外';
    reasons.push('個別求人の募集職種と仕事内容を確認できません。');
  }

  const companyKnown = has('company') && !/非公開|不明|未公開|匿名|紹介会社|エージェント|人材紹介/.test(values.company);
  const companyState = companyKnown ? '名称あり（法人の同一性は未確認）' : '未特定';
  const researchState =
    status === '対象外'
      ? '対象外：企業調査・登録は開始できません。'
      : status === '判定保留'
        ? '企業調査は保留：抽出結果を確認・修正してください。'
        : !companyKnown
          ? '企業調査は保留：企業名を確認してください。'
          : '求人情報の確認まで完了しました。このMVPでは企業調査・登録を実行しません。';

  const missing = Object.keys(FIELD_LABELS).filter((key) => !has(key));
  const required = [];
  if (!has('title')) required.push('募集職種');
  if (!has('description')) required.push('仕事内容');
  if (!conditions.length && !signals.hasApply && !signals.structuredMatched) required.push('募集条件または応募導線');
  if (!companyKnown) required.push('雇用主の企業名');

  return { status, reasons, missing, required, companyState, researchState, values, externalActionsAllowed: false };
}

export function sanitizeOverrides(snapshot, input) {
  const result = {};

  for (const key of Object.keys(FIELD_LABELS)) {
    if (!Object.hasOwn(input ?? {}, key)) continue;
    if (typeof input[key] !== 'string' || input[key].length > 6000)
      throw new Error('修正値は各項目6,000文字以内で入力してください。');

    const value = input[key].trim();
    if (value !== (snapshot.fields[key]?.value ?? '')) result[key] = value;
  }

  return result;
}
