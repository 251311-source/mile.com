// 문제 신고: 즉시 제외 → 오답·통계에서 빼기 → AI 재검토 → 수정본 저장 또는 신고 취소/그래도 제외
import { h, modal, toast, loadingBox, sourceChips } from './ui.js';
import { askJSON, T, SOURCES } from './ai.js';
import { S, save, uid, bankEntry, detachRecords, reattachRecords } from './store.js';
import { saveToBank, setBankStatus } from './bank.js';
import { Q_SCHEMA, normalize, answerText, questionSummary, TYPES } from './questions.js';

export const REASONS = { wrong_answer: '정답 오류', no_basis: '근거 없음/자료와 다름', ambiguous: '문제가 애매함', other: '기타' };
export const STATUS = { reviewing: '검토 중', corrected: '수정됨', valid: '검토 결과 문제 없음(결정 대기)', cancelled: '신고 취소', excluded: '제외됨', failed: '검토 실패' };

export const isReported = (qid) => S().reports.some((r) => r.qid === qid && r.status !== 'cancelled');

export function reportButton(q, opts = {}) {
  const btn = h('button', { class: 'btn ghost report-btn', onclick: () => openReport(q, { ...opts, btn }) }, '🚩 문제 신고');
  if (isReported(q.id)) { btn.disabled = true; btn.textContent = '🚩 신고됨'; }
  return btn;
}

function openReport(q, { feature, btn }) {
  let reason = null;
  const detail = h('textarea', { class: 'input', rows: 3, placeholder: '신고 이유를 적어 주세요.', hidden: true });
  const radios = Object.entries(REASONS).map(([k, l]) => h('label', { class: 'opt' },
    h('input', { type: 'radio', name: 'report-reason', value: k, onchange: () => { reason = k; detail.hidden = k !== 'other'; if (k === 'other') detail.focus(); } }),
    h('span', null, k === 'other' ? '기타(직접 입력)' : l)));
  modal('문제 신고', h('div', null,
    h('p', { class: 'muted small' }, '신고한 문제는 바로 다음 퀴즈에서 빠지고, 이 문제로 생긴 오답 기록과 정답률 통계도 제외됩니다. AI가 신고 이유를 바탕으로 문제를 다시 검토합니다.'),
    h('div', { class: 'options' }, radios),
    detail), [
    { label: '취소', onclick: () => {} },
    { label: '신고하기', primary: true, onclick: () => {
      if (!reason) { toast('신고 이유를 골라 주세요.', 'warn'); return false; }
      if (reason === 'other' && !detail.value.trim()) { toast('기타 이유를 적어 주세요.', 'warn'); return false; }
      const r = fileReport(q, { feature, reason, detail: detail.value.trim() });
      if (btn) { btn.disabled = true; btn.textContent = '🚩 신고됨'; }
      showReview(r);
      return true;
    } },
  ]);
}

export function fileReport(q, { feature, reason, detail }) {
  const kind = q.type === 'passage' ? 'passage' : 'quiz';
  if (!bankEntry(q.id)) saveToBank(q, { feature, kind });
  setBankStatus(q.id, 'reported');
  const removed = detachRecords(q.id);
  // 발화자 맞히기 인용은 인용 목록에서도 뺀다
  let removedQuote = null;
  for (const [key, b] of Object.entries(S().quoteBank)) {
    const i = (b.quotes || []).findIndex((x) => x.id === q.id);
    if (i >= 0) { removedQuote = { key, quote: b.quotes.splice(i, 1)[0] }; break; }
  }
  const r = { id: uid(), qid: q.id, q, feature, reason, detail, ts: Date.now(), updatedAt: Date.now(), status: 'reviewing', review: null, correctedId: null, removed, removedQuote };
  S().reports.unshift(r);
  save();
  return r;
}

// questions.js와 서로 import하므로 스키마는 사용할 때 만든다.
const reviewQuiz = () => T.obj({ verdict: T.oneOf('flawed', 'valid'), explanation: T.str, sources: SOURCES, corrected: Q_SCHEMA });
const reviewPassage = () => T.obj({
  verdict: T.oneOf('flawed', 'valid'), explanation: T.str, sources: SOURCES,
  corrected: T.obj({ original: T.str, modified: T.str, changes: T.arr(T.obj({ wrong: T.str, correct: T.str, reason: T.str })) }),
});

export async function runReview(r) {
  const passage = r.q.type === 'passage';
  const payload = passage
    ? { original: r.q.data.original, modified: r.q.data.modified, changes: r.q.data.changes, sources: r.q.data.sources }
    : (({ id, verified, ...rest }) => rest)(r.q);
  const task = [
    `학습자가 아래 문제를 "${REASONS[r.reason]}" 이유로 신고했다.${r.detail ? ` 학습자 설명: ${r.detail}` : ''}`,
    '학습 자료와 직접 대조해 문제를 다시 검토하라. 신고 내용이 맞는지 편견 없이 판단한다.',
    '- 문제가 실제로 잘못되었으면(정답 오류, 자료와 다름, 애매함 등) verdict는 "flawed". explanation에 무엇이 잘못되었는지 쓰고, corrected에 고친 문제 전체를 같은 형식으로 쓴다(근거 sources 포함).',
    passage
      ? '- corrected는 원문(original, 자료 그대로), 변형 문단(modified), 바뀐 단어 목록(changes)을 바르게 고친 것이다.'
      : '- corrected는 같은 유형(type)의 문제이며 정답·해설·sources까지 모두 고친 것이다. 사용하지 않는 필드는 빈 값.',
    '- 문제가 맞으면 verdict는 "valid". explanation에 왜 맞는지 자료 근거로 설명하고 sources에 근거 쪽을 적는다. 이때 corrected는 원래 문제를 그대로 적는다.',
    JSON.stringify(payload),
  ].join('\n');
  r.status = 'reviewing';
  save();
  try {
    const { data } = await askJSON({ task, schema: passage ? reviewPassage() : reviewQuiz(), effort: 'medium' });
    r.review = { verdict: data.verdict, explanation: data.explanation, sources: data.sources || [] };
    if (data.verdict === 'flawed') {
      const fixed = passage ? fixPassage(r.q, data.corrected) : normalize(data.corrected, r.q.difficulty);
      if (fixed) {
        fixed.verified = true;
        saveToBank(fixed, { feature: r.feature, kind: passage ? 'passage' : 'quiz', correctedFrom: r.qid });
        r.correctedId = fixed.id;
        r.corrected = fixed;
        r.status = 'corrected';
      } else {
        r.status = 'excluded';
      }
      setBankStatus(r.qid, 'excluded');
    } else {
      r.status = 'valid';
    }
  } catch (e) {
    r.status = 'failed';
    r.error = e.message;
  }
  r.updatedAt = Date.now();
  save();
  return r;
}

