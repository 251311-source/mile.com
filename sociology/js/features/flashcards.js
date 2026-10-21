// 12. 플래시카드 + 간격 반복
import { h, add, clear, pageHead, loadingBox, errorBox, sourceChips, setCurrent, toast, busy } from '../ui.js';
import { askJSON, T, SOURCES } from '../ai.js';
import { hasScope, resolveSource } from '../docs.js';
import { S, save, uid, recordAttempt, addWrong } from '../store.js';

const SCHEMA = T.obj({ cards: T.arr(T.obj({ front: T.str, definition: T.str, features: T.arr(T.str), sociologist: T.str, sources: SOURCES })) });
const MIN = 60 * 1000, DAY = 24 * 60 * MIN;
let onlyScope = true;

// 간격 반복 규칙 (SM-2를 단순화)
function schedule(card, grade) {
  const now = Date.now();
  card.ease ??= 2.5; card.interval ??= 0; card.reps ??= 0; card.lapses ??= 0;
  if (grade === 'know') {
    card.reps += 1;
    card.interval = card.reps === 1 ? 1 : card.reps === 2 ? 3 : Math.round(card.interval * card.ease);
    card.ease = Math.min(3, card.ease + 0.1);
    card.due = now + card.interval * DAY;
  } else if (grade === 'unsure') {
    card.interval = Math.max(1, Math.round(card.interval * 0.6));
    card.ease = Math.max(1.3, card.ease - 0.15);
    card.due = now + card.interval * DAY;
  } else {
    card.reps = 0; card.lapses += 1; card.interval = 0;
    card.ease = Math.max(1.3, card.ease - 0.2);
    card.due = now + 10 * MIN;
  }
  card.last = now;
}
function preview(card, grade) {
  const c = { ...card };
  schedule(c, grade);
  const d = c.due - Date.now();
  return d < DAY ? `${Math.round(d / MIN)}분 뒤` : `${Math.round(d / DAY)}일 뒤`;
}

function inScope(card) {
  return (card.sources || []).some((s) => resolveSource(s)?.inScope);
}

export function render(root) {
  const stats = h('div', { class: 'stat-row' });
  const area = h('div');
  const genBtn = h('button', { class: 'btn primary', disabled: !hasScope(), onclick: () => busy(genBtn, generate) }, '➕ 범위에서 카드 만들기');
  const filter = h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: onlyScope, onchange: (e) => { onlyScope = e.target.checked; draw(); } }), h('span', null, '현재 학습 범위의 카드만'));
  add(root, 
    pageHead('플래시카드', '핵심 개념 카드를 자동으로 만듭니다. [알았음 / 애매함 / 몰랐음]에 따라 다음 복습 시점이 조정됩니다.'),
    h('div', { class: 'row wrap' }, genBtn, h('span', { class: 'grow' }), filter),
    stats, area);

  const deck = () => S().cards.filter((c) => !onlyScope || inScope(c));

  async function generate() {
    area.replaceChildren(loadingBox('핵심 개념 카드를 만들고 있습니다…'));
    try {
      const existing = S().cards.map((c) => c.front);
      const { data } = await askJSON({ schema: SCHEMA, task: [
        '학습 범위 자료의 핵심 개념/이론으로 플래시카드 12~20장을 만들어라.',
        '- front: 개념 이름. definition: 자료에 근거한 정의(1~2문장). features: 핵심 특징 2~4개(짧게). sociologist: 관련 학자(없으면 빈 문자열). sources: 자료 위치.',
        existing.length && `- 이미 있는 카드는 제외: ${existing.slice(-80).join(', ')}`,
      ].filter(Boolean).join('\n') });
      const have = new Set(existing.map((s) => s.replace(/\s/g, '')));
      let n = 0;
      for (const c of data.cards || []) {
        if (!c.front || have.has(c.front.replace(/\s/g, ''))) continue;
        S().cards.push({ ...c, id: uid(), due: Date.now(), created: Date.now() });
        n++;
      }
      save();
      toast(`새 카드 ${n}장을 만들었습니다.`);
    } catch (e) {
      area.replaceChildren(errorBox(e));
      return;
    }
    draw();
  }

  function draw() {
    const all = deck();
    const due = all.filter((c) => (c.due || 0) <= Date.now()).sort((a, b) => (a.due || 0) - (b.due || 0));
    const learned = all.filter((c) => (c.reps || 0) >= 2).length;
    clear(stats);
    add(stats, 
      h('div', { class: 'stat' }, h('span', { class: 'stat-v' }, String(due.length)), h('span', { class: 'stat-l' }, '지금 복습할 카드')),
      h('div', { class: 'stat' }, h('span', { class: 'stat-v' }, String(all.length)), h('span', { class: 'stat-l' }, '전체 카드')),
      h('div', { class: 'stat' }, h('span', { class: 'stat-v' }, String(learned)), h('span', { class: 'stat-l' }, '익숙한 카드(2회 이상 연속)')));
    if (!all.length) {
      area.replaceChildren(h('div', { class: 'notice' }, hasScope() ? '아직 카드가 없습니다. [범위에서 카드 만들기]를 눌러 보세요.' : '[자료·범위]에서 학습 범위를 먼저 선택해 주세요.'));
      return;
    }
    if (!due.length) {
      const nextDue = Math.min(...all.map((c) => c.due || Infinity));
      const d = nextDue - Date.now();
      area.replaceChildren(h('div', { class: 'card center' }, h('h2', null, '🎉 지금 복습할 카드가 없습니다'),
        h('p', { class: 'muted' }, `다음 복습: ${d < DAY ? Math.max(1, Math.round(d / MIN)) + '분' : Math.round(d / DAY) + '일'} 뒤`),
        h('button', { class: 'btn', onclick: () => { all.forEach((c) => { c.due = Date.now(); }); save(); draw(); } }, '그래도 전부 복습하기'),
        cardTable(all)));
      return;
    }
    area.replaceChildren(cardView(due[0], due.length, draw));
  }
  draw();
}

