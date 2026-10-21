// 1. 종합 퀴즈
import { h, add, clear, pageHead, field, select, loadingBox, errorBox, pct } from '../ui.js';
import { TYPES, QUIZ_TYPES, DIFF, generateMany, renderQuestion } from '../questions.js';

const opts = { difficulty: 'medium', count: 5, mode: 'mixed', single: 'mc', mixed: new Set(QUIZ_TYPES), focus: '' };
const recentStems = [];

export function render(root, params) {
  if (params.get('focus')) opts.focus = params.get('focus');
  const area = h('div', { class: 'quiz-area' });
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
  const start = h('button', { class: 'btn primary', onclick: () => run() }, '문제 만들기');

  const settingsCard = h('div', { class: 'card settings-card' },
    h('div', { class: 'grid-3' },
      field('난이도', h('div', { class: 'seg' }, Object.entries(DIFF).map(([k, l]) => segBtn(k, l, () => opts.difficulty, (v) => { opts.difficulty = v; })))),
      field('문항 수', h('input', { class: 'input', type: 'number', min: 1, max: 30, value: opts.count, oninput: (e) => { opts.count = Math.max(1, Math.min(30, +e.target.value || 1)); } })),
      field('출제 방식', h('div', { class: 'seg' },
        segBtn('single', '단일 유형', () => opts.mode, (v) => { opts.mode = v; drawTypes(); }),
        segBtn('mixed', '혼합 모드', () => opts.mode, (v) => { opts.mode = v; drawTypes(); })))),
    typeBox,
    field('집중 주제 (선택)', focusInput),
    h('div', { class: 'row end' }, start));
  drawTypes();

  add(root, pageHead('종합 퀴즈', '난이도와 문항 수, 유형을 고르면 학습 범위 안에서 문제를 만듭니다. 문제마다 정답·해설·출처 쪽수를 보여 줍니다.'), settingsCard, area);

  async function run() {
    const pool = opts.mode === 'single' ? [opts.single] : [...opts.mixed];
    if (!pool.length) return;
    start.disabled = true;
    area.replaceChildren(loadingBox(`문제 ${opts.count}개를 만들고 있습니다…`));
    try {
      const qs = await generateMany({ count: opts.count, typePool: pool, difficulty: opts.difficulty, focus: opts.focus, avoid: recentStems });
      recentStems.push(...qs.map((q) => q.stem));
      showSet(area, qs);
    } catch (e) {
      area.replaceChildren(errorBox(e, run));
    } finally {
      start.disabled = false;
    }
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
export function showSet(area, qs, { feature = 'quiz', retry = false, onDone } = {}) {
  clear(area);
  const done = [];
  const score = h('div', { class: 'score-bar' });
  const drawScore = () => {
    const right = done.filter((r) => r.correct).length;
    score.textContent = `진행 ${done.length}/${qs.length} · 정답 ${right}${done.length ? ` (${pct(right / done.length)})` : ''}`;
    if (done.length === qs.length) {
      score.classList.add('final');
      onDone && onDone(done);
    }
  };
  drawScore();
  area.appendChild(score);
  qs.forEach((q, i) => {
    const v = renderQuestion(q, { index: i, feature, retry, onResult: (res) => { done.push(res); drawScore(); } });
    area.appendChild(v.el);
  });
}
