// 13. 시험 모드
import { h, add, clear, pageHead, field, loadingBox, errorBox, pct, confirmBox } from '../ui.js';
import { QUIZ_TYPES, TYPES, DIFF, getQuestions, renderQuestion, gradeMany, recordResult } from '../questions.js';
import { S, save } from '../store.js';
import { segBtn } from './quiz.js';

const opts = { minutes: 30, count: 15, difficulty: 'medium' };
let timer = null;

export function render(root) {
  clearInterval(timer);
  const area = h('div');
  const start = h('button', { class: 'btn primary', onclick: () => begin() }, '시험 시작');
  add(root, 
    pageHead('시험 모드', '제한 시간 안에 모든 유형이 섞인 문제를 풉니다. 시험이 끝나면 한꺼번에 채점하고 결과를 취약점 분석에 반영합니다.'),
    h('div', { class: 'card settings-card' },
      h('div', { class: 'grid-3' },
        field('제한 시간(분)', h('input', { class: 'input', type: 'number', min: 1, max: 180, value: opts.minutes, oninput: (e) => { opts.minutes = Math.max(1, +e.target.value || 1); } })),
        field('문항 수', h('input', { class: 'input', type: 'number', min: 3, max: 40, value: opts.count, oninput: (e) => { opts.count = Math.max(3, Math.min(40, +e.target.value || 3)); } })),
        field('난이도', h('div', { class: 'seg' }, Object.entries(DIFF).map(([k, l]) => segBtn(k, l, () => opts.difficulty, (v) => { opts.difficulty = v; }))))),
      h('p', { class: 'muted small' }, '시간은 문제가 모두 만들어진 뒤부터 잽니다.'),
      h('div', { class: 'row end' }, start)),
    area);
  history(area);

  async function begin() {
    start.disabled = true;
    area.replaceChildren(loadingBox(`시험지 ${opts.count}문항을 만들고 있습니다… (조금 걸릴 수 있습니다)`));
    try {
      const { questions: qs } = await getQuestions({ count: opts.count, typePool: QUIZ_TYPES, difficulty: opts.difficulty, feature: 'exam' });
      runExam(root, area, qs);
    } catch (e) {
      area.replaceChildren(errorBox(e, begin));
      start.disabled = false;
    }
  }
}

function runExam(root, area, qs) {
  root.querySelector('.settings-card')?.remove();
  const views = qs.map((q, i) => renderQuestion(q, { index: i, mode: 'exam' }));
  const end = Date.now() + opts.minutes * 60 * 1000;
  const clock = h('span', { class: 'clock' });
  const submit = h('button', { class: 'btn primary', onclick: async () => { if (await confirmBox('답안을 제출하고 채점할까요?')) finish(); } }, '제출하고 채점');
  const bar = h('div', { class: 'exam-bar' }, h('span', null, `${qs.length}문항`), clock, h('span', { class: 'grow' }), submit);
  const jump = h('nav', { class: 'exam-jump', 'aria-label': '문항 이동' }, views.map((v, i) => h('button', { class: 'jump', onclick: () => v.el.scrollIntoView({ behavior: 'smooth', block: 'start' }) }, String(i + 1))));
  clear(area);
  add(area, bar, jump, ...views.map((v) => v.el));

  let finished = false;
  const tick = () => {
    const left = Math.max(0, end - Date.now());
    const m = Math.floor(left / 60000), s = Math.floor((left % 60000) / 1000);
    clock.textContent = `남은 시간 ${m}:${String(s).padStart(2, '0')}`;
    clock.classList.toggle('urgent', left < 60000);
    if (!document.body.contains(clock)) { clearInterval(timer); return; }
    if (left <= 0) { clearInterval(timer); finish(true); }
  };
  timer = setInterval(tick, 500);
  tick();

  async function finish(timeout = false) {
    if (finished) return;
    finished = true;
    clearInterval(timer);
    const answers = views.map((v) => v.getAnswer());
    const startedLeft = Math.max(0, end - Date.now());
    submit.disabled = true;
    const status = loadingBox(timeout ? '시간이 끝났습니다. 채점하고 있습니다…' : '채점하고 있습니다…');
    bar.after(status);
    let results;
    try {
      results = await gradeMany(qs.map((q, i) => ({ q, a: answers[i] })));
    } catch (e) {
      status.replaceWith(errorBox(e, () => { finished = false; status.remove(); finish(timeout); }));
      return;
    }
    status.remove();
    results.forEach((r, i) => { recordResult(qs[i], answers[i], r, { feature: 'exam' }); views[i].lock(r); });
    const total = results.reduce((a, r) => a + r.score, 0);
    const byType = {};
    qs.forEach((q, i) => { (byType[q.type] ||= { n: 0, s: 0 }); byType[q.type].n++; byType[q.type].s += results[i].score; });
    const summary = { ts: Date.now(), n: qs.length, score: total / qs.length, correct: results.filter((r) => r.correct).length, minutes: opts.minutes, usedSec: Math.round((opts.minutes * 60000 - startedLeft) / 1000), byType };
    S().exams.unshift(summary);
    S().exams = S().exams.slice(0, 50);
    save();
    bar.replaceWith(h('div', { class: 'card exam-result' },
      h('h2', null, `점수 ${Math.round(summary.score * 100)}점`),
      h('p', null, `${qs.length}문항 중 ${summary.correct}문항 정답 · 소요 ${Math.floor(summary.usedSec / 60)}분 ${summary.usedSec % 60}초${timeout ? ' · 시간 종료' : ''}`),
      h('div', { class: 'table-wrap' }, h('table', { class: 'data-table' },
        h('thead', null, h('tr', null, h('th', null, '유형'), h('th', null, '문항'), h('th', null, '득점률'))),
        h('tbody', null, Object.entries(byType).map(([t, v]) => h('tr', null, h('td', null, TYPES[t]), h('td', { class: 'num' }, String(v.n)), h('td', { class: 'num' }, pct(v.s / v.n))))))),
      h('p', { class: 'muted small' }, '틀린 문제는 오답노트에 저장되었고, 결과는 취약점 분석에 반영되었습니다.'),
      h('div', { class: 'row' }, h('a', { class: 'btn', href: '#/wrong' }, '📕 오답노트'), h('a', { class: 'btn', href: '#/dashboard' }, '📊 취약점 분석'), h('button', { class: 'btn primary', onclick: () => render(clear(root)) }, '새 시험'))));
    jump.querySelectorAll('.jump').forEach((b, i) => b.classList.add(results[i].correct ? 'right' : 'wrong'));
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }
}

function history(area) {
  const ex = S().exams;
  if (!ex.length) return;
  area.appendChild(h('div', { class: 'card' }, h('h3', null, '지난 시험'),
    h('div', { class: 'table-wrap' }, h('table', { class: 'data-table' },
      h('thead', null, h('tr', null, h('th', null, '날짜'), h('th', null, '문항'), h('th', null, '정답'), h('th', null, '점수'))),
      h('tbody', null, ex.slice(0, 10).map((e) => h('tr', null, h('td', null, new Date(e.ts).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })), h('td', { class: 'num' }, String(e.n)), h('td', { class: 'num' }, String(e.correct)), h('td', { class: 'num' }, Math.round(e.score * 100) + '점'))))))));
}
