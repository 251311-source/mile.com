// 10. 이론 비판하기
import { h, add, pageHead, loadingBox, errorBox, sourceChips, setCurrent, toast } from '../ui.js';
import { askJSON, T, SOURCES } from '../ai.js';
import { S, uid, pushRecent, recordAttempt, addWrong } from '../store.js';
import { openChatAbout } from '../panels.js';

const THEORY = T.obj({ theory: T.str, sociologist: T.str, summary: T.str, sources: SOURCES });
const FEEDBACK = T.obj({
  score: T.num,
  matched: T.arr(T.obj({ critique: T.str, comment: T.str })),
  missed: T.arr(T.obj({ critique: T.str, critics: T.str, in_materials: T.bool, sources: SOURCES })),
  original_points: T.arr(T.obj({ point: T.str, comment: T.str })),
  feedback: T.str,
  improve: T.str,
});

export function render(root) {
  const area = h('div');
  const go = h('button', { class: 'btn primary', onclick: () => run() }, '다른 이론');
  add(root, pageHead('이론 비판하기', '학습 범위의 이론 하나를 제시합니다. 그 이론의 한계나 반론을 써 보세요. AI가 학계에서 실제로 제기된 비판과 비교해 피드백합니다.', h('div', { class: 'row' }, go)), area);

  async function run() {
    go.disabled = true;
    area.replaceChildren(loadingBox('이론을 고르고 있습니다…'));
    try {
      const recent = S().recent.critique || [];
      const { data } = await askJSON({ schema: THEORY, task: [
        '학습 범위 자료에서 비판적으로 검토할 만한 이론 하나를 골라라.',
        '- theory: 이론 이름, sociologist: 대표 학자, summary: 자료에 근거한 이론의 핵심 내용 4~6문장(비판은 쓰지 않는다), sources: 자료 위치.',
        recent.length && `- 최근에 다룬 이론은 제외: ${recent.join(', ')}`,
      ].filter(Boolean).join('\n') });
      if (!data.theory) throw new Error('이론을 고르지 못했습니다.');
      pushRecent('critique', data.theory, 10);
      area.replaceChildren(view({ ...data, id: uid() }, run));
    } catch (e) {
      area.replaceChildren(errorBox(e, run));
    } finally {
      go.disabled = false;
    }
  }
  run();
}

