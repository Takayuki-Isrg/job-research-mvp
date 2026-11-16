import { FIELD_LABELS } from './classify.js';

export const EVALUATION_STATUSES = ['一致', '不一致', '提示額次第', '要確認', '未調査'];
const fieldNames = Object.keys(FIELD_LABELS);
const priorities = { 除外: 0, ハード: 1, 職種: 2, 希望: 3, 注意: 4, 外部調査: 5 };
const CATEGORY_PREFIX = /^(除外|ハード|職種|希望|注意|外部調査)[：:]/;
// Rule triggers shared with ruleEvaluation so the preview warnings cannot drift from the actual rules.
const ANNUAL_MINIMUM = /年収[^\d]*(\d+(?:\.\d+)?)万円以上/;
const FIXED_OVERTIME_LIMIT = /固定残業[^。\n]*?(\d+)時間/;
const FIXED_OVERTIME_TRIGGER = /以上|不一致|除外/;
const OVERTIME = /残業/;

export function parseCriteria(preferences) {
  const { criteria, profile } = scanPreferences(preferences);
  if (criteria.length > 40) throw new Error('希望条件は40行以内に整理してください。1行を1つの比較条件として扱います。');
  return { criteria, profile: profile.join('\n') };
}

function scanPreferences(preferences) {
  let category = '希望';
  let profileMode = false;
  let headings = 0;
  const criteria = [],
    profile = [];
  for (const line of preferences
    .split(/\r?\n/)
    .map((text) => text.trim())
    .filter(Boolean)) {
    const heading = line
      .replace(/[【】#]/g, '')
      .replace(/[：:]$/, '')
      .trim();
    const section = [
      [/^除外条件$/, '除外'],
      [/^ハード条件$/, 'ハード'],
      [/^探す職種(?:（優先順位）)?$/, '職種'],
      [/^注意点(?:（.*）)?$/, '注意'],
      [/^評価・調査のルール$/, '外部調査'],
      [/^企業単位の指定$/, '除外'],
      [/^希望条件$/, '希望'],
    ].find(([pattern]) => pattern.test(heading));
    if (/^(?:あなたの)?プロフィール(?:として照合している内容)?$/.test(heading)) {
      profileMode = true;
      headings++;
      continue;
    }
    if (section) {
      category = section[1];
      profileMode = false;
      headings++;
      continue;
    }
    if (profileMode) {
      profile.push(line);
      continue;
    }
    const prefix = line.match(CATEGORY_PREFIX)?.[1];
    const kind = prefix || category;
    const external = kind === '外部調査' || /口コミ|報道|5ch|企業回答|従業員数/.test(line);
    criteria.push({
      id: `c${criteria.length + 1}`,
      text: line,
      category: kind,
      priority: external ? priorities.外部調査 : priorities[kind],
      external,
    });
  }
  return { criteria, profile, headings };
}

// Explains why no comparable criterion was found. Returns null when at least one criterion exists.
export function emptyCriteriaMessage(preferences) {
  const { criteria, profile, headings } = scanPreferences(String(preferences ?? ''));
  if (criteria.length) return null;
  if (profile.length)
    return 'プロフィール見出しより後の行は応募者情報として扱うため、比較する希望条件がありません。条件はプロフィール見出しより前か、「希望条件」等の見出しの下に1行ずつ入力してください。';
  if (headings)
    return '見出しの行だけで、比較する希望条件の行がありません。「希望条件：」のように見出しだけの行は条件として扱いません。見出しの下に条件を1行ずつ入力してください。';
  return '希望条件が入力されていません。比較する条件を1行に1条件で入力してください。';
}

const BULLET_PREFIX =
  /^(?:[・･•●○◦▪■□◆◇※*＊+＋\-－‐−–—]|[(（]?\d+[.)．）]|[①-⑳])\s*(除外|ハード|職種|希望|注意|外部調査)[：:]/;
// Commas between digits (4,500,000円) are not treated as separators.
const SEGMENT_SEPARATOR = /[、。;；/／]|(?<!\d)[,，]|[,，](?!\d)/;

function criterionRule(criterion) {
  if (criterion.external) return null;
  const text = criterion.text.normalize('NFKC');
  if (ANNUAL_MINIMUM.test(text)) return '給与（年収下限）';
  if (FIXED_OVERTIME_LIMIT.test(text) && FIXED_OVERTIME_TRIGGER.test(text)) return '固定残業';
  if (OVERTIME.test(text)) return '残業';
  return null;
}

// Advisory only: never splits, rewrites or reclassifies a line. The user decides whether to edit it.
export function criteriaWarnings(criteria) {
  return criteria.flatMap((criterion) => {
    const warnings = [];
    const add = (kind, message) => warnings.push({ criterionId: criterion.id, kind, message });
    const bullet = criterion.text.match(BULLET_PREFIX)?.[1];
    // No warning when the heading already gives the same category (e.g. "・除外：…" under 除外条件).
    if (bullet && bullet !== criterion.category)
      add(
        'bulletPrefix',
        `行頭の記号の後の「${bullet}：」は分類の接頭辞として認識されません。この行の分類と優先順位は「${criterion.category}」になります${bullet === '外部調査' && !criterion.external ? '。外部調査の対象としても扱われません' : ''}。条件文はそのまま判定に渡すため意図が読み取られる場合もありますが、分類を確実に「${bullet}」にするには記号を消し、「${bullet}：」から書き始めてください。`,
      );
    const segments = criterion.text
      .replace(CATEGORY_PREFIX, '')
      .split(SEGMENT_SEPARATOR)
      .filter((segment) => Array.from(segment.trim()).length >= 2);
    if (segments.length >= 2) {
      const rule = criterionRule(criterion);
      if (rule)
        add(
          'ruleWithMultiple',
          `この行には${rule}の照合ルールが適用される可能性があります。適用された場合、同じ行の他の内容は評価されません。他の内容も評価する場合は行を分けてください。`,
        );
      else
        add(
          'multiple',
          '複数の条件が含まれている可能性があります。この行は全体で1条件として評価します。別々に評価する場合は行を分けてください。',
        );
    }
    return warnings;
  });
}

export function analysisInput(values, preferences = '', record) {
  if (typeof preferences !== 'string' || preferences.length > 2000)
    throw new Error('希望条件は2,000文字以内で入力してください。');
  const fields = Object.fromEntries(fieldNames.map((key) => [key, String(values[key] ?? '')]));
  if (!fields.title || !fields.description)
    throw new Error('募集職種と仕事内容を確認・再判定してから分析してください。');
  if (Object.values(fields).join('').length + preferences.length > 6000)
    throw new Error('求人情報と希望条件は合計6,000文字以内にしてください。整理して再判定してください。');
  const provenance = Object.fromEntries(
    fieldNames.map((field) => {
      const original = record?.snapshot.fields[field];
      const modified = Object.hasOwn(record?.overrides || {}, field);
      const origin = record ? (modified ? '利用者修正' : '元ページ抽出') : '採用元未確認';
      if (record && fields[field] !== String(modified ? record.overrides[field] : (original?.value ?? '')))
        throw new Error('採用値と抽出値・修正値の対応を確認できません。再判定してください。');
      return [
        field,
        {
          origin,
          originalValue: original?.value ?? null,
          overrideValue: modified ? record.overrides[field] : null,
          adoptedValue: fields[field],
          source: original?.source ?? '未確認',
          extractionEvidence: original?.evidence ?? '',
        },
      ];
    }),
  );
  return {
    version: 2,
    recordId: record?.id ?? null,
    capturedAt: record?.snapshot.source.capturedAt ?? null,
    fields,
    preferences: preferences.trim(),
    provenance,
    ...parseCriteria(preferences.trim()),
  };
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key])]),
    );
  return value;
}
export const analysisSignature = (input) => JSON.stringify(canonical(input));

