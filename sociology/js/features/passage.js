// 2. 비판적 읽기: 문단 속 바뀐 단어 찾기
import { h, add, clear, pageHead, loadingBox, errorBox, sourceChips, setCurrent, toast } from '../ui.js';
import { askJSON, T, SOURCES } from '../ai.js';
import { findInScope } from '../docs.js';
import { uid, S, pushRecent, recordAttempt, addWrong, markMastered } from '../store.js';
import { openChatAbout } from '../panels.js';

const GEN = T.obj({
  original: T.str,
  modified: T.str,
  changes: T.arr(T.obj({ wrong: T.str, correct: T.str, reason: T.str })),
  sources: SOURCES,
  concepts: T.arr(T.str),
  sociologists: T.arr(T.str),
});
const JUDGE = T.obj({
  judgments: T.arr(T.obj({ line: T.int, change_index: T.int, correction_ok: T.bool, comment: T.str })),
  feedback: T.str,
});

export function render(root) {
  const area = h('div');
  const btn = h('button', { class: 'btn primary', onclick: () => next() }, '새 문단 받기');
  add(root, 
    pageHead('비판적 읽기', '자료의 한 문단에서 일부 단어가 뜻이 틀린 단어로 바뀌어 있을 수 있습니다. 바뀐 단어가 몇 개인지는 알려 주지 않습니다. 찾은 오류를 "틀린 단어 → 올바른 단어" 형식으로 적어 제출하세요.', h('div', { class: 'row' }, btn)),
    area);

  async function next() {
    btn.disabled = true;
    area.replaceChildren(loadingBox('자료에서 문단을 고르고 있습니다…'));
    try {
      const data = await generatePassage();
      area.replaceChildren(renderPassage(data, { onNext: next }));
    } catch (e) {
      area.replaceChildren(errorBox(e, next));
    } finally {
      btn.disabled = false;
    }
  }
  next();
}

async function generatePassage() {
  const n = Math.floor(Math.random() * 5); // 0~4개, 사용자에게 알리지 않는다
  const recent = (S().recent.passage || []).slice(-10);
  for (let attempt = 0; attempt < 3; attempt++) {
    const task = [
      '학습 범위 자료에서 사회학 개념·이론 설명이 담긴 한 문단(150~400자)을 골라 original에 원문 그대로(띄어쓰기 포함, 글자 하나 바꾸지 말고) 옮겨라. 슬라이드 글머리표라면 이어지는 문장들을 문단처럼 이어 붙여도 된다(내용은 그대로).',
      n === 0
        ? '이번에는 단어를 바꾸지 않는다. modified는 original과 완전히 같게, changes는 빈 배열로 둔다.'
        : `original에서 정확히 ${n}개의 단어(또는 짧은 어구)를 뜻이 틀린 다른 단어로 바꿔 modified를 만든다. 바꾼 단어는 문법적으로 자연스러워서 내용을 이해해야만 찾을 수 있어야 한다(예: 기계적↔유기적, 계급↔지위, 증가↔감소, 학자 이름 바꾸기). 바뀐 부분 외에는 original과 글자 하나 다르지 않아야 한다. changes에 각 변경을 {wrong: modified 안의 틀린 단어, correct: original의 원래 단어, reason: 왜 틀린지}로 적는다. 같은 단어를 두 번 바꾸지 않는다.`,
      'sources에 문단 위치를 적는다. concepts, sociologists에 문단이 다루는 개념·학자를 적는다.',
      recent.length && `최근에 쓴 문단과 다른 문단을 고른다: ${recent.join(' / ')}`,
    ].filter(Boolean).join('\n');
    const { data } = await askJSON({ task, schema: GEN });
    const original = String(data.original || '').trim();
    let modified = n === 0 ? original : String(data.modified || '').trim();
    let changes = n === 0 ? [] : (data.changes || []).filter((c) => c.wrong && c.correct && modified.includes(c.wrong) && original.includes(c.correct) && c.wrong !== c.correct);
    if (!original) continue;
    if (n > 0 && (!changes.length || modified === original)) continue;
    const found = findInScope(original);
    if (!found && attempt < 2) continue; // 원문이 자료에 없으면 다시 생성
    pushRecent('passage', original.slice(0, 30));
    return {
      id: uid(), original, modified, changes,
      verified: !!found,
      sources: data.sources?.length ? data.sources : found ? [{ doc: found.doc.tag, page: found.unit.n }] : [],
      concepts: data.concepts || [], sociologists: data.sociologists || [],
    };
  }
  throw new Error('조건에 맞는 문단을 만들지 못했습니다. 다시 시도해 주세요.');
}

