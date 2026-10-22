// 1. 종합 퀴즈
import { h, add, clear, pageHead, field, select, loadingBox, errorBox, pct } from '../ui.js';
import { TYPES, QUIZ_TYPES, DIFF, getQuestions, renderQuestion } from '../questions.js';
import { persistentArea, runJob, jobControls, isCancel } from '../jobs.js';

const opts = { difficulty: 'medium', count: 5, mode: 'mixed', single: 'mc', mixed: new Set(QUIZ_TYPES), focus: '', freshOnly: false };
const recentStems = [];

export function render(root, params) {
  if (params.get('focus')) opts.focus = params.get('focus');
  const area = persistentArea('quiz'); // 다른 화면에 다녀와도 생성·풀이가 이어진다
  const typeBox = h('div');

  const drawTypes = () => {
    clear(typeBox);
    if (opts.mode === 'single') {
      typeBox.appendChild(field('문제 유형', select(QUIZ_TYPES.map((t) => [t, TYPES[t]]), opts.single, (v) => { opts.single = v; })));
    } else {
      typeBox.appendChild(h('div', { class: 'field' }, h('span', { class: 'field-label' }, '섞을 유형 (혼합 모드)'),
        h('div', { class: 'chip-row' }, QUIZ_TYPES.map((t) => h('button', {
          class: 'chip toggle' + (opts.mixed.has(t) ? ' on' : ''), 'aria-pressed': String(opts.mixed.has(t)),
          onclick: (e) => { opts.mixed.has(t) ? opts.mixed.delete(t) : opts.mixed.add(t); e.currentTarget.classList.toggle('on'); e.currentTarget.setAttribute('aria-pressed', String(opts.mixed.has(t))); },
        }, TYPES[t])))));
    }
  };

  const focusInput = h('input', { class: 'input', type: 'text', value: opts.focus, placeholder: '예: 베버, 아노미 (비우면 범위 전체)', oninput: (e) => { opts.focus = e.target.value; } });
  const start = jobControls('quiz', { start: () => run(), label: '문제 만들기', running: '문제를 만드는 중… 다른 화면에 다녀와도 계속 만들어요.' });

  const settingsCard = h('div', { class: 'card settings-card' },
    h('div', { class: 'grid-3' },
      field('난이도', h('div', { class: 'seg' }, Object.entries(DIFF).map(([k, l]) => segBtn(k, l, () => opts.difficulty, (v) => { opts.difficulty = v; })))),
      field('문항 수', h('input', { class: 'input', type: 'number', min: 1, max: 30, value: opts.count, oninput: (e) => { opts.count = Math.max(1, Math.min(30, +e.target.value || 1)); } })),
      field('출제 방식', h('div', { class: 'seg' },
        segBtn('single', '단일 유형', () => opts.mode, (v) => { opts.mode = v; drawTypes(); }),
        segBtn('mixed', '혼합 모드', () => opts.mode, (v) => { opts.mode = v; drawTypes(); })))),
    typeBox,
    field('집중 주제 (선택)', focusInput),
    h('div', { class: 'row wrap' },
      h('label', { class: 'check', title: '문제 은행에 저장된 문제를 쓰지 않고 모두 새로 만듭니다.' },
        h('input', { type: 'checkbox', checked: opts.freshOnly, onchange: (e) => { opts.freshOnly = e.target.checked; } }),
        h('span', null, '새 문제만 받기')),
      h('span', { class: 'muted small grow' }, '끄면 문제 은행에서 조건에 맞는 문제를 먼저 쓰고, 모자란 만큼만 새로 만듭니다.'),
      start));
  drawTypes();

  add(root, pageHead('종합 퀴즈', '난이도와 문항 수, 유형을 고르면 학습 범위 안에서 문제를 만듭니다. 문제마다 정답·해설·출처 쪽수를 보여 줍니다.'), settingsCard, area);

  function run() {
    const pool = opts.mode === 'single' ? [opts.single] : [...opts.mixed];
    if (!pool.length) return;
    const count = opts.count;
    runJob('quiz', { label: '종합 퀴즈 문제', page: 'quiz' }, async (signal) => {
      area.replaceChildren(loadingBox(`문제 ${count}개를 만들고 있습니다… 준비되는 대로 먼저 보여 드릴게요.`));
      let set = null;
      // 묶음이 준비되는 대로 바로 보여 준다
      const onReady = (qs) => {
        if (!set) set = showSet(area, [], { waiting: count });
        set.add(qs);
      };
      try {
        const r = await getQuestions({ count, typePool: pool, difficulty: opts.difficulty, focus: opts.focus, avoid: recentStems, freshOnly: opts.freshOnly, onReady, signal });
        recentStems.push(...r.questions.map((q) => q.stem));
        if (!set) set = showSet(area, r.questions); else set.finish();
        area.prepend(h('div', { class: 'notice bank-note' },
          `문제 은행에서 ${r.fromBank}개, 새로 만든 문제 ${r.generated}개 (모두 자체 검증 통과)`,
          r.skipped ? ` · 검증을 두 번 통과하지 못한 ${r.skipped}개는 건너뛰었습니다.` : ''));
      } catch (e) {
        if (isCancel(e)) {
          if (set) { set.finish(); area.prepend(h('div', { class: 'notice' }, '생성을 취소했어요. 이미 만들어진 문제는 그대로 풀 수 있어요.')); }
          else area.replaceChildren(h('div', { class: 'notice' }, '생성을 취소했어요.'));
        } else area.replaceChildren(errorBox(e, run));
        throw e;
      }
    });
  }
}

export function segBtn(value, label, get, setv) {
  const b = h('button', { type: 'button', class: get() === value ? 'on' : '', 'aria-pressed': String(get() === value), onclick: () => {
    setv(value);
    b.parentElement.querySelectorAll('button').forEach((x) => { x.classList.remove('on'); x.setAttribute('aria-pressed', 'false'); });
    b.classList.add('on'); b.setAttribute('aria-pressed', 'true');
  } }, label);
  return b;
}

// 문제 세트를 순서대로 보여 주고 점수를 집계한다.
// 문제 세트를 순서대로 보여 주고 점수를 집계한다. 문제가 나중에 더 도착하면 add()로 이어 붙인다.
export function showSet(area, qs, { feature = 'quiz', retry = false, onDone, waiting = 0 } = {}) {
  clear(area);
  const list = [...qs];
  const done = [];
  let expected = Math.max(waiting, list.length);
  let finished = waiting === 0;
  const score = h('div', { class: 'score-bar' });
  const more = h('div', { class: 'loading more-loading' }, h('span', { class: 'spinner', 'aria-hidden': 'true' }), h('span'));
  const drawScore = () => {
    const right = done.filter((r) => r.correct).length;
    score.textContent = `진행 ${done.length}/${finished ? list.length : expected} · 정답 ${right}${done.length ? ` (${pct(right / done.length)})` : ''}`;
    more.hidden = finished;
    more.lastChild.textContent = `나머지 문제를 만드는 중… (${list.length}/${expected} 준비됨)`;
    if (finished && done.length === list.length && list.length) {
      score.classList.add('final');
      onDone && onDone(done);
    }
  };
  const addCards = (items) => items.forEach((q) => {
    const v = renderQuestion(q, { index: list.indexOf(q), feature, retry, onResult: (res) => { done.push(res); drawScore(); } });
    area.insertBefore(v.el, more);
  });
  area.appendChild(score);
  area.appendChild(more);
  addCards(list);
  drawScore();
  return {
    add(items) { list.push(...items); addCards(items); drawScore(); },
    finish() { finished = true; drawScore(); },
  };
}