// Offsets count Unicode code points. Quotations always come from the saved adopted input.
export function evidenceSources(input) {
  return fieldNames.flatMap((field) => {
    const chars = Array.from(input.fields[field]);
    const sources = [];
    for (let start = 0; start < chars.length; start += 300) {
      const end = Math.min(start + 300, chars.length);
      sources.push({
        id: `${field}:${start / 300}`,
        field,
        start,
        end,
        evidence: chars.slice(start, end).join(''),
        origin: input.provenance[field].origin,
      });
    }
    return sources;
  });
}

export function verifyEvidence(source, input) {
  const expected = evidenceSources(input).find((item) => item.id === source?.id);
  if (
    !expected ||
    Object.keys(expected).some((key) => source[key] !== expected[key]) ||
    input.provenance[expected.field].adoptedValue !== input.fields[expected.field]
  )
    throw new Error('根拠IDまたは参照先が分析入力と一致しません。結果は採用できません。');
  return expected;
}

export function directInformation(input) {
  return fieldNames.map((field) => ({ field, value: input.fields[field], ...input.provenance[field] }));
}

export function ruleEvaluation(criterion, input) {
  const sources = evidenceSources(input);
  const make = (status, reason, selected = [], question = '') => ({
    status,
    reason,
    evidenceIds: selected.map((source) => source.id),
    question,
    method: 'ルール照合',
  });
  if (criterion.external)
    return make(
      '未調査',
      '必要な外部情報源への調査・照合は実施していません。',
      [],
      `外部情報源で確認：${criterion.text}`,
    );
  const text = criterion.text.normalize('NFKC');
  const excluding = criterion.category === '除外' || /除外|避けたい|希望しない/.test(text);
  if (excluding && /案件アサイン|客先常駐/.test(text)) {
    const phrase = '顧客先にて案件アサイン';
    const position = input.fields.description.indexOf(phrase);
    const start = Array.from(input.fields.description.slice(0, Math.max(position, 0))).length;
    const explicit =
      position < 0
        ? []
        : sources.filter(
            (source) =>
              source.field === 'description' && source.start < start + Array.from(phrase).length && source.end > start,
          );
    if (explicit.length)
      return make('不一致', '採用値に「顧客先にて案件アサイン」とあり、指定の除外条件に該当します。', explicit);
  }
  if (/納期/.test(text) && !/納期|締め切り|締切/.test(input.fields.description))
    return make(
      '要確認',
      '仕事内容の採用値を確認しましたが、納期の記載がなく判断できません。',
      [],
      '案件の納期と、短納期案件が業務の中心になるか確認してください。',
    );

  const salary = sources.filter((source) => source.field === 'salary');
  const annualMinimum = text.match(ANNUAL_MINIMUM);
  if (annualMinimum) {
    const raw = input.fields.salary.normalize('NFKC').replaceAll(',', '');
    const range =
      (raw.match(/年収/g) || []).length === 1
        ? raw.match(/年収\s*[:：]?\s*(\d+(?:\.\d+)?)万(?:円)?\s*[~〜～-]\s*(\d+(?:\.\d+)?)万円/)
        : null;
    if (!range)
      return make(
        '要確認',
        '給与の採用値から明示された年収範囲を確定できません。月給から年収は生成しません。',
        salary,
        '賞与を含む年収と提示額を確認してください。',
      );
    const [, low, high] = range.map(Number);
    if (low > high)
      return make('要確認', '年収範囲の上下限を確認してください。', salary, '年収範囲を確認してください。');
    const minimum = Number(annualMinimum[1]);
    const status = low >= minimum ? '一致' : high < minimum ? '不一致' : '提示額次第';
    return make(
      status,
      '給与の採用値に明記された年収範囲と希望下限を比較しました。月給換算や賞与の補完はしていません。',
      salary,
      status === '提示額次第' ? '実際の提示年収が希望下限を満たすか確認してください。' : '',
    );
  }
  const fixedLimit = text.match(FIXED_OVERTIME_LIMIT);
  if (fixedLimit && FIXED_OVERTIME_TRIGGER.test(text)) {
    const hours = input.fields.salary.normalize('NFKC').match(/固定残業(?:代|手当)?[^。\n\d]{0,30}(\d+)時間/);
    if (hours)
      return make(
        Number(hours[1]) >= Number(fixedLimit[1]) ? '不一致' : '一致',
        '給与の採用値に明記された固定残業時間と指定の基準を比較しました。',
        salary,
      );
    return make(
      '要確認',
      '固定残業時間を確定できません。記載がないことを「固定残業なし」とは扱いません。',
      salary,
      '固定残業代の有無と対象時間を確認してください。',
    );
  }
  if (OVERTIME.test(text)) {
    const related = sources.filter((source) => /残業/.test(source.evidence));
    return make(
      '要確認',
      '残業の採用値は下の根拠で確認してください。平均・上限・固定残業の区別を自動確定しません。',
      related,
      '月の平均残業と繁忙期の残業、記載時間の意味を確認してください。',
    );
  }
  return null;
}