function parseLines(text) {
  return text.split(/\n|;/).map((l) => l.trim()).filter(Boolean).map((l) => {
    const m = l.split(/\s*(?:→|->|=>|⇒|>|:)\s*/);
    return { raw: l, wrong: (m[0] || '').trim(), correct: (m.slice(1).join(' ') || '').trim() };
  });
}

// 재사용: 오답노트에서 다시 풀 때도 사용한다.
export function renderPassage(data, { retry = false, onNext, onResult } = {}) {
  const wrap = h('div', { class: 'passage-wrap' });
  const ta = h('textarea', { class: 'input', rows: 6, placeholder: '예)\n유기적 → 기계적\n지위 → 계급' });
  const none = h('input', { type: 'checkbox', onchange: () => { ta.disabled = none.checked; } });
  const submit = h('button', { class: 'btn primary', onclick: () => doSubmit() }, '제출');
  const result = h('div', { 'aria-live': 'polite' });
  const ctx = { kind: 'passage', label: '비판적 읽기 문단', text: `[비판적 읽기] 사용자가 읽고 있는 문단: ${data.modified}` };
  setCurrent(ctx);

  add(wrap, 
    h('div', { class: 'passage-grid' },
      h('div', { class: 'card passage-text' },
        h('div', { class: 'field-label' }, '문단'),
        h('p', { class: 'reading' }, data.modified),
        !data.verified && h('p', { class: 'muted small' }, '⚠ 원문 대조: 자료의 문장과 정확히 일치하는지 확인하지 못했습니다.')),
      h('div', { class: 'card' },
        h('label', { class: 'field' }, h('span', { class: 'field-label' }, '찾은 오류 (한 줄에 하나, 틀린 단어 → 올바른 단어)'), ta),
        h('label', { class: 'check' }, none, h('span', null, '오류 없음')),
        h('div', { class: 'row end' }, submit))),
    result);

  async function doSubmit() {
    const lines = none.checked ? [] : parseLines(ta.value);
    if (!none.checked && !lines.length) return toast('오류를 적거나 [오류 없음]에 체크해 주세요.', 'warn');
    submit.disabled = true;
    result.replaceChildren(loadingBox('의미를 기준으로 채점하고 있습니다…'));
    try {
      const judged = await judge(data, lines);
      const found = data.changes.map((_, i) => judged.judgments.some((j) => j.change_index === i && j.correction_ok));
      const located = data.changes.map((_, i) => judged.judgments.some((j) => j.change_index === i));
      const falseFlags = judged.judgments.filter((j) => j.change_index < 0 || j.change_index >= data.changes.length);
      const nFound = found.filter(Boolean).length;
      const correct = nFound === data.changes.length && !falseFlags.length;
      const score = data.changes.length ? nFound / (data.changes.length + falseFlags.length) : correct ? 1 : 0;

      const q = { id: data.id, type: 'passage', stem: '비판적 읽기: 문단 속 바뀐 단어 찾기', data, concepts: data.concepts, sociologists: data.sociologists, sources: data.sources };
      recordAttempt({ feature: 'passage', type: 'passage', concepts: data.concepts, sociologists: data.sociologists, correct, score });
      if (retry) markMastered(data.id, correct);
      if (!correct) addWrong({ feature: 'passage', q, userAnswer: none.checked ? '오류 없음' : ta.value, feedback: judged.feedback });

      ta.disabled = true; none.disabled = true;
      submit.remove();
      result.replaceChildren(passageResult(data, lines, judged, { found, located, falseFlags, correct, noneChecked: none.checked }),
        h('div', { class: 'row' },
          h('button', { class: 'btn ghost', onclick: () => openChatAbout({ ...ctx, text: ctx.text + `\n원문: ${data.original}\n변경: ${JSON.stringify(data.changes)}` }, '이 문단에서 ') }, '💬 AI에게 질문'),
          onNext && h('button', { class: 'btn primary', onclick: onNext }, '다음 문단')));
      onResult && onResult({ correct, score });
    } catch (e) {
      result.replaceChildren(errorBox(e));
      submit.disabled = false;
    }
  }
  return wrap;
}

