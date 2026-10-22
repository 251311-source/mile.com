// 국제정치 5. 역사적 배경 연결: 사건·시기와 그때 등장하거나 영향력이 커진 이론을 연결한다.
// 연표는 학습 범위마다 한 번 만들어 계정에 저장하고(자체 검증 통과분만), 문제는 연표에서 만든다.
import { h, add, pageHead, loadingBox, errorBox, sourceChips, shuffle, toast } from '../ui.js';
import { askJSON, T, SOURCES } from '../ai.js';
import { S, uid, save, recordAttempt, addWrong } from '../store.js';
import { scopeKey } from '../docs.js';
import { persistentArea, runJob, jobControls, isCancel } from '../jobs.js';
import { verifyItems } from '../verify.js';
import { renderQuestion } from '../questions.js';
import { saveToBank } from '../bank.js';
import { segBtn } from './quiz.js';

const TIMELINE = T.obj({
  items: T.arr(T.obj({ name: T.str, kind: T.oneOf('event', 'period', 'theory'), when: T.str, year: T.int, description: T.str, sources: SOURCES })),
  links: T.arr(T.obj({ event: T.str, theory: T.str, relation: T.oneOf('emerged', 'gained'), why: T.str, key_points: T.arr(T.str), sources: SOURCES })),
  debates: T.arr(T.obj({ name: T.str, sides: T.str, issue: T.str, context: T.str, key_points: T.arr(T.str), sources: SOURCES })),
});
const KIND = { event: '사건', period: '시기', theory: '이론' };
const FORMATS = { match: '사건↔이론 연결', order: '연대순 배열', why: '"왜 그때?"', debate: '이론 논쟁' };
const opts = { format: 'match' };

export function render(root) {
  const area = persistentArea('history');
  const tlBox = h('div');
  const practice = h('div', { class: 'card settings-card' });
  const drawAll = () => {
    const tl = S().timelines[scopeKey()];
    drawTimeline(tlBox, tl);
    drawPractice(practice, tl, area);
  };
  add(root,
    pageHead('역사적 배경 연결', '자료에 나온 역사적 사건·시기와 그때 등장하거나 영향력이 커진 이론을 연결합니다. 연표에서 사건과 이론을 함께 보고, 연결·배열·서술 문제로 연습하세요.'),
    practice, area, tlBox,
    jobControls('history', { start: () => build(), label: S().timelines[scopeKey()] ? '연표 다시 만들기' : '연표 만들기', running: '연표를 만드는 중… 다른 화면에 다녀와도 계속 만들어요.' }));
  drawAll();

  function build() {
    runJob('history', { label: '사건·이론 연표', page: 'history' }, async (signal) => {
      const prev = [...tlBox.childNodes];
      tlBox.replaceChildren(loadingBox('자료에서 사건·시기·이론을 찾고 있습니다…'));
      try {
        const tl = await makeTimeline(signal);
        S().timelines[scopeKey()] = tl;
        save();
        if (tlBox.isConnected) drawAll();
        else tlBox.replaceChildren();
      } catch (e) {
        if (isCancel(e)) tlBox.replaceChildren(...prev);
        else tlBox.replaceChildren(errorBox(e, build));
        throw e;
      }
    });
  }
}

