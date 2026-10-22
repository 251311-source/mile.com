// 국제정치 6. 헷갈리는 개념 집중 모드
// - 학습 범위에서 헷갈리기 쉬운 개념 쌍(묶음)을 자동으로 찾는다(자체 검증 통과분만).
// - 모든 기능의 오답 기록에서 자주 틀린 개념이 든 쌍을 우선한다. 직접 쌍을 추가할 수도 있다.
// - 구별 문제(객관식), 차이 설명(서술형), 풀고 나면 비교 카드.
import { h, add, pageHead, loadingBox, errorBox, sourceChips, toast, confirmBox } from '../ui.js';
import { askJSON, T, SOURCES } from '../ai.js';
import { S, uid, save } from '../store.js';
import { scopeKey } from '../docs.js';
import { persistentArea, runJob, jobControls, isCancel, isRunning } from '../jobs.js';
import { verifyItems } from '../verify.js';
import { renderQuestion } from '../questions.js';
import { saveToBank } from '../bank.js';

const ITEM = T.obj({ name: T.str, definition: T.str, example: T.str, related_theories: T.arr(T.str), sources: SOURCES });
const GROUP = T.obj({ items: T.arr(ITEM), key_difference: T.str, from_weak: T.bool, sources: SOURCES });
const GROUPS = T.obj({ groups: T.arr(GROUP) });
const ONE = T.obj({ found: T.bool, group: GROUP });
const DIST = T.obj({ questions: T.arr(T.obj({ stem: T.str, context: T.str, answer: T.str, explanation: T.str, sources: SOURCES })) });