function fixPassage(old, c) {
  if (!c?.original || !c?.modified) return null;
  const changes = (c.changes || []).filter((x) => x.wrong && x.correct && c.modified.includes(x.wrong));
  const data = { ...old.data, id: uid(), original: c.original, modified: c.modified, changes };
  return { ...old, id: data.id, data };
}

export function cancelReport(r) {
  setBankStatus(r.qid, 'active');
  reattachRecords(r.removed);
  if (r.removedQuote) S().quoteBank[r.removedQuote.key]?.quotes.push(r.removedQuote.quote);
  r.status = 'cancelled';
  r.updatedAt = Date.now();
  save();
}
export function excludeAnyway(r) {
  setBankStatus(r.qid, 'excluded');
  r.status = 'excluded';
  r.updatedAt = Date.now();
  save();
}

// 재검토 결과 창
export async function showReview(r, onChange) {
  const body = h('div', { class: 'review-body' }, loadingBox('AI가 신고 내용을 바탕으로 문제를 다시 검토하고 있습니다…'));
  const close = modal('신고 검토 결과', body);
  if (r.status === 'reviewing' || r.status === 'failed') await runReview(r);
  body.replaceChildren(reviewView(r, () => { close(); onChange && onChange(); }));
  onChange && onChange();
}

export function reviewView(r, done) {
  const head = h('div', { class: 'notice' }, h('b', null, '신고 접수 '), `${REASONS[r.reason]}${r.detail ? ' — ' + r.detail : ''}. 이 문제는 앞으로 출제되지 않으며, 오답노트와 정답률에서 제외했습니다.`);
  if (r.status === 'failed') {
    return h('div', null, head, h('div', { class: 'notice error' }, '재검토에 실패했습니다: ' + (r.error || '')), h('p', { class: 'muted small' }, '[설정 → 신고한 문제 목록]에서 다시 검토할 수 있습니다.'));
  }
  const rv = r.review || {};
  if (r.status === 'corrected' || (rv.verdict === 'flawed')) {
    const c = r.corrected;
    return h('div', null, head,
      h('div', { class: 'result wrong' }, h('div', { class: 'result-head' }, h('strong', null, '검토 결과: 문제에 오류가 있었습니다')), h('p', null, rv.explanation), sourceChips(rv.sources, { label: '근거' })),
      c ? correctedView(c) : h('p', { class: 'muted' }, '고친 문제를 만들지 못해 이 문제는 제외했습니다.'),
      c && h('p', { class: 'muted small' }, '수정된 문제는 「검증됨」으로 문제 은행에 저장되어 다음 퀴즈부터 출제됩니다.'));
  }
  if (r.status === 'valid') {
    return h('div', null, head,
      h('div', { class: 'result right' }, h('div', { class: 'result-head' }, h('strong', null, '검토 결과: 문제에 오류가 없습니다')), h('p', null, rv.explanation), sourceChips(rv.sources, { label: '근거' })),
      h('div', { class: 'row end' },
        h('button', { class: 'btn', onclick: () => { cancelReport(r); toast('신고를 취소했습니다. 기록을 되돌렸습니다.'); done(); } }, '신고 취소'),
        h('button', { class: 'btn primary', onclick: () => { excludeAnyway(r); toast('이 문제를 제외했습니다.'); done(); } }, '그래도 제외')));
  }
  return h('div', null, head, h('p', null, STATUS[r.status] || r.status), rv.explanation && h('p', null, rv.explanation), sourceChips(rv.sources, { label: '근거' }));
}

function correctedView(c) {
  if (c.type === 'passage') {
    return h('div', { class: 'card' }, h('div', { class: 'field-label' }, '수정된 문단'),
      h('p', { class: 'reading' }, c.data.modified),
      h('ul', { class: 'change-list' }, c.data.changes.map((x) => h('li', null, h('b', null, `${x.wrong} → ${x.correct}`), ' ', x.reason))),
      h('div', { class: 'field-label' }, '원문'), h('p', { class: 'reading muted' }, c.data.original),
      sourceChips(c.data.sources));
  }
  return h('div', { class: 'card' },
    h('div', { class: 'qmeta' }, h('span', { class: 'tag' }, TYPES[c.type]), h('span', { class: 'tag label-verified' }, '검증됨(수정본)')),
    h('pre', { class: 'qstem' }, questionSummary(c).replace(/^\[[^\]]+\]\s*/, '')),
    h('div', { class: 'kv' }, h('span', null, '정답'), h('pre', null, answerText(c))),
    c.explanation && h('div', { class: 'explain' }, h('b', null, '해설 '), c.explanation),
    sourceChips(c.sources));
}

export const reportedLabel = (r) => STATUS[r.status] || r.status;