async function makeTimeline(signal) {
  const { data } = await askJSON({ signal, schema: TIMELINE, task: [
    '학습 범위 자료에 나오는 역사적 사건·시기와 국제정치 이론의 관계로 연표를 만들어라. 자료에 나오지 않는 사건·이론은 넣지 않는다.',
    '- items: 사건(event, 예: 베스트팔렌 조약, 제1차 세계 대전), 시기(period, 예: 전간기, 냉전, 탈냉전, 9·11 이후), 이론(theory: 그 이론이 등장하거나 영향력이 커진 시점으로). when: 표기(예: 1648년, 1919~1939년), year: 정렬용 시작 연도(정수), description: 자료에 근거한 1~2문장, sources: 자료 위치.',
    '- links: 사건/시기 ↔ 이론 연결. event와 theory는 items의 name 그대로. relation: emerged(그때 등장) 또는 gained(영향력이 커짐). why: 왜 그때였는지 자료에 근거한 2~3문장, key_points: 채점용 핵심 요소 2~4개, sources.',
    '- debates: 자료에 국제정치학의 대논쟁(예: 이상주의 대 현실주의, 전통주의 대 행태주의, 신현실주의 대 신자유주의)이 나오면 넣는다. 없으면 빈 배열. sides: 맞선 입장, issue: 쟁점, context: 그 논쟁의 역사적 배경, key_points, sources.',
  ].join('\n') });
  const items = (data.items || []).filter((x) => x.name && x.sources?.length);
  const names = new Set(items.map((x) => x.name));
  const links = (data.links || []).filter((l) => names.has(l.event) && names.has(l.theory) && l.why);
  const debates = (data.debates || []).filter((d) => d.name && d.context);
  // 자체 검증: 항목·연결·논쟁을 자료와 대조하고 통과한 것만 남긴다
  const all = [
    ...items.map((x) => ({ type: 'item', ...x })),
    ...links.map((l) => ({ type: 'link', ...l })),
    ...debates.map((d) => ({ type: 'debate', ...d })),
  ];
  const verdicts = await verifyItems('history', all, { signal });
  const pass = (i) => verdicts[i]?.pass;
  const okItems = items.filter((_, i) => pass(i)).map((x) => ({ ...x, id: uid() }));
  const okNames = new Set(okItems.map((x) => x.name));
  const okLinks = links.filter((_, i) => pass(items.length + i)).filter((l) => okNames.has(l.event) && okNames.has(l.theory)).map((l) => ({ ...l, id: uid() }));
  const okDebates = debates.filter((_, i) => pass(items.length + links.length + i)).map((d) => ({ ...d, id: uid() }));
  if (okItems.length < 3) throw new Error('학습 범위에서 검증을 통과한 사건·이론이 너무 적습니다. 범위를 넓혀 보세요.');
  return { items: okItems.sort((a, b) => (a.year || 0) - (b.year || 0)), links: okLinks, debates: okDebates, created: Date.now(), skipped: all.length - verdicts.filter((v) => v.pass).length };
}

// ---------- 연표 보기 ----------
function drawTimeline(box, tl) {
  if (!tl) { box.replaceChildren(h('p', { class: 'muted empty' }, '아래 [연표 만들기]를 누르면 학습 범위에서 사건·시기·이론을 찾아 연표를 만듭니다.')); return; }
  const theoriesOf = (name) => tl.links.filter((l) => l.event === name).map((l) => `${l.theory}${l.relation === 'emerged' ? ' 등장' : ' 영향력 확대'}`);
  box.replaceChildren(h('div', { class: 'card' },
    h('h3', null, '사건·이론 연표'),
    h('ol', { class: 'timeline' }, tl.items.map((x) => h('li', { class: 'tl-item tl-' + x.kind },
      h('div', { class: 'tl-when' }, x.when || (x.year ? `${x.year}년` : '')),
      h('div', { class: 'tl-body' },
        h('div', null, h('span', { class: 'tag ' + (x.kind === 'theory' ? '' : 'soft') }, KIND[x.kind]), ' ', h('b', null, x.name)),
        h('p', { class: 'small' }, x.description),
        theoriesOf(x.name).length ? h('p', { class: 'small' }, '→ ', theoriesOf(x.name).join(', ')) : null,
        sourceChips(x.sources))))),
    tl.debates.length ? h('div', null, h('h3', null, '이론 논쟁'), tl.debates.map((d) => h('div', { class: 'feedback' },
      h('b', null, d.name), ` — ${d.sides}. 쟁점: ${d.issue} / 배경: ${d.context}`, sourceChips(d.sources)))) : null,
    tl.skipped ? h('p', { class: 'muted small' }, `자료와 대조해 확인되지 않은 ${tl.skipped}개 항목은 뺐습니다.`) : null));
}

