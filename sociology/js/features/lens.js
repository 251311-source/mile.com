// 국제정치 3. 이론 렌즈 분석: 한 사건을 여러 이론의 관점에서 해석하고 이론별 피드백과 비교표를 받는다.
import { h, add, pageHead, loadingBox, errorBox, sourceChips, setCurrent, toast } from '../ui.js';
import { askJSON, T, SOURCES, seenInSearch } from '../ai.js';
import { S, uid, pushRecent, recordAttempt, addWrong } from '../store.js';
import { openChatAbout } from '../panels.js';
import { persistentArea, runJob, jobControls, isCancel } from '../jobs.js';
import { verifyItems } from '../verify.js';
import { reportButton } from '../report.js';

const EVENT = T.obj({
  title: T.str, when: T.str, situation: T.str, in_material: T.bool, sources: SOURCES,
  url: T.str, publisher: T.str,
  theories: T.arr(T.obj({ name: T.str, core: T.str, key_concepts: T.arr(T.str), sources: SOURCES })),
});
const FEEDBACK = T.obj({
  results: T.arr(T.obj({
    theory: T.str, score: T.num, fits_assumptions: T.bool, assumptions_comment: T.str,
    concepts_used_well: T.arr(T.str), concepts_misused: T.arr(T.obj({ concept: T.str, why: T.str })), concepts_missed: T.arr(T.str),
    model_answer: T.str, sources: SOURCES,
  })),
  summary: T.arr(T.obj({ theory: T.str, focus: T.str, explanation: T.str, outlook: T.str })),
  overall: T.str,
});

const opts = { outside: false };

export function render(root) {
  const area = persistentArea('lens'); // 화면을 떠나도 생성·작성 중인 내용이 유지된다
  if (!area.childNodes.length) area.appendChild(h('p', { class: 'muted empty' }, '아래 [사례 생성]을 누르면 학습 범위에서 국제 사건·상황을 하나 고릅니다.'));
  const outside = h('input', { type: 'checkbox', checked: opts.outside, onchange: (e) => { opts.outside = e.target.checked; } });
  add(root,
    pageHead('이론 렌즈 분석', '하나의 국제 사건·상황을 여러 이론의 관점에서 해석해 보세요. 이론별로 핵심 가정에 맞는지, 개념을 바르게 썼는지 피드백하고, 마지막에 이론별 설명을 비교표로 보여 줍니다.'),
    area,
    h('div', { class: 'row wrap end' },
      h('label', { class: 'check', title: '교과서 밖의 잘 알려진 역사적·최근 국제 사건을 웹에서 찾아 출처와 함께 보여 줍니다. 적용하는 이론은 학습 범위 안에서만 고릅니다.' }, outside, h('span', null, '교과서 밖 사례')),
      jobControls('lens', { start: () => run(), label: '사례 생성', running: '사례를 고르는 중… 다른 화면에 다녀와도 계속 만들어요.' })));

  function run() {
    runJob('lens', { label: '이론 렌즈 분석 사례', page: 'lens' }, async (signal) => {
      const prev = [...area.childNodes];
      area.replaceChildren(loadingBox(opts.outside ? '교과서 밖 사례를 검색하고 있습니다…' : '자료에서 사례를 고르고 있습니다…'));
      try {
        const ev = await findEvent(opts.outside, signal);
        area.replaceChildren(eventView(ev, run));
      } catch (e) {
        if (isCancel(e)) area.replaceChildren(...prev);
        else area.replaceChildren(errorBox(e, run));
        throw e;
      }
    });
  }
}