function view(t, again) {
  const ta = h('textarea', { class: 'input', rows: 9, placeholder: '이 이론의 한계, 설명하지 못하는 현상, 전제의 문제, 반론 등을 써 보세요.' });
  const submit = h('button', { class: 'btn primary', onclick: () => send() }, '피드백 받기');
  const result = h('div', { 'aria-live': 'polite' });
  const ctx = { kind: 'critique', label: `이론 비판: ${t.theory}`, text: `[이론 비판] ${t.theory}(${t.sociologist})\n${t.summary}` };
  setCurrent(ctx);

  async function send() {
    const answer = ta.value.trim();
    if (answer.length < 20) return toast('비판을 조금 더 자세히 써 주세요.', 'warn');
    submit.disabled = true;
    result.replaceChildren(loadingBox('학계의 비판과 비교하고 있습니다…'));
    try {
      const { data: f } = await askJSON({ schema: FEEDBACK, task: [
        `학습자가 "${t.theory}"(${t.sociologist})에 대한 비판을 썼다. 학계에서 실제로 제기된 대표적 비판들과 비교해 피드백하라.`,
        '- 이 과제는 학계의 비판(자료 밖 지식)을 쓰는 것이 허용된다. 단, 각 비판이 학습 자료에 나오는지 in_materials로 정확히 표시하고, 자료에 나오면 sources에 위치를 적는다. 자료에 없으면 sources는 비운다.',
        '- 실제로 제기된 비판만 쓴다. 비판한 학자/학파를 확실히 알 때만 critics에 적고, 불확실하면 "일반적 비판"이라고 쓴다.',
        '- matched: 학습자의 비판 중 학계 비판과 겹치는 것과 그 평가. missed: 학습자가 놓친 주요 비판(3~5개). original_points: 학계 비판 목록에는 없지만 타당한 학습자 고유의 논점.',
        '- score: 0~100. feedback: 종합 평가 3~4문장. improve: 비판을 더 날카롭게 만드는 방법.',
        JSON.stringify({ theory: t.theory, summary: t.summary, answer }),
      ].join('\n') });
      const score = Math.max(0, Math.min(100, Number(f.score) || 0));
      const ok = score >= 60;
      recordAttempt({ feature: 'critique', type: 'critique', concepts: [t.theory], sociologists: [t.sociologist], correct: ok, score: score / 100 });
      if (!ok) addWrong({ feature: 'critique', userAnswer: answer, feedback: f.feedback, q: {
        id: t.id, type: 'essay', stem: `${t.theory}(${t.sociologist})의 한계나 반론을 서술하시오.`, context: t.summary, options: [], accept: [],
        rubric: [{ criterion: '핵심 비판 제시', points: 6, key_elements: (f.missed || []).map((m) => m.critique).concat((f.matched || []).map((m) => m.critique)) }, { criterion: '논리적 근거', points: 4, key_elements: [] }],
        model_answer: (f.missed || []).concat(f.matched || []).map((m) => '· ' + m.critique).join('\n'),
        explanation: f.feedback, sources: t.sources, concepts: [t.theory], sociologists: [t.sociologist],
      } });
      ctx.text += `\n학습자 비판: ${answer}\n피드백: ${f.feedback}`;
      ta.readOnly = true;
      submit.remove();
      const ext = h('span', { class: 'tag external' }, '자료 외');
      result.replaceChildren(h('div', { class: 'result ' + (ok ? 'right' : 'wrong') },
        h('div', { class: 'result-head' }, h('strong', null, '피드백'), h('span', { class: 'score' }, `${score}점`), !ok && h('span', { class: 'muted small' }, '오답노트에 저장됨')),
        h('div', { class: 'feedback' }, f.feedback),
        f.matched?.length ? h('div', { class: 'feedback' }, h('b', null, '✔ 학계 비판과 겹치는 논점'), h('ul', null, f.matched.map((m) => h('li', null, h('b', null, m.critique), ' — ', m.comment)))) : null,
        f.original_points?.length ? h('div', { class: 'feedback' }, h('b', null, '✦ 학습자 고유의 타당한 논점'), h('ul', null, f.original_points.map((m) => h('li', null, h('b', null, m.point), ' — ', m.comment)))) : null,
        f.missed?.length ? h('div', { class: 'feedback' }, h('b', null, '놓친 주요 비판'), h('ul', null, f.missed.map((m) => h('li', null,
          h('b', null, m.critique), m.critics ? ` (${m.critics}) ` : ' ',
          m.in_materials ? sourceChips(m.sources, { label: '자료' }) : ext.cloneNode(true))))) : null,
        f.improve && h('div', { class: 'feedback' }, h('b', null, '개선 방법 '), f.improve),
        h('p', { class: 'muted small' }, '「자료 외」 표시는 업로드한 자료에 없는, 학계의 일반적 비판에 근거한 내용입니다.'),
        h('div', { class: 'row' }, h('button', { class: 'btn ghost', onclick: () => openChatAbout(ctx, '이 이론의 비판에 대해 ') }, '💬 AI에게 질문'), h('button', { class: 'btn primary', onclick: again }, '다른 이론'))));
    } catch (e) {
      result.replaceChildren(errorBox(e));
      submit.disabled = false;
    }
  }

  return h('div', null,
    h('article', { class: 'card' },
      h('div', { class: 'qmeta' }, h('span', { class: 'tag' }, '이론'), t.sociologist && h('span', { class: 'tag soft' }, t.sociologist)),
      h('h2', null, t.theory),
      h('p', { class: 'reading' }, t.summary),
      sourceChips(t.sources)),
    h('div', { class: 'card' }, h('p', { class: 'qstem' }, '이 이론의 한계나 반론은 무엇일까요?'), ta, h('div', { class: 'row end' }, submit)),
    result);
}