export function evaluationSchema(input) {
  const item = {
    type: 'object',
    additionalProperties: false,
    required: ['criterionId', 'status', 'reason', 'evidenceIds', 'question'],
    properties: {
      criterionId: { type: 'string', enum: input.criteria.map((criterion) => criterion.id) },
      status: { type: 'string', enum: EVALUATION_STATUSES },
      reason: { type: 'string', maxLength: 180 },
      evidenceIds: {
        type: 'array',
        maxItems: 4,
        items: { type: 'string', enum: evidenceSources(input).map((source) => source.id) },
      },
      question: { type: 'string', maxLength: 120 },
    },
  };
  return {
    type: 'object',
    additionalProperties: false,
    required: ['evaluations'],
    properties: {
      evaluations: { type: 'array', minItems: input.criteria.length, maxItems: input.criteria.length, items: item },
    },
  };
}

export function validateAnalysis(data, input) {
  const sources = new Map(evidenceSources(input).map((source) => [source.id, source]));
  const expectedIds = new Set(input.criteria.map((criterion) => criterion.id));
  const received = Array.isArray(data?.evaluations) ? data.evaluations : [];
  const counts = new Map();
  const issues = [];
  const issue = (path, message) => issues.push({ path, message });
  if (!data || typeof data !== 'object' || Array.isArray(data))
    issue('$', '評価結果はオブジェクトである必要があります。');
  else if (Object.keys(data).some((key) => key !== 'evaluations')) issue('$', 'evaluations以外の項目があります。');
  if (!Array.isArray(data?.evaluations)) issue('evaluations', '配列ではありません。');
  else if (received.length !== input.criteria.length) issue('evaluations', '評価件数が一致しません。');
  received.forEach((row, index) => {
    const path = `evaluations[${index}]`;
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      issue(path, '評価行はオブジェクトである必要があります。');
      return;
    }
    if (typeof row.criterionId !== 'string') issue(`${path}.criterionId`, '条件IDは文字列で指定してください。');
    else counts.set(row.criterionId, (counts.get(row.criterionId) || 0) + 1);
    const label = typeof row.criterionId === 'string' ? `${path} (${row.criterionId})` : path;
    if (Object.keys(row).some((key) => !['criterionId', 'status', 'reason', 'evidenceIds', 'question'].includes(key)))
      issue(label, '許可されていない項目があります。');
    if (!EVALUATION_STATUSES.includes(row.status)) issue(`${label}.status`, '判定区分が不正です。');
    if (typeof row.reason !== 'string' || !row.reason.trim() || row.reason.length > 500)
      issue(`${label}.reason`, '理由は空でない500文字以内の文字列で指定してください。');
    if (typeof row.question !== 'string' || row.question.length > 300)
      issue(`${label}.question`, '質問は300文字以内の文字列で指定してください。');
    if (!Array.isArray(row.evidenceIds)) issue(`${label}.evidenceIds`, '根拠IDは配列で指定してください。');
    else {
      if (row.evidenceIds.length > 4) issue(`${label}.evidenceIds`, '根拠IDは4件以内で指定してください。');
      if (new Set(row.evidenceIds).size !== row.evidenceIds.length)
        issue(`${label}.evidenceIds`, '根拠IDが重複しています。');
      row.evidenceIds.forEach((id, evidenceIndex) => {
        if (!sources.has(id)) issue(`${label}.evidenceIds[${evidenceIndex}]`, '存在しない根拠IDです。');
      });
    }
  });
  const duplicateIds = [...counts].filter(([, count]) => count > 1).map(([id]) => id);
  const missingIds = [...expectedIds].filter((id) => !counts.has(id));
  const unknownIds = [...counts.keys()].filter((id) => !expectedIds.has(id));
  if (issues.length || duplicateIds.length || missingIds.length || unknownIds.length) {
    const details = {
      stage: 'validateAnalysis',
      expectedCount: input.criteria.length,
      receivedCount: Array.isArray(data?.evaluations) ? received.length : null,
      duplicateIds,
      missingIds,
      unknownIds,
      issues,
    };
    const error = new Error(
      [
        `条件別評価の検証に失敗しました。期待${details.expectedCount}件／受信${details.receivedCount ?? '配列なし'}件。`,
        duplicateIds.length ? `重複ID：${duplicateIds.join(', ')}。` : '',
        missingIds.length ? `欠落ID：${missingIds.join(', ')}。` : '',
        unknownIds.length ? `未知ID：${unknownIds.join(', ')}。` : '',
        ...issues.map((item) => `${item.path}：${item.message}`),
      ]
        .filter(Boolean)
        .join(' '),
    );
    error.name = 'AnalysisValidationError';
    error.details = details;
    throw error;
  }
  const rows = new Map();
  for (const row of received) {
    for (const id of row.evidenceIds) {
      if (!sources.has(id)) throw new Error('存在しない根拠IDです。結果は採用できません。');
      verifyEvidence(sources.get(id), input);
    }
    rows.set(row.criterionId, row);
  }
  const evaluations = input.criteria.map((criterion) => {
    const row = rows.get(criterion.id);
    const rule = ruleEvaluation(criterion, input);
    let chosen = rule || { ...row, method: 'LLM評価' };
    let correction = null;
    // Only per-row status problems are corrected. ID/shape errors were rejected above.
    // External criteria always take the rule path, so an LLM "未調査" here is for a non-external criterion.
    if (!rule) {
      const reasons = [];
      if (row.status === '未調査') reasons.push('外部調査の対象でない条件に「未調査」が返されました。');
      if (row.status === '提示額次第' && !/年収|給与|月給|報酬/.test(criterion.text))
        reasons.push('給与条件以外に「提示額次第」が返されました。');
      const invalidStatus = reasons.length > 0;
      if (['一致', '不一致', '提示額次第'].includes(row.status) && !row.evidenceIds.length)
        reasons.push('確定判定に根拠IDがありません。');
      if (reasons.length) {
        correction = {
          originalStatus: row.status,
          originalReason: row.reason.trim(),
          originalQuestion: row.question.trim(),
          reasons,
        };
        chosen = invalidStatus
          ? {
              status: '要確認',
              method: '判定区分補正',
              evidenceIds: row.evidenceIds,
              reason: `LLMの判定「${row.status}」はこの条件には使用できないため、確定せず要確認にしました。`,
              question: `採用情報と照合して確認してください：${criterion.text}`,
            }
          : {
              status: '要確認',
              method: '根拠不足補正',
              evidenceIds: [],
              reason: 'LLMが確定判定を返しましたが、根拠IDがないため確定せず要確認にしました。',
              question: `採用情報と照合して確認してください：${criterion.text}`,
            };
      }
    }
    const question =
      chosen.question.trim() ||
      (chosen.status === '要確認' ? `根拠が不足しています。確認してください：${criterion.text}` : '');
    return {
      criterion,
      status: chosen.status,
      reason: chosen.reason.trim(),
      method: chosen.method,
      correction,
      question,
      evidence: chosen.evidenceIds.map((id) => verifyEvidence(sources.get(id), input)),
    };
  });
  const questions = evaluations
    .filter((row) => row.question)
    .sort((a, b) => a.criterion.priority - b.criterion.priority)
    .map((row) => ({
      criterionId: row.criterion.id,
      priority: row.criterion.external ? '外部調査' : row.criterion.category,
      status: row.status,
      text: row.question,
    }));
  return { evaluations, questions };
}