async function findEvent(outside, signal) {
  const recent = S().recent.lens || [];
  for (let attempt = 0; attempt < 2; attempt++) {
    const task = [
      outside
        ? '웹 검색으로 학습 자료 밖의 잘 알려진 국제 사건이나 상황(역사적 사건 또는 최근 국제 뉴스) 하나를 찾아라. in_material은 false. url에 실제로 확인한 출처 URL, publisher에 출처 기관·언론사를 적는다. 사건 서술은 검색 결과에 근거한다.'
        : '학습 범위 자료에 나오는 국제 사건·상황·사례 하나를 골라라. in_material은 true. sources에 그 사건이 나오는 위치를 적는다. url과 publisher는 빈 문자열.',
      '- title: 사건 이름, when: 시기(모르면 빈 문자열), situation: 사건을 4~6문장으로 중립적으로 서술(어느 이론으로 해석해야 하는지 말하지 않는다).',
      '- theories: 이 사건을 해석하는 데 쓸 수 있는 학습 범위 자료 속 이론·학파 2~5개. 반드시 자료에 나오는 이론만 쓴다. core: 자료에 근거한 그 이론의 핵심 가정 2~3문장, key_concepts: 그 이론의 핵심 개념(자료 표기), sources: 이론 설명 위치.',
      recent.length && `- 다음 사건과는 다른 것을 고른다: ${recent.join(' / ')}`,
    ].filter(Boolean).join('\n');
    const { data, searchResults = [] } = await askJSON({ task, schema: EVENT, web: outside, signal });
    const theories = (data.theories || []).filter((t) => t.name);
    if (!data.title || !data.situation || theories.length < 2) continue;
    const ev = { ...data, theories, id: uid(), in_material: !outside, sources: outside ? [] : data.sources || [] };
    const [v] = await verifyItems('lens', [{ title: ev.title, when: ev.when, situation: ev.situation, in_material: ev.in_material, sources: ev.sources, theories: ev.theories }], { signal });
    if (!v.pass) continue;
    ev.webVerified = outside && /^https?:\/\//.test(ev.url) && seenInSearch(ev.url, searchResults);
    pushRecent('lens', ev.title.slice(0, 40), 12);
    return ev;
  }
  throw new Error('검증을 통과한 사례를 만들지 못했습니다. 다시 시도해 주세요.');
}