const nrm = (s) => String(s || '').toLowerCase().replace(/[\s·.,()\-'"]/g, '');

// 개념별로 틀린 횟수 (모든 기능의 채점 기록 + 아직 복습하지 않은 오답)
function weakCounts() {
  const m = new Map();
  const bump = (c, n = 1) => { const k = nrm(c); if (k) m.set(k, (m.get(k) || 0) + n); };
  for (const a of S().attempts) if (!a.correct) (a.concepts || []).forEach((c) => bump(c));
  for (const w of S().wrong) if (!w.mastered) (w.q?.concepts || []).forEach((c) => bump(c));
  return m;
}
const weakOf = (group, counts) => group.items.reduce((s, it) => {
  const k = nrm(it.name);
  let n = counts.get(k) || 0;
  if (!n) for (const [c, v] of counts) if (c.length > 1 && (c.includes(k) || k.includes(c))) n = Math.max(n, v);
  return s + n;
}, 0);
function topWeak(limit = 10) {
  const names = new Map();
  for (const a of S().attempts) if (!a.correct) (a.concepts || []).forEach((c) => names.set(nrm(c), c));
  return [...weakCounts()].filter(([k]) => names.has(k)).sort((a, b) => b[1] - a[1]).slice(0, limit).map(([k, n]) => `${names.get(k)}(${n}회)`);
}

// 자동 추출 + 직접 추가, 자주 틀린 순서
function allGroups() {
  const counts = weakCounts();
  const auto = (S().confusions[scopeKey()]?.groups || []).map((g) => ({ ...g, origin: 'auto' }));
  const mine = S().pairs.map((p) => ({ ...(p.group || { items: p.names.map((name) => ({ name })) }), id: p.id, origin: 'custom', pending: !p.group, names: p.names }));
  return [...mine, ...auto].map((g) => ({ ...g, weak: weakOf(g, counts) })).sort((a, b) => b.weak - a.weak || (a.origin === 'custom' ? -1 : 1));
}

export function render(root) {
  const area = persistentArea('confuse'); // 풀던 문제는 화면을 떠나도 유지
  const listBox = h('div', { class: 'confuse-list' });
  const inA = h('input', { class: 'input', type: 'text', placeholder: '개념 A (예: 집단 안보)', 'aria-label': '개념 A' });
  const inB = h('input', { class: 'input', type: 'text', placeholder: '개념 B (예: 집단 방위)', 'aria-label': '개념 B' });
  const draw = () => drawList(listBox, area, draw);
  add(root,
    pageHead('헷갈리는 개념', '학습 범위에서 헷갈리기 쉬운 개념 쌍을 찾아 구별 문제와 차이 설명으로 연습합니다. 모든 기능에서 자주 틀린 개념이 든 쌍은 위로 올라옵니다.'),
    area,
    h('div', { class: 'card' },
      h('div', { class: 'row wrap' },
        h('h3', { class: 'grow' }, '헷갈리는 개념 쌍'),
        jobControls('confuse', { start: () => extract(), label: S().confusions[scopeKey()] ? '다시 찾기' : '자료에서 찾기', running: '자료에서 헷갈리는 개념을 찾는 중…' })),
      listBox,
      h('div', { class: 'row wrap add-pair' }, inA, h('span', null, 'vs'), inB, h('button', { class: 'btn', onclick: () => {
        const a = inA.value.trim(), b = inB.value.trim();
        if (!a || !b || nrm(a) === nrm(b)) return toast('서로 다른 두 개념을 입력해 주세요.', 'warn');
        S().pairs.push({ id: uid(), names: [a, b], created: Date.now(), group: null });
        save();
        inA.value = inB.value = '';
        toast('직접 추가한 쌍을 저장했어요. 연습을 누르면 자료에서 두 개념을 찾아 비교 카드를 만들어요.');
        draw();
      } }, '➕ 직접 추가'))));
  draw();

  function extract() {
    runJob('confuse', { label: '헷갈리는 개념 쌍', page: 'confuse' }, async (signal) => {
      try {
        const weak = topWeak();
        const { data } = await askJSON({ signal, schema: GROUPS, task: [
          '학습 범위 자료에서 학생들이 서로 헷갈리기 쉬운 개념 쌍(또는 3개 묶음)을 4~8개 찾아라. 예: 집단 안보와 집단 방위, 세력 균형과 패권 안정, 하드 파워와 소프트 파워, 상대적 이득과 절대적 이득, 안보 딜레마와 군비 경쟁. 반드시 자료에 둘 다 나오는 개념만 쓴다.',
          '- items: 묶인 개념들. name: 자료 표기, definition: 자료에 근거한 정의 1~2문장, example: 자료에 나온 예시(없으면 자료 내용으로 설명되는 짧은 예), related_theories: 관련 이론, sources: 위치.',
          '- key_difference: 둘을 구분하는 핵심 차이 2~3문장. sources: 근거 위치.',
          weak.length && `- 학습자가 자주 틀린 개념: ${weak.join(', ')}. 이 개념이 자료에 있으면 그것과 헷갈리기 쉬운 개념을 짝지어 먼저 넣고 from_weak를 true로 한다.`,
        ].filter(Boolean).join('\n') });
        const groups = (data.groups || []).filter((g) => (g.items || []).filter((i) => i.name && i.definition).length >= 2);
        const v = await verifyItems('confuse', groups, { signal });
        const ok = groups.filter((_, i) => v[i]?.pass).map((g) => ({ ...g, id: uid() }));
        if (!ok.length) throw new Error('검증을 통과한 개념 쌍을 찾지 못했습니다. 범위를 넓혀 보세요.');
        S().confusions[scopeKey()] = { groups: ok, created: Date.now(), skipped: groups.length - ok.length };
        save();
        if (listBox.isConnected) draw();
      } catch (e) {
        if (!isCancel(e) && listBox.isConnected) toast(e.message, 'error');
        throw e;
      }
    });
  }
}

function drawList(box, area, redraw) {
  const groups = allGroups();
  if (!groups.length) { box.replaceChildren(h('p', { class: 'muted empty' }, '[자료에서 찾기]를 누르거나 아래에서 직접 쌍을 추가하세요.')); return; }
  box.replaceChildren(...groups.map((g) => h('div', { class: 'pair-item' },
    h('div', { class: 'row wrap' },
      h('b', { class: 'grow' }, g.items.map((i) => i.name).join(' vs ')),
      g.weak ? h('span', { class: 'tag label-unverified' }, `자주 틀림 ${g.weak}회`) : null,
      g.from_weak && !g.weak ? h('span', { class: 'tag soft' }, '오답 기반') : null,
      g.origin === 'custom' ? h('span', { class: 'tag soft' }, '직접 추가') : null,
      h('button', { class: 'btn small', onclick: () => start(g, 'distinguish', area) }, '구별 문제'),
      h('button', { class: 'btn small', onclick: () => start(g, 'difference', area) }, '차이 설명'),
      g.origin === 'custom' ? h('button', { class: 'icon-btn', 'aria-label': '삭제', onclick: async () => {
        if (!(await confirmBox('직접 추가한 이 쌍을 삭제할까요?'))) return;
        S().pairs = S().pairs.filter((p) => p.id !== g.id);
        save();
        redraw();
      } }, '✕') : null))));
}

// 직접 추가한 쌍은 처음 연습할 때 자료에서 두 개념을 찾아 비교 카드를 만든다
async function ensureGroup(g, signal) {
  if (!g.pending) return g;
  const { data } = await askJSON({ signal, schema: ONE, task: [
    `학습 범위 자료에서 다음 개념들을 찾아 비교 카드를 만들어라: ${g.names.join(', ')}`,
    '- 자료에 이 개념들이 모두 나오면 found=true. 하나라도 자료에 없으면 found=false로 하고 지어내지 않는다.',
    '- group.items: 각 개념의 name(입력한 표기), definition(자료 근거 1~2문장), example, related_theories, sources. group.key_difference: 핵심 차이 2~3문장, group.sources.',
  ].join('\n') });
  if (!data.found || (data.group?.items || []).length < 2) throw new Error(`학습 범위 자료에서 "${g.names.join('", "')}"을(를) 모두 찾지 못했어요. 범위를 확인하거나 자료에 쓰인 표기로 다시 추가해 주세요.`);
  const [v] = await verifyItems('confuse', [data.group], { signal });
  if (!v.pass) throw new Error('비교 카드를 자료와 대조해 확인하지 못했습니다. 다시 시도해 주세요.');
  const p = S().pairs.find((x) => x.id === g.id);
  if (p) { p.group = data.group; save(); }
  return { ...g, ...data.group, pending: false };
}

function start(g, kind, area) {
  if (isRunning('confuse-q')) return toast('문제를 만드는 중이에요. 잠시만 기다려 주세요.', 'warn');
  runJob('confuse-q', { label: '헷갈리는 개념 문제', page: 'confuse' }, async (signal) => {
    area.replaceChildren(loadingBox(kind === 'distinguish' ? '구별 문제를 만들고 있습니다…' : '문제를 준비하고 있습니다…'));
    try {
      const group = await ensureGroup(g, signal);
      if (kind === 'difference') area.replaceChildren(differenceQ(group));
      else area.replaceChildren(...(await distinguishQs(group, signal)));
      area.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (e) {
      area.replaceChildren(isCancel(e) ? h('div', { class: 'notice' }, '생성을 취소했어요.') : errorBox(e, () => start(g, kind, area)));
      throw e;
    }
  });
}

const namesOf = (g) => g.items.map((i) => i.name);

// 구별: 설명·사례를 보고 어느 개념인지 고른다 (자체 검증 → 문제 은행 저장)
async function distinguishQs(g, signal) {
  const names = namesOf(g);
  const { data } = await askJSON({ signal, schema: DIST, task: [
    `다음 개념들을 구별하는 문제 3개를 만들어라: ${names.join(', ')}`,
    '- 각 문제는 개념 이름을 쓰지 않은 설명이나 짧은 국제 상황(context, 2~4문장)을 주고 "이 설명(상황)에 해당하는 개념은?"을 묻는다. stem에 질문, context에 설명·상황.',
    `- answer는 반드시 다음 중 하나 그대로: ${names.join(' / ')}. 세 문제의 정답이 한쪽으로 몰리지 않게 한다.`,
    '- explanation: 왜 그 개념이고 다른 개념이 아닌지. sources: 근거 위치. 모두 자료에 근거한다.',
    JSON.stringify({ items: g.items.map((i) => ({ name: i.name, definition: i.definition })), key_difference: g.key_difference }),
  ].join('\n') });
  const qs = (data.questions || []).filter((x) => names.includes(x.answer) && x.stem).map((x) => ({
    id: uid(), type: 'mc', difficulty: 'medium', stem: x.stem, context: x.context || '',
    options: names, answer_index: names.indexOf(x.answer), accept: [],
    explanation: x.explanation, sources: x.sources || [], concepts: names, sociologists: [],
  }));
  const v = await verifyItems('quiz', qs, { signal });
  const ok = qs.filter((_, i) => v[i]?.pass);
  if (!ok.length) throw new Error('검증을 통과한 구별 문제를 만들지 못했습니다. 다시 시도해 주세요.');
  ok.forEach((q) => { q.verified = true; saveToBank(q, { feature: 'confuse' }); });
  let shown = false;
  const cardBox = h('div');
  const views = ok.map((q, i) => renderQuestion(q, { index: i, feature: 'confuse', onResult: () => {
    if (!shown) { shown = true; cardBox.replaceChildren(compareCard(g)); }
  } }));
  return [h('div', { class: 'notice' }, `${names.join(' vs ')} · 구별 문제 ${ok.length}개 (자체 검증 통과)`), ...views.map((v) => v.el), cardBox];
}

// 차이 설명: AI가 루브릭으로 채점
function differenceQ(g) {
  const names = namesOf(g);
  const q = {
    id: 'cd_' + (g.id || uid()), type: 'essay', difficulty: 'medium',
    stem: `${names.join('와(과) ')}의 핵심 차이를 설명하시오. (각 개념의 의미와 구분 기준을 포함)`,
    context: '', options: [], accept: [],
    rubric: [
      { criterion: '각 개념의 정확한 의미', points: 4, key_elements: g.items.map((i) => `${i.name}: ${i.definition}`) },
      { criterion: '핵심 차이(구분 기준)', points: 4, key_elements: [g.key_difference] },
      { criterion: '예시나 관련 이론 활용', points: 2, key_elements: g.items.map((i) => i.example).filter(Boolean) },
    ],
    model_answer: `${g.items.map((i) => `${i.name}: ${i.definition}`).join(' ')} ${g.key_difference}`,
    explanation: g.key_difference, sources: [...(g.sources || []), ...g.items.flatMap((i) => i.sources || [])], concepts: names, sociologists: [], verified: true,
  };
  const cardBox = h('div');
  const v = renderQuestion(q, { feature: 'confuse', onResult: () => cardBox.replaceChildren(compareCard(g)) });
  return h('div', null, v.el, cardBox);
}

// 비교 카드: 개념을 나란히 (정의·예시·관련 이론·출처)
function compareCard(g) {
  return h('div', { class: 'card compare-card' },
    h('h3', null, '비교 카드'),
    h('div', { class: 'pair-grid' }, g.items.map((i) => h('div', { class: 'pair-col' },
      h('h3', null, i.name),
      h('p', null, h('b', null, '정의 '), i.definition || ''),
      i.example && h('p', null, h('b', null, '예시 '), i.example),
      i.related_theories?.length ? h('p', null, h('b', null, '관련 이론 '), i.related_theories.join(', ')) : null,
      sourceChips(i.sources)))),
    h('div', { class: 'distinction' }, h('b', null, '핵심 차이 '), g.key_difference, sourceChips(g.sources)));
}
