// Self-contained: Chrome serializes this function into the source tab's isolated world.
export function extractPage() {
  const limit = 6000;
  const clean = (text) =>
    String(text ?? '')
      .replace(/\u00a0/g, ' ')
      .replace(/[ \t]+/g, ' ')
      .replace(/\n\s*\n/g, '\n')
      .trim();
  const compact = (text) =>
    clean(text)
      .toLowerCase()
      .replace(/[\s\p{P}\p{S}]/gu, '');
  const visibility = new WeakMap();

  function visible(el) {
    if (!el || el.nodeType !== 1) return true;
    if (visibility.has(el)) return visibility.get(el);
    const css = getComputedStyle(el);
    const result =
      !el.hidden &&
      el.getAttribute('aria-hidden') !== 'true' &&
      css.display !== 'none' &&
      css.visibility !== 'hidden' &&
      css.visibility !== 'collapse' &&
      visible(el.parentElement);
    visibility.set(el, result);
    return result;
  }

  function textOf(el) {
    return textExcept(el);
  }

  function textExcept(el, excluded = new Set()) {
    if (!el || !visible(el)) return '';
    const walk = (node) => {
      if (node.nodeType === 3) return node.textContent;
      if (
        node.nodeType !== 1 ||
        excluded.has(node) ||
        !visible(node) ||
        /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE|NAV|ASIDE|FOOTER|HEADER|INPUT|TEXTAREA|SELECT)$/.test(node.tagName)
      )
        return '';
      const text = Array.from(node.childNodes, walk).join('');
      return /^(DIV|P|SECTION|ARTICLE|MAIN|H[1-6]|DT|DD|TR|LI|BR)$/.test(node.tagName) ? `\n${text}\n` : text;
    };
    return clean(walk(el)).slice(0, 100000);
  }

  function plain(value) {
    if (Array.isArray(value)) return clean(value.map(plain).filter(Boolean).join(' / '));
    if (typeof value === 'number') return String(value);
    if (typeof value !== 'string') return '';

    // Template contents stay inert: do not load images/frames while decoding markup.
    const template = document.createElement('template');
    template.innerHTML = value;
    template.content.querySelectorAll('script,style,iframe,object').forEach((el) => el.remove());
    return clean(template.content.textContent).slice(0, limit);
  }

  const root = [...document.querySelectorAll('main,[role="main"],article')].find(visible) || document.body;
  if (!root || /pdf/i.test(document.contentType))
    throw new Error('HTMLの求人本文を取得できません。PDF・別フレーム内の本文は初回MVPの対象外です。');

  // Keep site rules inside the injected function so they also work in Chrome's isolated world.
  const siteAdapters = [
    {
      hostname: 'mypage.r-agent.com',
      detailPath: /^\/joboffers\/\d+\/?$/,
      companyClassPrefix: 'JobInformation_corpName__',
      titleClassPrefix: 'JobInformation_title__',
      sectionFields: [
        {
          key: 'qualifications',
          tag: 'h3',
          label: '求める能力・経験',
          headingPrefix: 'MidSection_categoryTitle__',
          contentPrefix: 'MidSection_categoryDesc__',
        },
        {
          key: 'location',
          tag: 'h2',
          label: '勤務地',
          headingPrefix: 'MainSection_title__',
          contentPrefix: 'MainSection_contents__',
        },
      ],
    },
  ];
  const siteAdapter =
    location.protocol === 'https:'
      ? siteAdapters.find(
          (adapter) => adapter.hostname === location.hostname && adapter.detailPath.test(location.pathname),
        )
      : null;
  const siteWarnings = [];

  function siteElement(tag, classPrefix, label) {
    const unique = new Map();
    for (const element of root.querySelectorAll(tag)) {
      if (!visible(element) || element.closest('nav,aside,footer')) continue;
      const className = [...element.classList].find((name) => name.startsWith(classPrefix));
      if (!className) continue;
      const value = textOf(element);
      if (value) unique.set(compact(value), { value, evidence: `RA個別求人: ${tag}.${className}\n${value}` });
    }
    if (unique.size > 1) siteWarnings.push(`RAの${label}候補が複数あり、一意に特定できません。`);
    return unique.size === 1 ? [...unique.values()][0] : null;
  }

  const siteTitle = siteAdapter ? siteElement('h1', siteAdapter.titleClassPrefix, '募集職種') : null;
  const siteCompany = siteTitle ? siteElement('p', siteAdapter.companyClassPrefix, '企業名') : null;
  const visibleText = textOf(root);
  const visibleCompact = compact(visibleText);
  const headings = [...root.querySelectorAll('h1')].filter(visible).map(textOf).filter(Boolean);
  const primaryHeading = siteTitle?.value || headings[0] || '';
  const headingCompact = compact(primaryHeading);

  const labels = {
    company: /^(企業名|会社名|雇用主|採用企業|募集企業|勤務先企業|hiring organization|employer)$/i,
    title: /^(募集職種|職種|募集ポジション|募集職名|job title|position)$/i,
    description: /^(仕事内容|業務内容|職務内容|担当業務|募集内容|job description|responsibilities)$/i,
    qualifications:
      /^(応募資格|応募条件|必須条件|必須スキル|歓迎条件|求める人材|対象となる方|requirements|qualifications)$/i,
    location: /^(勤務地|勤務場所|就業場所|location)$/i,
    salary: /^(給与|年収|月給|賃金|給与・待遇|給与待遇|salary|compensation)$/i,
    employmentType: /^(雇用形態|採用形態|employment type)$/i,
  };
  const fields = Object.fromEntries(
    Object.keys(labels).map((key) => [key, { value: null, source: null, evidence: null }]),
  );
  const labelKey = (text) =>
    Object.keys(labels).find((key) =>
      labels[key].test(
        clean(text)
          .replace(/[：:]$/, '')
          .trim(),
      ),
    );

  function put(key, value, source, evidence) {
    const normalized = clean(value).slice(0, limit);
    if (normalized && !fields[key].value)
      fields[key] = { value: normalized, source, evidence: clean(evidence).slice(0, 400) };
  }

  if (siteTitle) put('title', siteTitle.value, '本文', siteTitle.evidence);
  if (siteCompany) put('company', siteCompany.value, '本文', siteCompany.evidence);

  const siteOwnedFields = new Set();
  const hasClassPrefix = (element, prefix) => [...element.classList].some((name) => name.startsWith(prefix));
  const ownsHeading = (section, heading) =>
    Boolean(heading.id) && (section.getAttribute('aria-labelledby') || '').split(/\s+/).includes(heading.id);

  function locationText(content) {
    const excluded = new Set();
    for (const section of content.querySelectorAll('section[aria-labelledby]')) {
      const heading = [...section.children].find((element) => element.matches('h3') && ownsHeading(section, element));
      if (heading && /^(配属先|転勤)$/.test(textOf(heading))) excluded.add(section);
    }
    return textExcept(content, excluded);
  }

  for (const rule of siteAdapter?.sectionFields || []) {
    const values = new Map();
    const headings = [...root.querySelectorAll(rule.tag)].filter(
      (heading) =>
        visible(heading) &&
        !heading.closest('nav,aside,footer') &&
        hasClassPrefix(heading, rule.headingPrefix) &&
        textOf(heading) === rule.label,
    );
    if (!headings.length) continue;
    siteOwnedFields.add(rule.key);

    for (const heading of headings) {
      const section = heading.closest('section');
      if (!section || !ownsHeading(section, heading)) continue;
      const contents = [...section.children].filter(
        (element) => visible(element) && hasClassPrefix(element, rule.contentPrefix),
      );
      const value = clean(
        contents.map((content) => (rule.key === 'location' ? locationText(content) : textOf(content))).join('\n'),
      );
      if (value) values.set(compact(value), value);
    }

    if (values.size === 1) {
      const value = [...values.values()][0];
      put(rule.key, value, '本文', `RA個別求人: ${rule.label} / section[aria-labelledby]\n${value}`);
    } else {
      siteWarnings.push(
        values.size > 1
          ? `RAの${rule.label}の本文候補が複数あり、一意に特定できません。`
          : `RAの${rule.label}に対応する本文を確認できません。項目の区切りを確認してください。`,
      );
    }
  }

  for (const el of root.querySelectorAll('dt,th,h2,h3,h4,p,li')) {
    if (!visible(el) || el.closest('nav,aside,footer,header')) continue;
    const line = textOf(el);
    const colon = line.match(/^([^\n：:]{1,35})[：:]\s*([\s\S]+)$/);
    if (colon) {
      const key = labelKey(colon[1]);
      if (key && !siteOwnedFields.has(key)) put(key, colon[2], '本文', line);
    }

    const key = labelKey(line);
    if (!key || siteOwnedFields.has(key)) continue;

    const chunks = [];
    let next = el.nextElementSibling;
    if (el.tagName === 'TH') next = el.parentElement.querySelector('td');
    while (next) {
      if (/^(H[1-6]|DT|TH)$/.test(next.tagName) || labelKey(textOf(next))) break;
      if (el.tagName === 'DT' && next.tagName !== 'DD') break;
      const text = textOf(next);
      if (text) chunks.push(text);
      if (/^(DT|TH)$/.test(el.tagName)) break;
      next = next.nextElementSibling;
    }
    put(key, chunks.join('\n'), '本文', `${line}\n${chunks.join('\n')}`);
  }

  // Common div/span label layouts, but never infer a company from the site's branding.
  for (const el of root.querySelectorAll('div,span')) {
    if (!visible(el) || el.children.length || el.closest('nav,aside,footer,header')) continue;
    const line = textOf(el);
    const key = labelKey(line);
    if (key && !siteOwnedFields.has(key) && el.nextElementSibling)
      put(key, textOf(el.nextElementSibling), '本文', `${line}: ${textOf(el.nextElementSibling)}`);
  }

  const warnings = [...siteWarnings];
  const candidates = [];
  const seen = new Set();
  let nodes = 0;

  function visit(value, path, depth = 0) {
    if (!value || typeof value !== 'object' || depth > 25 || ++nodes > 10000) return;
    if (Array.isArray(value)) {
      value.forEach((v, i) => visit(v, `${path}[${i}]`, depth + 1));
      return;
    }
    const types = Array.isArray(value['@type']) ? value['@type'] : [value['@type']];
    if (types.some((type) => typeof type === 'string' && /(^|[/#])JobPosting$/.test(type))) {
      const signature = JSON.stringify([value.title, value.hiringOrganization, value.description]);
      if (!seen.has(signature)) {
        candidates.push({ job: value, path });
        seen.add(signature);
      }
    }
    for (const [key, child] of Object.entries(value)) visit(child, `${path}.${key}`, depth + 1);
  }

  [...document.querySelectorAll('script[type="application/ld+json"]')].forEach((script, i) => {
    if (script.textContent.length > 1000000) {
      warnings.push('大きすぎるJSON-LDを読み飛ばしました。');
      return;
    }
    try {
      visit(JSON.parse(script.textContent), `JSON-LD[${i}]`);
    } catch {
      warnings.push('JSON-LDの構文が不正のため、表示本文でも判定しました。');
    }
  });

  const titleMatches = (title) => {
    const t = compact(title);
    return t.length >= 3 && headingCompact.length >= 3 && (headingCompact.includes(t) || t.includes(headingCompact));
  };
  const descriptionMatches = (description) => {
    const d = compact(plain(description));
    return d.length >= 8 && visibleCompact.includes(d.slice(0, Math.min(d.length, 35)));
  };
  const matched = candidates.filter(({ job }) => titleMatches(job.title) && descriptionMatches(job.description));
  const selected = matched.length === 1 ? matched[0] : null;
  const conflicts = [];

  function address(location) {
    if (Array.isArray(location)) return location.map(address).filter(Boolean).join(' / ');
    if (typeof location === 'string') return plain(location);
    const a = location?.address;
    if (typeof a === 'string') return plain(a);
    return a && typeof a === 'object'
      ? ['addressCountry', 'addressRegion', 'addressLocality', 'streetAddress', 'postalCode']
          .map((k) => plain(typeof a[k] === 'object' ? a[k]?.name : a[k]))
          .filter(Boolean)
          .join(' ')
      : '';
  }

  function salary(value) {
    if (!value) return '';
    if (typeof value !== 'object') return plain(value);
    const v = value.value ?? value;
    return [
      plain(value.currency),
      plain(typeof v === 'object' ? (v.value ?? '') : v),
      v.minValue != null || v.maxValue != null ? `${plain(v.minValue)}〜${plain(v.maxValue)}` : '',
      plain(v.unitText),
    ]
      .filter(Boolean)
      .join(' ');
  }

  if (selected) {
    const { job, path } = selected;
    const organization =
      typeof job.hiringOrganization === 'object' && !Array.isArray(job.hiringOrganization)
        ? plain(job.hiringOrganization?.name)
        : '';
    const data = {
      title: plain(job.title),
      description: plain(job.description),
      company: organization,
      qualifications: plain(job.qualifications),
      location: address(job.jobLocation),
      salary: salary(job.baseSalary),
      employmentType: plain(job.employmentType),
    };
    const paths = {
      title: 'title',
      description: 'description',
      company: 'hiringOrganization.name',
      qualifications: 'qualifications',
      location: 'jobLocation',
      salary: 'baseSalary',
      employmentType: 'employmentType',
    };

    if (fields.company.value && organization && compact(fields.company.value) !== compact(organization))
      conflicts.push('企業名');
    if (fields.title.value && !titleMatches(fields.title.value)) conflicts.push('募集職種');

    for (const [key, value] of Object.entries(data)) {
      // Explicit visible labels keep the original wording; structured data fills gaps.
      put(key, value, '構造化データ', `${path}.${paths[key]}`);
    }
  }

  const cardCount = root.querySelectorAll(
    '[data-job-card],.job-card,.jobCard,.layoutList01,[itemtype$="/JobPosting"]',
  ).length;
  const listHeading = /求人一覧|求人検索|検索結果|募集一覧|募集職種一覧|job search|search results|job listings/i.test(
    primaryHeading,
  );
  const isList = listHeading || (cardCount >= 2 && !selected);

  const hasApply = [...root.querySelectorAll('a,button,input[type="submit"]')].some(
    (el) =>
      visible(el) &&
      !el.closest('nav,aside,footer,header') &&
      /^(応募する|応募へ進む|この求人に応募|応募画面へ|エントリー|apply(?: now)?)(?:[\s（(]|$)/i.test(
        clean(el.value || el.textContent),
      ),
  );
  const recruitmentHint =
    Boolean(siteTitle) || /募集要項|採用情報|求人詳細|募集職種|仕事内容|応募資格|job description/i.test(visibleText);

  if (!fields.title.value && primaryHeading && (fields.description.value || recruitmentHint))
    put('title', primaryHeading, '本文', `h1: ${primaryHeading}`);
  if (candidates.length && !selected)
    warnings.push('JobPostingはありますが、表示中の主な職種・仕事内容との対応を確定していません。');

  return {
    schemaVersion: 1,
    source: { url: location.href, title: document.title, capturedAt: new Date().toISOString() },
    fields,
    signals: {
      isList,
      cardCount,
      hasApply,
      recruitmentHint,
      structuredCount: candidates.length,
      structuredMatched: Boolean(selected),
      ambiguousStructured: candidates.length > 1 && !selected,
      conflicts,
      primaryHeading: primaryHeading.slice(0, 400),
    },
    warnings: [...new Set(warnings)],
  };
}