function eventView(ev, again) {
  const ctx = { kind: 'lens', label: '이론 렌즈 분석', text: `[이론 렌즈 분석] ${ev.title} (${ev.when})\n${ev.situation}\n적용 가능한 이론: ${ev.theories.map((t) => t.name).join(', ')}` };
  setCurrent(ctx);
  const picked = new Set();
  const answers = new Map(ev.theories.map((t) => [t.name, h('textarea', { class: 'input', rows: 5, placeholder: `${t.name}의 관점에서 이 사건을 해석해 보세요. (핵심 가정과 개념을 활용)` })]));
  const writeBox = h('div', { class: 'lens-write' });
  const drawWrite = () => writeBox.replaceChildren(...ev.theories.filter((t) => picked.has(t.name)).map((t) =>
    h('label', { class: 'field' }, h('span', { class: 'field-label' }, `${t.name} 관점의 해석`), answers.get(t.name))));
  const chips = h('div', { class: 'chip-row' }, ev.theories.map((t) => h('button', {
    type: 'button', class: 'chip toggle', 'aria-pressed': 'false',
    onclick: (e) => {
      picked.has(t.name) ? picked.delete(t.name) : picked.add(t.name);
      e.currentTarget.classList.toggle('on', picked.has(t.name));
      e.currentTarget.setAttribute('aria-pressed', String(picked.has(t.name)));
      drawWrite();
    },
  }, t.name)));
  const submit = h('button', { class: 'btn primary', onclick: () => send() }, '피드백 받기');
  const result = h('div', { 'aria-live': 'polite' });

  async function send() {
    const list = ev.theories.filter((t) => picked.has(t.name));
    if (!list.length) return toast('적용할 이론을 하나 이상 고르세요.', 'warn');
    const empty = list.find((t) => answers.get(t.name).value.trim().length < 15);
    if (empty) return toast(`${empty.name} 관점의 해석을 조금 더 써 주세요.`, 'warn');
    submit.disabled = true;
    result.replaceChildren(loadingBox('이론별로 해석을 검토하고 있습니다…'));
    try {
      const { data: f } = await askJSON({ schema: FEEDBACK, task: [
        '학습자가 하나의 국제 사건을 여러 이론의 관점에서 해석했다. 이론마다 피드백하라. 평가 기준은 학습 자료에 나온 각 이론의 내용이다.',
        '- results: 학습자가 쓴 이론마다 하나씩(theory는 아래 이름 그대로). score 0~100. fits_assumptions: 해석이 그 이론의 핵심 가정에 맞는지. assumptions_comment: 그 판단의 이유 2~3문장.',
        '- concepts_used_well: 바르게 쓴 핵심 개념. concepts_misused: 잘못 쓴 개념과 이유. concepts_missed: 썼으면 좋았을 중요한 개념(자료 표기).',
        '- model_answer: 그 이론 관점의 모범 해석(4~6문장, 자료에 근거). sources: 근거 위치.',
        '- summary: 아래 모든 이론(학습자가 고르지 않은 것 포함)이 같은 사건을 어떻게 다르게 설명하는지. focus: 주목하는 요인, explanation: 사건 설명 1~2문장, outlook: 협력·갈등에 대한 전망 한 문장.',
        '- overall: 전체 조언 2~3문장.',
        JSON.stringify({ event: { title: ev.title, when: ev.when, situation: ev.situation }, theories: ev.theories.map((t) => ({ name: t.name, core: t.core, key_concepts: t.key_concepts })), answers: list.map((t) => ({ theory: t.name, text: answers.get(t.name).value.trim() })) }),
      ].join('\n') });
      const byName = new Map((f.results || []).map((r) => [r.theory, r]));
      const rows = list.map((t) => ({ t, r: byName.get(t.name) || { score: 0, assumptions_comment: '피드백을 받지 못했습니다.' } }));
      for (const { t, r } of rows) {
        const score = Math.max(0, Math.min(100, Number(r.score) || 0));
        r.score = score;
        const ok = score >= 60;
        const q = lensQ(ev, t, r);
        recordAttempt({ qid: q.id, feature: 'lens', type: 'lens', concepts: [t.name, ...(r.concepts_missed || [])].slice(0, 5), sociologists: [], correct: ok, score: score / 100 });
        if (!ok) addWrong({ feature: 'lens', q, userAnswer: answers.get(t.name).value.trim(), feedback: r.assumptions_comment });
      }
      answers.forEach((ta) => { ta.readOnly = true; });
      chips.querySelectorAll('button').forEach((b) => { b.disabled = true; });
      submit.remove();
      ctx.text += '\n' + rows.map(({ t, r }) => `[${t.name}] 학습자 해석: ${answers.get(t.name).value.trim()} / 피드백: ${r.assumptions_comment}`).join('\n');
      result.replaceChildren();
      add(result,
        ...rows.map(({ t, r }) => feedbackCard(t, r)),
        summaryTable(ev, f.summary || [], picked),
        f.overall && h('div', { class: 'card feedback' }, h('b', null, '전체 조언 '), f.overall),
        h('div', { class: 'row' },
          h('button', { class: 'btn ghost', onclick: () => openChatAbout(ctx, '이 사건의 이론별 해석에 대해 ') }, '💬 AI에게 질문'),
          reportButton(lensQ(ev, rows[0].t, rows[0].r), { feature: 'lens' }),
          h('button', { class: 'btn primary', onclick: again }, '다른 사례')));
    } catch (e) {
      result.replaceChildren(errorBox(e));
      submit.disabled = false;
    }
  }

  return h('div', null,
    h('article', { class: 'card news' },
      h('div', { class: 'qmeta' },
        h('span', { class: 'tag' }, ev.in_material ? '교과서 사례' : '교과서 밖 사례'),
        !ev.in_material && h('span', { class: 'tag ' + (ev.webVerified ? 'label-verified' : 'label-unverified') }, ev.webVerified ? '웹 출처(검색 결과로 확인)' : '웹 출처(확인 안 됨)')),
      h('h2', null, ev.title + (ev.when ? ` (${ev.when})` : '')),
      h('p', { class: 'reading' }, ev.situation),
      ev.in_material ? sourceChips(ev.sources) : h('p', { class: 'cite' }, '출처: ', ev.publisher || '', ' ',
        /^https?:\/\//.test(ev.url) ? h('a', { href: ev.url, target: '_blank', rel: 'noopener noreferrer' }, ev.url) : '(링크 없음)')),
    h('div', { class: 'card' },
      h('p', { class: 'qstem' }, '어떤 이론으로 해석할까요? (학습 범위의 이론, 여러 개 선택 가능)'),
      chips, writeBox, h('div', { class: 'row end' }, submit)),
    result);
}

function lensQ(ev, t, r) {
  return {
    id: `lens_${ev.id}_${t.name}`.replace(/\s/g, ''), type: 'essay',
    stem: `다음 상황을 ${t.name}의 관점에서 해석하시오.`,
    context: `${ev.title}${ev.when ? ` (${ev.when})` : ''}: ${ev.situation}`,
    options: [], accept: [],
    rubric: [
      { criterion: `${t.name}의 핵심 가정에 맞는 해석`, points: 4, key_elements: [t.core].filter(Boolean) },
      { criterion: '핵심 개념의 정확한 사용', points: 4, key_elements: (t.key_concepts || []).slice(0, 5) },
      { criterion: '사건의 구체적 내용과의 연결', points: 2, key_elements: [] },
    ],
    model_answer: r.model_answer || t.core, explanation: r.assumptions_comment || '', sources: r.sources?.length ? r.sources : t.sources || [],
    concepts: [t.name, ...(t.key_concepts || [])].slice(0, 4), sociologists: [],
  };
}

function feedbackCard(t, r) {
  const ok = r.score >= 60;
  return h('div', { class: 'result ' + (ok ? 'right' : 'wrong') },
    h('div', { class: 'result-head' }, h('strong', null, t.name), h('span', null, r.fits_assumptions ? '✔ 핵심 가정에 맞는 해석' : '◐ 핵심 가정과 어긋남'), h('span', { class: 'score' }, `${r.score}점`), !ok && h('span', { class: 'muted small' }, '오답노트에 저장됨')),
    h('div', { class: 'feedback' }, h('b', null, '핵심 가정 '), r.assumptions_comment || ''),
    r.concepts_used_well?.length ? h('div', { class: 'feedback' }, h('b', null, '바르게 쓴 개념 '), r.concepts_used_well.join(', ')) : null,
    r.concepts_misused?.length ? h('div', { class: 'feedback' }, h('b', null, '잘못 쓴 개념'), h('ul', null, r.concepts_misused.map((m) => h('li', null, h('b', null, m.concept), ' — ', m.why)))) : null,
    r.concepts_missed?.length ? h('div', { class: 'feedback' }, h('b', null, '놓친 중요 개념 '), r.concepts_missed.join(', ')) : null,
    r.model_answer && h('details', { class: 'model' }, h('summary', null, '모범 해석 비교하기'), h('p', null, r.model_answer)),
    sourceChips(r.sources, { label: '자료 근거' }));
}

function summaryTable(ev, summary, picked) {
  if (!summary.length) return null;
  return h('div', { class: 'card' },
    h('h3', null, '같은 사건, 이론별로 어떻게 다르게 설명할까?'),
    h('div', { class: 'table-wrap' }, h('table', { class: 'data-table lens-table' },
      h('thead', null, h('tr', null, h('th', null, '이론'), h('th', null, '주목하는 요인'), h('th', null, '사건 설명'), h('th', null, '협력·갈등 전망'))),
      h('tbody', null, summary.map((s) => h('tr', { class: picked.has(s.theory) ? 'mine' : '' },
        h('th', null, s.theory, picked.has(s.theory) ? ' ✎' : ''), h('td', null, s.focus), h('td', null, s.explanation), h('td', null, s.outlook)))))),
    h('p', { class: 'muted small' }, '✎ 표시는 직접 해석해 본 이론입니다.'),
    sourceChips(ev.theories.flatMap((t) => t.sources || []).slice(0, 6), { label: '이론 출처' }));
}