function cardView(card, left, onNext) {
  let flipped = false;
  const back = h('div', { class: 'fc-back', hidden: true },
    h('p', { class: 'fc-def' }, card.definition),
    card.features?.length ? h('ul', null, card.features.map((f) => h('li', null, f))) : null,
    card.sociologist && h('p', null, h('b', null, '관련 학자 '), card.sociologist),
    sourceChips(card.sources));
  const rate = h('div', { class: 'fc-rate', hidden: true },
    [['know', '알았음', 'right'], ['unsure', '애매함', 'partial'], ['dont', '몰랐음', 'wrong']].map(([g, l, cls]) =>
      h('button', { class: 'btn rate ' + cls, onclick: () => grade(g) }, h('strong', null, l), h('span', { class: 'small' }, preview(card, g)))));
  const flip = () => { if (flipped) return; flipped = true; back.hidden = false; rate.hidden = false; flipBtn.remove(); };
  const flipBtn = h('button', { class: 'btn primary', onclick: flip }, '뒤집기 (Space)');
  setCurrent({ kind: 'card', label: `플래시카드: ${card.front}`, text: `[플래시카드] ${card.front}: ${card.definition}` });

  const key = (e) => {
    if (!document.body.contains(el)) return document.removeEventListener('keydown', key);
    if (e.target.matches('input, textarea')) return;
    if (e.code === 'Space') { e.preventDefault(); flip(); }
    else if (flipped && ['1', '2', '3'].includes(e.key)) grade(['know', 'unsure', 'dont'][+e.key - 1]);
  };
  document.addEventListener('keydown', key);

  function grade(g) {
    document.removeEventListener('keydown', key);
    const c = S().cards.find((x) => x.id === card.id);
    schedule(c, g);
    recordAttempt({ feature: 'cards', type: 'flashcard', concepts: [card.front], sociologists: [card.sociologist], correct: g === 'know', score: g === 'know' ? 1 : g === 'unsure' ? 0.5 : 0 });
    if (g === 'dont') addWrong({ feature: 'cards', userAnswer: '(몰랐음)', q: {
      id: 'card-' + card.id, type: 'short', stem: `다음 설명에 해당하는 개념은?\n${card.definition}`, answer_text: card.front, accept: [], options: [], context: '',
      explanation: (card.features || []).join(' / '), sources: card.sources, concepts: [card.front], sociologists: [card.sociologist].filter(Boolean),
    } });
    save();
    onNext();
  }

  const el = h('div', null,
    h('p', { class: 'muted small' }, `남은 카드 ${left}장 · 키보드: Space 뒤집기, 1/2/3 평가`),
    h('article', { class: 'flashcard', onclick: flip },
      h('div', { class: 'fc-front' }, card.front),
      back),
    h('div', { class: 'row center' }, flipBtn),
    rate);
  return el;
}

function cardTable(cards) {
  return h('details', { class: 'card-table' }, h('summary', null, '전체 카드 보기'),
    h('div', { class: 'table-wrap' }, h('table', { class: 'data-table' },
      h('thead', null, h('tr', null, h('th', null, '개념'), h('th', null, '다음 복습'), h('th', null, '연속 정답'))),
      h('tbody', null, cards.map((c) => h('tr', null, h('td', null, c.front), h('td', null, new Date(c.due).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })), h('td', { class: 'num' }, String(c.reps || 0))))))));
}