// ---------- 연습 ----------
function drawPractice(box, tl, area) {
  if (!tl) { box.replaceChildren(h('p', { class: 'muted' }, '연표를 먼저 만들면 연결·배열·서술 문제를 풀 수 있어요.')); return; }
  const avail = { match: tl.links.length >= 2, order: tl.items.filter((x) => x.year).length >= 3, why: tl.links.length >= 1, debate: tl.debates.length >= 1 };
  if (!avail[opts.format]) opts.format = Object.keys(avail).find((k) => avail[k]) || 'match';
  box.replaceChildren();
  add(box,
    h('div', { class: 'row wrap' },
      h('div', { class: 'seg' }, Object.entries(FORMATS).filter(([k]) => avail[k]).map(([k, l]) => segBtn(k, l, () => opts.format, (v) => { opts.format = v; }))),
      h('span', { class: 'grow' }),
      h('button', { class: 'btn primary', onclick: () => practice(tl, area) }, '문제 풀기')),
    !avail.debate ? h('p', { class: 'muted small' }, '자료에 이론 논쟁(대논쟁)이 나오지 않아 논쟁 문제는 없습니다.') : null);
}

function practice(tl, area) {
  const make = { match: matchQuestion, order: orderQuestion, why: whyQuestion, debate: debateQuestion }[opts.format];
  const el = make(tl);
  if (!el) return toast('이 형식으로 낼 문제가 부족합니다.', 'warn');
  area.replaceChildren(el);
  el.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// 사건/시기 ↔ 이론 연결 (직접 채점). 틀린 연결은 객관식 문제로 오답노트에 저장한다.
function matchQuestion(tl) {
  const seenE = new Set(), seenT = new Set();
  const rows = shuffle(tl.links).filter((l) => !seenE.has(l.event) && !seenT.has(l.theory) && seenE.add(l.event) && seenT.add(l.theory)).slice(0, 4);
  if (rows.length < 2) return null;
  const theories = shuffle([...new Set(tl.links.map((l) => l.theory))]);
  const sels = rows.map(() => h('select', { class: 'input' }, h('option', { value: '' }, '이론 고르기'), theories.map((t) => h('option', { value: t }, t))));
  const result = h('div', { 'aria-live': 'polite' });
  const submit = h('button', { class: 'btn primary', onclick: () => {
    if (sels.some((s) => !s.value)) return toast('모든 사건에 이론을 골라 주세요.', 'warn');
    submit.disabled = true;
    sels.forEach((s) => { s.disabled = true; });
    const marks = rows.map((r, i) => sels[i].value === r.theory || tl.links.some((l) => l.event === r.event && l.theory === sels[i].value));
    marks.forEach((ok, i) => {
      const r = rows[i];
      const q = linkMC(tl, r);
      recordAttempt({ qid: q.id, feature: 'history', type: 'history_match', concepts: [r.theory, r.event], sociologists: [], correct: ok, score: ok ? 1 : 0 });
      if (!ok) addWrong({ feature: 'history', q, userAnswer: q.options.indexOf(sels[i].value) >= 0 ? q.options.indexOf(sels[i].value) : sels[i].value, feedback: r.why });
    });
    const n = marks.filter(Boolean).length;
    result.replaceChildren(h('div', { class: 'result ' + (n === rows.length ? 'right' : 'wrong') },
      h('div', { class: 'result-head' }, h('strong', null, `${rows.length}개 중 ${n}개 정답`), n < rows.length && h('span', { class: 'muted small' }, '틀린 연결은 오답노트에 저장됨')),
      h('ul', null, rows.map((r, i) => h('li', { class: marks[i] ? 'found' : 'missed' }, `${marks[i] ? '✔' : '✘'} ${r.event} → ${r.theory}`, marks[i] ? '' : ` (내 답: ${sels[i].value})`, h('div', { class: 'small muted' }, r.why), sourceChips(r.sources))))));
  } }, '제출');
  return h('article', { class: 'qcard' },
    h('div', { class: 'qmeta' }, h('span', { class: 'tag' }, FORMATS.match)),
    h('p', { class: 'qstem' }, '각 사건·시기와 그때 등장하거나 영향력이 커진 이론을 연결하시오.'),
    h('div', { class: 'match-table' }, rows.map((r, i) => h('div', { class: 'match-row' }, h('span', { class: 'who' }, r.event), sels[i]))),
    h('div', { class: 'qactions' }, submit), result);
}

// 연결 하나를 객관식으로 (오답노트·다시 풀기용)
function linkMC(tl, link) {
  const others = shuffle([...new Set(tl.links.map((l) => l.theory).concat(tl.items.filter((x) => x.kind === 'theory').map((x) => x.name)))].filter((t) => t !== link.theory && !tl.links.some((l) => l.event === link.event && l.theory === t))).slice(0, 4);
  const options = shuffle([link.theory, ...others]);
  return {
    id: 'hm_' + link.id, type: 'mc', difficulty: 'medium',
    stem: `'${link.event}'와(과) 관련해 ${link.relation === 'emerged' ? '그 시기에 등장한' : '그 시기에 영향력이 커진'} 이론은?`,
    context: '', options, answer_index: options.indexOf(link.theory), accept: [],
    explanation: link.why, sources: link.sources, concepts: [link.theory, link.event], sociologists: [], verified: true,
  };
}

function orderQuestion(tl) {
  const pool = shuffle(tl.items.filter((x) => x.year));
  const pick = [];
  for (const x of pool) if (!pick.some((p) => p.year === x.year) && pick.length < 5) pick.push(x);
  if (pick.length < 3) return null;
  pick.sort((a, b) => a.year - b.year);
  const q = {
    id: 'ho_' + pick.map((x) => x.id).join('_'), type: 'ordering', difficulty: 'medium',
    stem: '다음 사건·시기와 이론의 등장을 일어난 순서대로 배열하시오.',
    context: '', options: [], accept: [], order_items: pick.map((x) => x.name),
    explanation: pick.map((x) => `${x.name}: ${x.when || x.year + '년'}`).join(' → '),
    sources: pick.flatMap((x) => x.sources || []), concepts: pick.filter((x) => x.kind === 'theory').map((x) => x.name).slice(0, 3), sociologists: [], verified: true,
  };
  saveToBank(q, { feature: 'history' });
  return renderQuestion(q, { feature: 'history' }).el;
}

function whyQuestion(tl) {
  const l = shuffle(tl.links)[0];
  if (!l) return null;
  const q = {
    id: 'hw_' + l.id, type: 'essay', difficulty: 'medium',
    stem: `${l.theory}이(가) '${l.event}' 시기에 ${l.relation === 'emerged' ? '등장한' : '영향력이 커진'} 이유를 당시의 역사적 배경과 연결해 설명하시오.`,
    context: '', options: [], accept: [],
    rubric: [
      { criterion: '당시의 역사적 상황 설명', points: 4, key_elements: (l.key_points || []).slice(0, 2) },
      { criterion: '이론의 핵심 주장과의 연결', points: 4, key_elements: (l.key_points || []).slice(2) },
      { criterion: '논리적 연결과 정확한 용어', points: 2, key_elements: [l.theory] },
    ],
    model_answer: l.why, explanation: l.why, sources: l.sources, concepts: [l.theory, l.event], sociologists: [], verified: true,
  };
  saveToBank(q, { feature: 'history' });
  return renderQuestion(q, { feature: 'history' }).el;
}

function debateQuestion(tl) {
  const d = shuffle(tl.debates)[0];
  if (!d) return null;
  const q = {
    id: 'hd_' + d.id, type: 'essay', difficulty: 'medium',
    stem: `${d.name}에서 맞선 입장과 쟁점을 쓰고, 이 논쟁이 벌어진 역사적 배경과 연결해 설명하시오.`,
    context: '', options: [], accept: [],
    rubric: [
      { criterion: '맞선 입장과 쟁점', points: 4, key_elements: [d.sides, d.issue].filter(Boolean) },
      { criterion: '역사적 배경과의 연결', points: 4, key_elements: (d.key_points || []).length ? d.key_points : [d.context] },
      { criterion: '정확한 용어 사용', points: 2, key_elements: [] },
    ],
    model_answer: `${d.sides}. 쟁점: ${d.issue}. 배경: ${d.context}`, explanation: d.context, sources: d.sources, concepts: [d.name], sociologists: [], verified: true,
  };
  saveToBank(q, { feature: 'history' });
  return renderQuestion(q, { feature: 'history' }).el;
}
