// 7. 자동 오답노트
import { h, add, clear, pageHead, loadingBox, errorBox, fmtDate, confirmBox, select, toast } from '../ui.js';
import { TYPES, renderQuestion, answerText, userAnswerText, generateQuestions } from '../questions.js';
import { S, removeWrong } from '../store.js';
import { hasScope } from '../docs.js';
import { renderPassage } from './passage.js';
import { showSet } from './quiz.js';

const FEATURE = { quiz: '종합 퀴즈', passage: '비판적 읽기', speaker: '발화자 맞히기', concept: '개념 맞히기', realworld: '현실 사례', critique: '이론 비판', cards: '플래시카드', exam: '시험 모드', similar: '유사 문제' };
const filt = { status: 'open', feature: 'all', q: '' };

export function render(root) {
  const list = h('div', { class: 'wrong-list' });
  const work = h('div');
  const counts = () => ({ open: S().wrong.filter((w) => !w.mastered).length, done: S().wrong.filter((w) => w.mastered).length });
  const head = h('div', { class: 'row wrap' });
  add(root, pageHead('오답노트', '모든 기능에서 틀린 문제가 자동으로 모입니다. 다시 풀어 맞히면 「완전 정복」으로 표시됩니다.'), head, work, list);

  const drawHead = () => {
    const c = counts();
    clear(head);
    add(head, 
      h('div', { class: 'seg' }, [['open', `복습 필요 ${c.open}`], ['done', `완전 정복 ${c.done}`], ['all', '전체']].map(([k, l]) =>
        h('button', { class: filt.status === k ? 'on' : '', onclick: () => { filt.status = k; drawHead(); drawList(); } }, l))),
      select([['all', '모든 기능'], ...Object.entries(FEATURE)], filt.feature, (v) => { filt.feature = v; drawList(); }),
      h('input', { class: 'input', type: 'search', placeholder: '개념·학자 검색', value: filt.q, oninput: (e) => { filt.q = e.target.value; drawList(); } }),
      h('span', { class: 'grow' }),
      h('button', { class: 'btn primary', disabled: !c.open, onclick: () => retryAll() }, '🔁 틀린 문제만 다시 풀기'));
  };

  const filtered = () => S().wrong.filter((w) => {
    if (filt.status === 'open' && w.mastered) return false;
    if (filt.status === 'done' && !w.mastered) return false;
    if (filt.feature !== 'all' && w.feature !== filt.feature) return false;
    if (filt.q) {
      const hay = [w.q?.stem, ...(w.q?.concepts || []), ...(w.q?.sociologists || [])].join(' ');
      if (!hay.includes(filt.q)) return false;
    }
    return true;
  });

  const drawList = () => {
    clear(list);
    const items = filtered();
    if (!items.length) { list.appendChild(h('p', { class: 'muted empty' }, filt.status === 'open' ? '복습할 오답이 없습니다. 👏' : '항목이 없습니다.')); return; }
    items.forEach((w) => list.appendChild(entry(w)));
  };

  const entry = (w) => {
    const q = w.q;
    const isPassage = q.type === 'passage';
    return h('article', { class: 'wrong-item' + (w.mastered ? ' mastered' : '') },
      h('div', { class: 'qmeta' },
        w.mastered ? h('span', { class: 'tag label-verified' }, '✔ 완전 정복') : h('span', { class: 'tag label-unverified' }, '복습 필요'),
        h('span', { class: 'tag' }, TYPES[q.type] || q.type),
        h('span', { class: 'tag soft' }, FEATURE[w.feature] || w.feature),
        (q.concepts || []).slice(0, 2).map((c) => h('span', { class: 'tag ghost' }, c)),
        h('span', { class: 'grow' }),
        h('span', { class: 'muted small' }, `${fmtDate(w.ts)} · 시도 ${w.tries || 1}회`)),
      h('p', { class: 'wrong-stem' }, isPassage ? '비판적 읽기 문단: ' + q.data.modified.slice(0, 90) + '…' : q.stem),
      !isPassage && h('details', null, h('summary', null, '내 답과 정답 보기'),
        h('div', { class: 'kv' }, h('span', null, '내 답'), h('pre', null, userAnswerText(q, w.userAnswer))),
        h('div', { class: 'kv' }, h('span', null, '정답'), h('pre', null, answerText(q))),
        w.feedback && h('p', { class: 'muted' }, w.feedback)),
      h('div', { class: 'row wrap' },
        h('button', { class: 'btn small', onclick: () => retry([w]) }, '다시 풀기'),
        !isPassage && hasScope() && h('button', { class: 'btn small', onclick: () => similar(w) }, '유사 문제 만들기'),
        h('button', { class: 'btn small ghost', onclick: async () => { if (await confirmBox('이 오답을 삭제할까요?')) { removeWrong(w.id); drawHead(); drawList(); } } }, '삭제')));
  };

  function retry(entries) {
    clear(work);
    const close = h('button', { class: 'btn ghost', onclick: () => { clear(work); drawHead(); drawList(); } }, '닫기');
    work.appendChild(h('div', { class: 'row' }, h('h2', { class: 'grow' }, `다시 풀기 (${entries.length}문제)`), close));
    const passages = entries.filter((w) => w.q.type === 'passage');
    const others = entries.filter((w) => w.q.type !== 'passage');
    const box = h('div');
    work.appendChild(box);
    if (others.length) showSet(box, others.map((w) => w.q), { feature: others[0].feature, retry: true, onDone: () => { toast('다시 풀기 완료! 맞힌 문제는 완전 정복으로 표시했습니다.'); drawHead(); drawList(); } });
    passages.forEach((w) => box.appendChild(renderPassage(w.q.data, { retry: true, onResult: () => { drawHead(); drawList(); } })));
    work.scrollIntoView({ behavior: 'smooth' });
  }
  function retryAll() {
    const open = S().wrong.filter((w) => !w.mastered);
    retry(open.slice(0, 20));
    if (open.length > 20) toast(`한 번에 20문제씩 다시 풉니다. (남은 오답 ${open.length - 20}개)`);
  }
  async function similar(w) {
    clear(work);
    work.appendChild(loadingBox('같은 개념을 묻는 새 문제를 만들고 있습니다…'));
    work.scrollIntoView({ behavior: 'smooth' });
    try {
      const { id, ...shape } = w.q;
      const qs = await generateQuestions({ types: [w.q.type, w.q.type], difficulty: w.q.difficulty || 'medium', focus: (w.q.concepts || []).join(', '), similarTo: { stem: shape.stem, concepts: shape.concepts, type: shape.type } });
      clear(work);
      work.appendChild(h('div', { class: 'row' }, h('h2', { class: 'grow' }, '유사 문제'), h('button', { class: 'btn ghost', onclick: () => clear(work) }, '닫기')));
      const box = h('div');
      work.appendChild(box);
      showSet(box, qs, { feature: 'similar' });
    } catch (e) {
      work.replaceChildren(errorBox(e, () => similar(w)));
    }
  }

  drawHead();
  drawList();
}
