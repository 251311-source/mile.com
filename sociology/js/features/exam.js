// 13. 시험 모드
import { h, add, clear, pageHead, field, loadingBox, errorBox, pct, confirmBox } from '../ui.js';
import { QUIZ_TYPES, TYPES, DIFF, getQuestions, renderQuestion, gradeMany, recordResult } from '../questions.js';
import { S, save } from '../store.js';
import { segBtn } from './quiz.js';
import { persistentArea, runJob, jobControls, isCancel, isRunning } from '../jobs.js';

const opts = { minutes: 30, count: 15, difficulty: 'medium' };
let timer = null;

let pendingQs = null; // 다른 화면에 있는 동안 준비된 시험지(타이머는 돌아와서 시작할 때부터)

export function render(root) {
  const area = persistentArea('exam');
  // 진행 중인 시험이 있으면 그대로 이어서 보여 준다(타이머도 계속 흐름)
  if (area.querySelector('.exam-bar')) { add(root, pageHead('시험 모드', null), area); return; }
  const start = jobControls('exam', { start: () => begin(), label: '시험 시작', running: '시험지를 만드는 중… 다른 화면에 다녀와도 계속 만들어요.' });
  const past = h('div');
  add(root,
    pageHead('시험 모드', '제한 시간 안에 모든 유형이 섞인 문제를 풉니다. 시험이 끝나면 한꺼번에 채점하고 결과를 취약점 분석에 반영합니다.'),
    h('div', { class: 'card settings-card' },
      h('div', { class: 'grid-3' },
        field('제한 시간(분)', h('input', { class: 'input', type: 'number', min: 1, max: 180, value: opts.minutes, oninput: (e) => { opts.minutes = Math.max(1, +e.target.value || 1); } })),
        field('문항 수', h('input', { class: 'input', type: 'number', min: 3, max: 40, value: opts.count, oninput: (e) => { opts.count = Math.max(3, Math.min(40, +e.target.value || 3)); } })),
        field('난이도', h('div', { class: 'seg' }, Object.entries(DIFF).map(([k, l]) => segBtn(k, l, () => opts.difficulty, (v) => { opts.difficulty = v; }))))),
      h('p', { class: 'muted small' }, '시간은 시험지가 모두 만들어지고 시작할 때부터 잽니다.'),
      h('div', { class: 'row end' }, start)),
    area, past);
  history(past);
  if (pendingQs) showReady();
  else if (!isRunning('exam') && !area.querySelector('.exam-result')) area.replaceChildren();

  function showReady() {
    area.replaceChildren(h('div', { class: 'card center' },
      h('h2', null, `시험지 ${pendingQs.length}문항이 준비됐어요`),
      h('p', { class: 'muted' }, `[지금 시작]을 누르면 ${opts.minutes}분 타이머가 시작됩니다.`),
      h('button', { class: 'btn primary', onclick: () => { const qs = pendingQs; pendingQs = null; runExam(area, qs); } }, '지금 시작')));
  }

  function begin() {
    runJob('exam', { label: '시험지', page: 'exam' }, async (signal) => {
      area.replaceChildren(loadingBox(`시험지 ${opts.count}문항을 만들고 있습니다… (조금 걸릴 수 있습니다)`));
      try {
        let ready = 0;
        const onReady = (list) => { ready += list.length; const t = area.querySelector('.loading span:last-child'); if (t) t.textContent = `시험지를 만들고 있습니다… (${Math.min(ready, opts.count)}/${opts.count}문항 준비됨)`; };
        const { questions: qs } = await getQuestions({ count: opts.count, typePool: QUIZ_TYPES, difficulty: opts.difficulty, feature: 'exam', onReady, signal });
        // 이 화면을 보고 있으면 바로 시작, 다른 화면에 있으면 돌아와서 시작하도록 대기
        if (area.isConnected) runExam(area, qs);
        else { pendingQs = qs; area.replaceChildren(); }
      } catch (e) {
        area.replaceChildren(isCancel(e) ? h('div', { class: 'notice' }, '생성을 취소했어요.') : errorBox(e, begin));
        throw e;
      }
    });
  }
}

function runExam(area, qs) {
  document.querySelector('[data-page="exam"] .settings-card')?.remove();
  document.querySelector('[data-page="exam"] .exam-history')?.remove();
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
      h('div', { class: 'row' }, h('a', { class: 'btn', href: '#/wrong' }, '📕 오답노트'), h('a', { class: 'btn', href: '#/dashboard' }, '📊 취약점 분석'), h('button', { class: 'btn primary', onclick: () => { area.replaceChildren(); window.dispatchEvent(new HashChangeEvent('hashchange')); } }, '새 시험'))));
    jump.querySelectorAll('.jump').forEach((b, i) => b.classList.add(results[i].correct ? 'right' : 'wrong'));
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }
}

function history(area) {
  const ex = S().exams;
  if (!ex.length) return;
  area.appendChild(h('div', { class: 'card exam-history' }, h('h3', null, '지난 시험'),
    h('div', { class: 'table-wrap' }, h('table', { class: 'data-table' },
      h('thead', null, h('tr', null, h('th', null, '날짜'), h('th', null, '문항'), h('th', null, '정답'), h('th', null, '점수'))),
      h('tbody', null, ex.slice(0, 10).map((e) => h('tr', null, h('td', null, new Date(e.ts).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })), h('td', { class: 'num' }, String(e.n)), h('td', { class: 'num' }, String(e.correct)), h('td', { class: 'num' }, Math.round(e.score * 100) + '점'))))))));
}