async function judge(data, lines) {
  if (!lines.length) return { judgments: [], feedback: data.changes.length ? '바뀐 단어가 있었습니다.' : '정확합니다. 이 문단에는 바뀐 단어가 없었습니다.' };
  if (!data.changes.length) return { judgments: lines.map((_, i) => ({ line: i, change_index: -1, correction_ok: false, comment: '원문과 같은 부분입니다.' })), feedback: '이 문단에는 바뀐 단어가 없었습니다.' };
  const task = [
    '비판적 읽기 답안을 채점하라. 사용자는 변형된 문단에서 틀린 단어를 찾아 "틀린 단어 → 올바른 단어"로 적었다.',
    '각 줄(line, 0부터)마다: 사용자가 지목한 단어가 실제 변경(changes의 인덱스) 중 어느 것인지 change_index로 적는다(표기가 조금 달라도 같은 위치의 같은 단어를 가리키면 인정). 변경이 아닌 곳을 지목했으면 -1.',
    'correction_ok: 사용자가 쓴 올바른 단어가 문맥상 원래 단어와 같은 의미이면 true(정확히 같은 단어일 필요 없음).',
    'comment는 한 문장. feedback은 전체에 대한 2~3문장 조언.',
    JSON.stringify({ original: data.original, modified: data.modified, changes: data.changes, user_lines: lines.map((l, i) => ({ line: i, text: l.raw })) }),
  ].join('\n');
  const { data: out } = await askJSON({ task, schema: JUDGE, material: false, effort: 'low' });
  return out;
}

function passageResult(data, lines, judged, { found, located, falseFlags, correct, noneChecked }) {
  const ops = diffTokens(data.original, data.modified);
  const statusOf = (text, side) => {
    const i = data.changes.findIndex((c) => (side === 'orig' ? text.includes(c.correct) || c.correct.includes(text.trim()) : text.includes(c.wrong) || c.wrong.includes(text.trim())));
    if (i < 0) return 'missed';
    return found[i] ? 'found' : located[i] ? 'located' : 'missed';
  };
  const side = (which) => h('p', { class: 'reading' }, ops.map((op) => {
    if (op.t === 'eq') return op.s;
    if (which === 'orig' && op.t === 'del') return h('mark', { class: 'chg ' + statusOf(op.s, 'orig') }, op.s);
    if (which === 'mod' && op.t === 'ins') return h('mark', { class: 'chg ' + statusOf(op.s, 'mod') }, op.s);
    return null;
  }));

  return h('div', { class: 'card passage-result ' + (correct ? 'right' : 'wrong') },
    h('div', { class: 'result-head' }, h('strong', null, correct ? '✔ 완벽합니다' : '✘ 아쉬워요'),
      h('span', null, `바뀐 단어 ${data.changes.length}개 중 ${found.filter(Boolean).length}개 찾음 · 잘못 지목 ${falseFlags.length}개`),
      !correct && h('span', { class: 'muted small' }, '오답노트에 저장됨')),
    h('div', { class: 'legend' },
      h('span', null, h('mark', { class: 'chg found' }, '찾음')),
      h('span', null, h('mark', { class: 'chg located' }, '위치만 맞음')),
      h('span', null, h('mark', { class: 'chg missed' }, '놓침')),
      h('span', null, h('mark', { class: 'chg flag' }, '잘못 지목'))),
    h('div', { class: 'compare' },
      h('div', null, h('div', { class: 'field-label' }, '원문'), side('orig')),
      h('div', null, h('div', { class: 'field-label' }, '변형된 문단'), side('mod'))),
    data.changes.length ? h('ul', { class: 'change-list' }, data.changes.map((c, i) => h('li', { class: found[i] ? 'found' : located[i] ? 'located' : 'missed' },
      h('b', null, `${c.wrong} → ${c.correct}`), ` ${found[i] ? '찾음' : located[i] ? '위치는 맞았지만 고친 단어가 다름' : '놓침'} · ${c.reason}`))) : h('p', null, '이 문단에는 바뀐 단어가 없었습니다.' + (noneChecked ? ' [오류 없음] 판단이 맞았습니다.' : '')),
    falseFlags.length ? h('div', { class: 'feedback' }, h('b', null, '잘못 지목한 부분'), h('ul', null, falseFlags.map((j) => h('li', null, h('mark', { class: 'chg flag' }, lines[j.line]?.raw || ''), ' ', j.comment)))) : null,
    judged.feedback && h('div', { class: 'feedback' }, h('b', null, 'AI 피드백 '), judged.feedback),
    sourceChips(data.sources));
}

// 공백을 보존하는 토큰 단위 LCS 비교
export function diffTokens(a, b) {
  const A = a.match(/\s+|[^\s]+/g) || [];
  const B = b.match(/\s+|[^\s]+/g) || [];
  const n = A.length, m = B.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const ops = [];
  let i = 0, j = 0;
  const push = (t, s) => { const last = ops[ops.length - 1]; if (last && last.t === t) last.s += s; else ops.push({ t, s }); };
  while (i < n && j < m) {
    if (A[i] === B[j]) { push('eq', A[i]); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { push('del', A[i]); i++; }
    else { push('ins', B[j]); j++; }
  }
  while (i < n) push('del', A[i++]);
  while (j < m) push('ins', B[j++]);
  return ops;
}
