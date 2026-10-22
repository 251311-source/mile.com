// 문제 생성·렌더링·채점 공통 엔진. 종합 퀴즈, 시험 모드, 오답노트가 함께 쓴다.
import { askJSON, T, SOURCES } from './ai.js';
import { h, clear, CIRC, shuffle, sourceChips, setCurrent, loadingBox } from './ui.js';
import { uid, recordAttempt, addWrong, markMastered } from './store.js';
import { openChatAbout } from './panels.js';
import { verifyItems } from './verify.js';
import { pickFromBank, existingStems, isNearDuplicate, bankQuizQuestions, saveToBank } from './bank.js';
import { reportButton } from './report.js';
import { CancelledError } from './jobs.js';

export const TYPES = {
  mc: '5지선다',
  short: '단답형',
  blank: '빈칸 채우기',
  ox: 'O/X',
  select_correct: '옳은 것 고르기',
  select_incorrect: '옳지 않은 것 고르기',
  combo: '<보기> 고르기',
  matching: '연결하기',
  ordering: '순서 배열',
  case: '사례 적용',
  table: '비교표 채우기',
  essay: '서술형',
  passage: '비판적 읽기',
};
export const QUIZ_TYPES = Object.keys(TYPES).filter((t) => t !== 'passage');
export const DIFF = { easy: '쉬움', medium: '보통', hard: '어려움' };
const LABELS = ['ㄱ', 'ㄴ', 'ㄷ', 'ㄹ', 'ㅁ'];

const TYPE_SPEC = {
  mc: 'mc(5지선다): options 정확히 5개, 정답은 하나, answer_index는 0~4.',
  short: 'short(단답형): 한 단어나 짧은 구로 답한다. answer_text에 정답, accept에 같은 뜻의 다른 표기(원어, 동의어)를 넣는다.',
  blank: 'blank(빈칸 채우기): stem 안의 빈칸을 (①), (②)처럼 표시한다(1~3개). blanks에 빈칸 순서대로 {answer, accept}를 넣는다. 자료의 핵심 문장을 바탕으로 한다.',
  ox: 'ox(O/X): stem은 하나의 진술문이다. ox에 "O" 또는 "X". 해설에 왜 그런지 쓴다.',
  select_correct: 'select_correct(옳은 것 고르기): stem은 "~에 대한 설명으로 옳은 것은?" 형태, options 5개 중 옳은 것 하나, answer_index.',
  select_incorrect: 'select_incorrect(옳지 않은 것 고르기): stem은 "~에 대한 설명으로 옳지 않은 것은?" 형태, options 5개 중 틀린 것 하나, answer_index.',
  combo: 'combo(<보기> 고르기): statements에 ㄱ~ㄹ 4개 진술과 각 진술의 참/거짓(is_true)을 넣는다. 참인 진술은 1~3개. stem은 "<보기>에서 옳은 것만을 있는 대로 고른 것은?" 같은 형태. options는 비워 둔다(프로그램이 만든다).',
  matching: 'matching(연결하기): matching에 3~4행의 {sociologist, theory, concept}를 넣는다. 각 행은 자료에서 서로 연결되는 학자-이론-핵심 개념이다. 행끼리 이론·개념이 겹치지 않게 한다.',
  ordering: 'ordering(순서 배열): order_items에 4~5개 항목을 올바른 순서대로 넣는다(이론의 등장 순서 또는 개념의 논리적 단계). stem에 배열 기준을 밝힌다. 자료에서 순서가 확인되는 것만 쓴다.',
  case: 'case(사례 적용): context에 사회 현상의 짧은 사례(3~5문장)를 쓰고, stem은 이를 가장 잘 설명하는 이론/개념을 묻는다. 객관식이면 options 5개와 answer_index, 서술형이면 options를 비우고 answer_text에 모범 답안, rubric에 채점 기준을 넣는다. 객관식과 서술형을 섞어 낸다.',
  table: 'table(비교표 채우기): 두 이론/학자를 비교한다. table.col_a, table.col_b에 비교 대상, rows에 3~5개 비교 기준과 각 칸 내용(a, b). 3~5칸을 a_blank/b_blank=true로 빈칸 처리한다. 빈칸 내용은 짧은 구로.',
  essay: 'essay(서술형): stem에 서술 과제. rubric에 3~4개 기준 {criterion, points, key_elements}(points 합계 10), model_answer에 모범 답안.',
};

const DIFF_SPEC = {
  easy: '쉬움: 핵심 용어의 정의와 기본 사실을 확인한다.',
  medium: '보통: 비슷한 개념을 구분하고 개념을 상황에 적용한다.',
  hard: '어려움: 여러 개념을 통합하고 미묘한 차이를 묻는다. 그럴듯한 오답 선지를 쓴다.',
};

export const Q_SCHEMA = T.obj({
  type: T.oneOf(...QUIZ_TYPES),
  stem: T.str,
  context: T.str,
  options: T.arr(T.str),
  answer_index: T.int,
  answer_text: T.str,
  accept: T.arr(T.str),
  blanks: T.arr(T.obj({ answer: T.str, accept: T.arr(T.str) })),
  ox: T.str,
  statements: T.arr(T.obj({ text: T.str, is_true: T.bool })),
  matching: T.arr(T.obj({ sociologist: T.str, theory: T.str, concept: T.str })),
  order_items: T.arr(T.str),
  table: T.obj({ col_a: T.str, col_b: T.str, rows: T.arr(T.obj({ criterion: T.str, a: T.str, b: T.str, a_blank: T.bool, b_blank: T.bool })) }),
  rubric: T.arr(T.obj({ criterion: T.str, points: T.num, key_elements: T.arr(T.str) })),
  model_answer: T.str,
  explanation: T.str,
  sources: SOURCES,
  concepts: T.arr(T.str),
  sociologists: T.arr(T.str),
});
const GEN_SCHEMA = T.obj({ questions: T.arr(Q_SCHEMA) });

// ---------- 생성 ----------
// types: 각 문항의 유형 배열 (길이 = 문항 수)
export async function generateQuestions({ types, difficulty = 'medium', focus = '', avoid = [], similarTo = null, signal }) {
  const plan = types.map((t, i) => `${i + 1}번: ${t}`).join(', ');
  const used = [...new Set(types)];
  const task = [
    `학습 범위 자료로 사회학 문제 ${types.length}개를 만들어라.`,
    `난이도 — ${DIFF_SPEC[difficulty]}`,
    `문항별 유형: ${plan}`,
    '유형별 작성 규칙:',
    ...used.map((t) => '- ' + TYPE_SPEC[t]),
    '공통 규칙:',
    '- 사용하지 않는 필드는 빈 문자열, 빈 배열, answer_index -1, table은 빈 값으로 둔다.',
    '- explanation에 정답 근거와 오답이 틀린 이유를 자료에 기반해 쓴다.',
    '- sources에 근거가 된 자료 위치를 1개 이상 적는다.',
    '- concepts에 이 문제가 다루는 핵심 개념/이론 이름(1~3개), sociologists에 관련 학자 이름(없으면 빈 배열)을 자료에 쓰인 표기로 적는다.',
    '- 문항끼리 같은 내용을 반복하지 않는다. 범위 전체에 고르게 출제한다.',
    focus && `- 다음 주제를 중심으로 출제한다: ${focus}`,
    similarTo && `- 다음 문제와 같은 개념을 묻되 표현·사례·선지가 다른 새 문제를 만든다:\n${JSON.stringify(similarTo)}`,
    avoid.length && `- 아래는 이미 있는 문제들이다. 같은 개념을 묻더라도 표현만 살짝 바꾼 사실상 같은 문제는 만들지 말고, 다른 측면·다른 사례·다른 선지로 출제한다:\n${avoid.slice(-40).map((s) => '  · ' + s.slice(0, 90)).join('\n')}`,
  ].filter(Boolean).join('\n');

  const { data } = await askJSON({ task, schema: GEN_SCHEMA, signal });
  const out = [];
  (data.questions || []).forEach((raw, i) => {
    const q = normalize(raw, difficulty);
    if (q) out.push(q);
  });
  if (!out.length) throw new Error('문제를 만들지 못했습니다. 범위를 확인하고 다시 시도해 주세요.');
  return out;
}

// 한 묶음(최대 4문항)을 생성 → 검증 → 실패한 문항만 한 번 더 생성 → 또 실패하면 건너뛴다.
async function generateChunkVerified({ types, difficulty, focus, avoid, similarTo, seen, signal }) {
  let pending = [...types];
  const out = [];
  for (let round = 0; round < 2 && pending.length; round++) {
    let qs;
    try {
      qs = await generateQuestions({ types: pending, difficulty, focus, avoid: [...avoid, ...out.map((q) => q.stem)], similarTo, signal });
    } catch (e) {
      if (round === 0 || signal?.aborted) throw e;
      break;
    }
    const fresh = qs.filter((q) => !isNearDuplicate(q, [...seen, ...out]));
    const verdicts = await verifyItems('quiz', fresh, { signal });
    for (let i = 0; i < fresh.length; i++) {
      if (!verdicts[i].pass) continue;
      const k = pending.indexOf(fresh[i].type);
      if (k < 0) continue;
      pending.splice(k, 1);
      fresh[i].verified = true;
      out.push(fresh[i]);
    }
  }
  return { qs: out, skipped: pending.length };
}

// 문제 은행에서 먼저 찾고, 모자란 만큼만 새로 만든다(검증 통과분만 은행에 저장).
export async function getQuestions({ count, typePool, difficulty, focus = '', freshOnly = false, avoid = [], feature = 'quiz', onReady, signal }) {
  const types = Array.from({ length: count }, (_, i) => typePool[i % typePool.length]);
  const slots = typePool.length > 1 ? shuffle(types) : types;
  const fromBank = freshOnly ? slots.map(() => null) : pickFromBank({ slots, difficulty, focus });
  const missing = slots.filter((_, i) => !fromBank[i]);
  const bankQs = fromBank.filter(Boolean);
  if (bankQs.length && onReady) onReady(bankQs); // 은행 문제는 바로 보여 준다
  const uniq = [];
  let skipped = 0, firstErr = null;
  if (missing.length) {
    const seen = bankQuizQuestions();
    const avoidAll = [...existingStems({ focus, types: [...new Set(missing)] }), ...avoid];
    // 2문항씩 나눠 동시에 만들고, 검증을 통과한 묶음부터 바로 내보낸다
    const chunks = [];
    for (let i = 0; i < missing.length; i += 2) chunks.push(missing.slice(i, i + 2));
    await Promise.all(chunks.map((c) => generateChunkVerified({ types: c, difficulty, focus, avoid: avoidAll, seen, signal }).then((r) => {
      if (signal?.aborted) return;
      const fresh = r.qs.filter((q) => !isNearDuplicate(q, uniq)); // 묶음끼리 겹친 문제 제거
      skipped += r.skipped + (r.qs.length - fresh.length);
      uniq.push(...fresh);
      fresh.forEach((q) => saveToBank(q, { feature }));
      if (fresh.length && onReady) onReady(fresh);
    }).catch((e) => { firstErr = firstErr || e; skipped += c.length; })));
    if (signal?.aborted) throw new CancelledError();
    if (!uniq.length && !bankQs.length) throw firstErr || new Error('검증을 통과한 문제를 만들지 못했습니다. 다시 시도해 주세요.');
  }
  // 계획한 순서대로 배치 (은행 문제 자리는 그대로, 빈자리는 새 문제로)
  const pool = [...uniq];
  const ordered = [];
  const used = new Set();
  slots.forEach((t, i) => {
    let q = fromBank[i];
    if (!q) {
      const k = pool.findIndex((x) => x.type === t);
      q = k >= 0 ? pool.splice(k, 1)[0] : null;
    }
    if (q && !used.has(q.id)) { used.add(q.id); ordered.push(q); }
  });
  pool.forEach((q) => { if (!used.has(q.id)) { used.add(q.id); ordered.push(q); } });
  return { questions: ordered, fromBank: bankQs.length, generated: uniq.length, skipped };
}

// 유사 문제 등: 은행을 거치지 않고 새로 만들되 검증과 저장은 똑같이 한다.
export async function generateVerifiedQuestions({ types, difficulty = 'medium', focus = '', similarTo = null, feature = 'similar', signal }) {
  const seen = bankQuizQuestions();
  const { qs, skipped } = await generateChunkVerified({ types, difficulty, focus, avoid: existingStems({ focus, types }), similarTo, seen, signal });
  if (!qs.length) throw new Error('검증을 통과한 문제를 만들지 못했습니다. 다시 시도해 주세요.');
  qs.forEach((q) => saveToBank(q, { feature }));
  return { questions: qs, skipped };
}

export function normalize(raw, difficulty) {
  const q = { ...raw, id: uid(), difficulty };
  const arr = (x) => (Array.isArray(x) ? x : []);
  q.options = arr(q.options).map(String);
  q.accept = arr(q.accept).map(String);
  q.sources = arr(q.sources);
  q.concepts = arr(q.concepts);
  q.sociologists = arr(q.sociologists);
  q.stem = String(q.stem || '').trim();
  q.context = String(q.context || '').trim();
  if (!q.stem) return null;
  switch (q.type) {
    case 'mc': case 'select_correct': case 'select_incorrect':
      if (q.options.length < 4 || !(q.answer_index >= 0 && q.answer_index < q.options.length)) return null;
      break;
    case 'case':
      if (q.options.length >= 4) {
        if (!(q.answer_index >= 0 && q.answer_index < q.options.length)) return null;
      } else {
        q.options = [];
        if (!q.answer_text && !q.model_answer) return null;
        if (!arr(q.rubric).length) q.rubric = [{ criterion: '적절한 이론/개념 선택과 적용', points: 10, key_elements: [q.answer_text || q.model_answer] }];
      }
      break;
    case 'ox':
      q.ox = String(q.ox || '').toUpperCase().includes('X') ? 'X' : 'O';
      break;
    case 'short':
      if (!q.answer_text) return null;
      break;
    case 'blank':
      q.blanks = arr(q.blanks).filter((b) => b && b.answer);
      if (!q.blanks.length) return null;
      break;
    case 'combo': {
      const st = arr(q.statements).slice(0, 4).map((s, i) => ({ label: LABELS[i], text: s.text, is_true: !!s.is_true }));
      if (st.length < 3 || !st.some((s) => s.is_true)) return null;
      q.statements = st;
      buildComboOptions(q);
      break;
    }
    case 'matching':
      q.matching = arr(q.matching).filter((r) => r.sociologist && r.theory && r.concept);
      if (q.matching.length < 2) return null;
      break;
    case 'ordering':
      q.order_items = arr(q.order_items).map(String).filter(Boolean);
      if (q.order_items.length < 3) return null;
      break;
    case 'table':
      if (!q.table || !arr(q.table.rows).length) return null;
      q.table.rows = q.table.rows.map((r) => ({ ...r, a_blank: !!r.a_blank, b_blank: !!r.b_blank }));
      if (!q.table.rows.some((r) => r.a_blank || r.b_blank)) q.table.rows[0].b_blank = true;
      break;
    case 'essay':
      q.rubric = arr(q.rubric);
      if (!q.rubric.length) return null;
      break;
    default:
      return null;
  }
  return q;
}

function buildComboOptions(q) {
  const labels = q.statements.map((s) => s.label);
  const correct = q.statements.filter((s) => s.is_true).map((s) => s.label);
  const key = (set) => [...set].sort().join(', ');
  const all = [];
  for (let mask = 1; mask < 1 << labels.length; mask++) all.push(labels.filter((_, i) => mask & (1 << i)));
  const distract = shuffle(all.filter((c) => key(c) !== key(correct))).slice(0, 4);
  const opts = shuffle([correct, ...distract]).sort((a, b) => a.length - b.length || key(a).localeCompare(key(b)));
  q.options = opts.map(key);
  q.answer_index = q.options.indexOf(key(correct));
}

// ---------- 텍스트 표현 ----------
export function answerText(q) {
  switch (q.type) {
    case 'mc': case 'select_correct': case 'select_incorrect': case 'combo':
      return `${CIRC[q.answer_index]} ${q.options[q.answer_index]}`;
    case 'case':
      return q.options.length ? `${CIRC[q.answer_index]} ${q.options[q.answer_index]}` : (q.model_answer || q.answer_text);
    case 'ox': return q.ox;
    case 'short': return q.answer_text + (q.accept.length ? ` (인정: ${q.accept.join(', ')})` : '');
    case 'blank': return q.blanks.map((b, i) => `${CIRC[i]} ${b.answer}`).join('  ');
    case 'matching': return q.matching.map((r) => `${r.sociologist} – ${r.theory} – ${r.concept}`).join('\n');
    case 'ordering': return q.order_items.map((x, i) => `${i + 1}. ${x}`).join(' → ');
    case 'table': return tableBlanks(q).map((c) => `${c.criterion}/${c.col}: ${c.answer}`).join('\n');
    case 'essay': return q.model_answer;
    default: return '';
  }
}
export function userAnswerText(q, a) {
  if (a == null || a === '' || (Array.isArray(a) && !a.length)) return '(응답 없음)';
  switch (q.type) {
    case 'mc': case 'select_correct': case 'select_incorrect': case 'combo':
      return typeof a === 'number' ? `${CIRC[a]} ${q.options[a]}` : '(응답 없음)';
    case 'case':
      if (q.options.length) return typeof a === 'number' ? `${CIRC[a]} ${q.options[a]}` : '(응답 없음)';
      return String(a);
    case 'blank': return a.map((x, i) => `${CIRC[i]} ${x || '—'}`).join('  ');
    case 'matching': return q.matching.map((r, i) => `${r.sociologist} – ${a[i]?.theory || '—'} – ${a[i]?.concept || '—'}`).join('\n');
    case 'ordering': return a.map((x, i) => `${i + 1}. ${x}`).join(' → ');
    case 'table': return tableBlanks(q).map((c) => `${c.criterion}/${c.col}: ${a[c.key] || '—'}`).join('\n');
    default: return String(a);
  }
}
function tableBlanks(q) {
  const out = [];
  q.table.rows.forEach((r, i) => {
    if (r.a_blank) out.push({ key: `${i}-a`, criterion: r.criterion, col: q.table.col_a, answer: r.a });
    if (r.b_blank) out.push({ key: `${i}-b`, criterion: r.criterion, col: q.table.col_b, answer: r.b });
  });
  return out;
}
export function questionSummary(q) {
  const parts = [`[${TYPES[q.type]}] ${q.stem}`];
  if (q.context) parts.push(`사례/지문: ${q.context}`);
  if (q.type === 'combo') parts.push(q.statements.map((s) => `${s.label}. ${s.text}`).join('\n'));
  if (q.options?.length) parts.push(q.options.map((o, i) => `${CIRC[i]} ${o}`).join('\n'));
  if (q.type === 'matching') parts.push('연결할 학자: ' + q.matching.map((r) => r.sociologist).join(', '));
  if (q.type === 'ordering') parts.push('항목: ' + q.order_items.join(', '));
  if (q.type === 'table') parts.push(`비교: ${q.table.col_a} vs ${q.table.col_b}`);
  if (q.type === 'passage') parts.push('변형 문단: ' + q.data?.modified);
  return parts.join('\n');
}

// ---------- 채점 ----------
const norm = (s) => String(s || '').toLowerCase().replace(/[\s.,·'"“”‘’`~!?()\[\]{}<>\-_/]/g, '');
function variants(s) {
  const v = [s];
  const m = String(s).match(/^(.*?)\((.*?)\)(.*)$/);
  if (m) { v.push(m[1] + m[3], m[2]); }
  return v.map(norm).filter(Boolean);
}
function matches(user, answers) {
  const u = norm(user);
  if (!u) return false;
  return answers.flatMap(variants).some((a) => a === u);
}

function localGrade(q, a) {
  const empty = a == null || a === '' || (Array.isArray(a) && a.every((x) => !x));
  switch (q.type) {
    case 'mc': case 'select_correct': case 'select_incorrect': case 'combo': {
      const ok = a === q.answer_index;
      return { correct: ok, score: ok ? 1 : 0 };
    }
    case 'case':
      if (q.options.length) { const ok = a === q.answer_index; return { correct: ok, score: ok ? 1 : 0 }; }
      if (empty) return { correct: false, score: 0, feedback: '답안을 작성하지 않았습니다.' };
      return null;
    case 'ox': { const ok = a === q.ox; return { correct: ok, score: ok ? 1 : 0 }; }
    case 'short':
      if (empty) return { correct: false, score: 0 };
      if (matches(a, [q.answer_text, ...q.accept])) return { correct: true, score: 1 };
      return null;
    case 'blank': {
      const parts = q.blanks.map((b, i) => matches(a?.[i], [b.answer, ...(b.accept || [])]));
      if (parts.every(Boolean)) return { correct: true, score: 1, parts };
      const unresolved = q.blanks.some((b, i) => !parts[i] && a?.[i]);
      if (!unresolved) return { correct: false, score: parts.filter(Boolean).length / parts.length, parts };
      return null;
    }
    case 'matching': {
      const parts = q.matching.map((r, i) => a?.[i]?.theory === r.theory && a?.[i]?.concept === r.concept);
      const score = parts.filter(Boolean).length / parts.length;
      return { correct: score === 1, score, parts };
    }
    case 'ordering': {
      const parts = q.order_items.map((x, i) => a?.[i] === x);
      const score = parts.filter(Boolean).length / parts.length;
      return { correct: score === 1, score, parts };
    }
    case 'table': {
      const cells = tableBlanks(q);
      const parts = cells.map((c) => matches(a?.[c.key], [c.answer]));
      if (parts.every(Boolean)) return { correct: true, score: 1, parts };
      if (!cells.some((c, i) => !parts[i] && a?.[c.key])) return { correct: false, score: parts.filter(Boolean).length / parts.length, parts };
      return null;
    }
    case 'essay':
      if (empty) return { correct: false, score: 0, feedback: '답안을 작성하지 않았습니다.' };
      return null;
    default:
      return { correct: false, score: 0 };
  }
}

const GRADE_SCHEMA = T.obj({
  results: T.arr(T.obj({
    key: T.str,
    score: T.num,
    parts: T.arr(T.bool),
    feedback: T.str,
    missing: T.arr(T.str),
    improve: T.str,
    rubric: T.arr(T.obj({ criterion: T.str, got: T.num, max: T.num, comment: T.str })),
    sources: SOURCES,
  })),
});

function openPayload(key, q, a) {
  const base = { key, type: TYPES[q.type], question: q.stem, context: q.context || undefined };
  switch (q.type) {
    case 'short': return { ...base, expected: [q.answer_text, ...q.accept], user: a, how: '의미가 같으면 정답(score 1), 아니면 0.' };
    case 'blank': return { ...base, expected: q.blanks.map((b) => b.answer), user: a, how: '빈칸별로 문맥상 같은 의미인지 판단해 parts에 순서대로 true/false. score는 맞은 비율.' };
    case 'table': {
      const cells = tableBlanks(q);
      return { ...base, compare: `${q.table.col_a} vs ${q.table.col_b}`, expected: cells.map((c) => `${c.criterion}/${c.col}: ${c.answer}`), user: cells.map((c) => a?.[c.key] || ''), how: '칸별로 같은 의미인지 판단해 parts에 순서대로. score는 맞은 비율.' };
    }
    case 'case':
    case 'essay':
      return { ...base, rubric: q.rubric, model_answer: q.model_answer || q.answer_text, user: a, how: '채점 기준별로 부분 점수(rubric의 got/max)를 매기고 score = 총점/만점(0~1). 빠진 핵심 요소(missing)와 개선 방법(improve)을 구체적으로.' };
    default: return { ...base, user: a };
  }
}

// items: [{q, a}] → 같은 순서의 결과 배열
export async function gradeMany(items) {
  const results = items.map(({ q, a }) => localGrade(q, a));
  const pending = results.map((r, i) => (r ? null : i)).filter((i) => i !== null);
  if (pending.length) {
    const payload = pending.map((i) => openPayload(String(i), items[i].q, items[i].a));
    const task = [
      '다음 답안들을 채점하라. 정답과 표현이 달라도 문맥상 같은 의미면 정답으로 인정하고, 사소한 맞춤법 차이는 감점하지 않는다.',
      '채점 근거는 학습 자료다. feedback은 학습자에게 직접 말하듯 2~4문장으로, 무엇이 맞고 무엇이 부족한지 쓴다.',
      '해당 없는 필드는 빈 배열/빈 문자열로 둔다. key는 그대로 돌려준다.',
      JSON.stringify(payload),
    ].join('\n');
    const { data } = await askJSON({ task, schema: GRADE_SCHEMA, maxTokens: 32000 });
    const byKey = new Map((data.results || []).map((r) => [String(r.key), r]));
    for (const i of pending) {
      const r = byKey.get(String(i));
      const score = Math.max(0, Math.min(1, Number(r?.score) || 0));
      const q = items[i].q;
      const threshold = q.type === 'essay' || (q.type === 'case' && !q.options.length) ? 0.6 : 0.999;
      results[i] = r
        ? { correct: score >= threshold, score, parts: r.parts, feedback: r.feedback, missing: r.missing, improve: r.improve, rubric: r.rubric, gradeSources: r.sources, ai: true }
        : { correct: false, score: 0, feedback: '채점 결과를 받지 못했습니다.' };
    }
  }
  return results;
}
export const grade = async (q, a) => (await gradeMany([{ q, a }]))[0];

// 채점 결과를 기록: 대시보드 + 오답노트 (+ 다시 풀기면 '완전 정복' 표시)
export function recordResult(q, a, res, { feature, retry = false }) {
  recordAttempt({ qid: q.id, feature, type: q.type, concepts: q.concepts, sociologists: q.sociologists, correct: res.correct, score: res.score });
  if (retry) {
    markMastered(q.id, res.correct);
    if (!res.correct) addWrong({ feature, q, userAnswer: a, feedback: res.feedback });
  } else if (!res.correct) {
    addWrong({ feature, q, userAnswer: a, feedback: res.feedback });
  }
}

// ---------- 렌더링 ----------
// mode: 'practice'(바로 채점) | 'exam'(나중에 일괄 채점)
export function renderQuestion(q, { index, mode = 'practice', feature = 'quiz', retry = false, onResult } = {}) {
  const view = { q, answer: null, locked: false, feature };
  const card = h('article', { class: 'qcard', 'data-type': q.type });
  const focusCtx = () => setCurrent({ kind: 'question', q, answer: view.answer, result: view.result, label: `${index != null ? index + 1 + '번 ' : ''}${TYPES[q.type]} 문제` });
  card.addEventListener('focusin', focusCtx);
  card.addEventListener('click', focusCtx);

  card.appendChild(h('div', { class: 'qmeta' },
    index != null && h('span', { class: 'qnum' }, `${index + 1}`),
    h('span', { class: 'tag' }, TYPES[q.type]),
    q.difficulty && h('span', { class: 'tag soft' }, DIFF[q.difficulty]),
    q.concepts?.slice(0, 2).map((c) => h('span', { class: 'tag ghost' }, c))));

  if (q.context) card.appendChild(h('div', { class: 'qcontext' }, h('span', { class: 'ctx-label' }, '사례'), q.context));
  card.appendChild(h('p', { class: 'qstem' }, q.type === 'blank' ? stemWithBlanks(q.stem) : q.stem));

  const body = h('div', { class: 'qbody' });
  card.appendChild(body);
  const inputs = buildInputs(q, view);
  body.appendChild(inputs.el);

  const resultBox = h('div', { class: 'qresult', 'aria-live': 'polite' });
  card.appendChild(resultBox);

  const actions = h('div', { class: 'qactions' });
  card.appendChild(actions);
  if (mode === 'practice') {
    const submit = h('button', { class: 'btn primary', onclick: async () => {
      view.answer = inputs.get();
      submit.disabled = true;
      submit.textContent = '채점 중…';
      const needsAI = !localGrade(q, view.answer);
      if (needsAI) resultBox.replaceChildren(loadingBox('AI가 의미를 기준으로 채점하고 있습니다…'));
      try {
        const res = await grade(q, view.answer);
        recordResult(q, view.answer, res, { feature, retry });
        view.lock(res);
        onResult && onResult(res, view.answer);
      } catch (e) {
        resultBox.replaceChildren(h('div', { class: 'notice error' }, e.message));
        submit.disabled = false;
        submit.textContent = '제출';
      }
    } }, '제출');
    actions.appendChild(submit);
  }

  view.el = card;
  view.getAnswer = () => (view.answer = inputs.get());
  view.lock = (res) => {
    view.locked = true;
    view.result = res;
    inputs.lock(res);
    clear(actions);
    resultBox.replaceChildren(resultView(q, view.answer, res));
    actions.appendChild(h('button', { class: 'btn ghost', onclick: () => openChatAbout({ kind: 'question', q, answer: view.answer, result: res, label: TYPES[q.type] + ' 문제' }, '이 문제의 해설이 이해가 안 돼요. ') }, '💬 이 문제 AI에게 질문'));
    actions.appendChild(reportButton(q, { feature: view.feature, userAnswer: view.answer, wasWrong: !res.correct }));
    focusCtx();
  };
  return view;
}

function stemWithBlanks(stem) {
  const parts = String(stem).split(/(\(\s*[①②③④⑤]\s*\))/);
  return parts.map((p) => (/^\(\s*[①②③④⑤]\s*\)$/.test(p) ? h('span', { class: 'blank-mark' }, p.replace(/[()\s]/g, '') + ' ______') : p));
}

function buildInputs(q, view) {
  const name = 'q' + q.id;
  switch (q.type) {
    case 'mc': case 'select_correct': case 'select_incorrect': case 'combo': case 'case': {
      if (q.type === 'case' && !q.options.length) return textArea('사례를 설명하는 이론/개념과 그 이유를 쓰세요.', 5);
      const wrap = h('div');
      if (q.type === 'combo') {
        wrap.appendChild(h('div', { class: 'bogi' }, h('div', { class: 'bogi-title' }, '<보기>'),
          q.statements.map((s) => h('p', null, h('b', null, s.label + '. '), s.text))));
      }
      const radios = q.options.map((o, i) => h('input', { type: 'radio', name, value: i }));
      wrap.appendChild(h('div', { class: 'options' }, q.options.map((o, i) =>
        h('label', { class: 'opt' }, radios[i], h('span', { class: 'circ' }, CIRC[i]), h('span', null, o)))));
      return {
        el: wrap,
        get: () => { const r = radios.findIndex((x) => x.checked); return r < 0 ? null : r; },
        lock: () => {
          radios.forEach((r, i) => {
            r.disabled = true;
            const lbl = r.closest('.opt');
            if (i === q.answer_index) lbl.classList.add('right');
            else if (r.checked) lbl.classList.add('wrong');
          });
        },
      };
    }
    case 'ox': {
      let val = null;
      const btns = ['O', 'X'].map((v) => h('button', { type: 'button', class: 'ox-btn', 'aria-pressed': 'false', onclick: () => {
        if (view.locked) return;
        val = v;
        btns.forEach((b) => b.setAttribute('aria-pressed', String(b.textContent === v)));
      } }, v));
      return {
        el: h('div', { class: 'ox-row' }, btns),
        get: () => val,
        lock: () => btns.forEach((b) => { b.disabled = true; if (b.textContent === q.ox) b.classList.add('right'); else if (b.textContent === val) b.classList.add('wrong'); }),
      };
    }
    case 'short': {
      const inp = h('input', { type: 'text', class: 'input', placeholder: '정답을 입력하세요', onkeydown: (e) => { if (e.key === 'Enter') e.target.closest('.qcard')?.querySelector('.qactions .primary')?.click(); } });
      return { el: inp, get: () => inp.value.trim(), lock: () => { inp.disabled = true; } };
    }
    case 'blank': {
      const inps = q.blanks.map((_, i) => h('input', { type: 'text', class: 'input', placeholder: `${CIRC[i]} 빈칸` }));
      return {
        el: h('div', { class: 'blank-grid' }, inps.map((inp, i) => h('label', { class: 'blank-field' }, h('span', null, CIRC[i]), inp))),
        get: () => inps.map((x) => x.value.trim()),
        lock: (res) => inps.forEach((x, i) => { x.disabled = true; if (res?.parts) x.classList.add(res.parts[i] ? 'right' : 'wrong'); }),
      };
    }
    case 'matching': {
      const theories = shuffle(q.matching.map((r) => r.theory));
      const concepts = shuffle(q.matching.map((r) => r.concept));
      const sel = (opts) => h('select', { class: 'input' }, h('option', { value: '' }, '선택'), opts.map((o) => h('option', { value: o }, o)));
      const rows = q.matching.map((r) => ({ r, t: sel(theories), c: sel(concepts) }));
      return {
        el: h('div', { class: 'match-table', role: 'table' },
          h('div', { class: 'match-row head', role: 'row' }, h('span', null, '사회학자'), h('span', null, '이론'), h('span', null, '핵심 개념')),
          rows.map(({ r, t, c }) => h('div', { class: 'match-row', role: 'row' }, h('span', { class: 'who' }, r.sociologist), t, c))),
        get: () => rows.map(({ t, c }) => ({ theory: t.value, concept: c.value })),
        lock: (res) => rows.forEach(({ t, c }, i) => { t.disabled = c.disabled = true; if (res?.parts) { t.classList.add(res.parts[i] ? 'right' : 'wrong'); c.classList.add(res.parts[i] ? 'right' : 'wrong'); } }),
      };
    }
    case 'ordering': {
      let items = shuffle(q.order_items);
      if (items.join('|') === q.order_items.join('|')) items = [...items.slice(1), items[0]];
      const list = h('ol', { class: 'order-list' });
      let locked = false;
      const draw = (res) => {
        clear(list);
        items.forEach((it, i) => list.appendChild(h('li', { class: res?.parts ? (res.parts[i] ? 'right' : 'wrong') : '' },
          h('span', { class: 'order-text' }, it),
          !locked && h('span', { class: 'order-btns' },
            h('button', { type: 'button', class: 'icon-btn', 'aria-label': '위로', disabled: i === 0, onclick: () => { [items[i - 1], items[i]] = [items[i], items[i - 1]]; draw(); } }, '▲'),
            h('button', { type: 'button', class: 'icon-btn', 'aria-label': '아래로', disabled: i === items.length - 1, onclick: () => { [items[i + 1], items[i]] = [items[i], items[i + 1]]; draw(); } }, '▼')))));
      };
      draw();
      return { el: list, get: () => [...items], lock: (res) => { locked = true; draw(res); } };
    }
    case 'table': {
      const inputs = {};
      const tbl = h('table', { class: 'cmp-table' },
        h('thead', null, h('tr', null, h('th', null, '비교 기준'), h('th', null, q.table.col_a), h('th', null, q.table.col_b))),
        h('tbody', null, q.table.rows.map((r, i) => h('tr', null, h('th', { scope: 'row' }, r.criterion),
          ['a', 'b'].map((col) => {
            if (!r[col + '_blank']) return h('td', null, r[col]);
            const inp = h('input', { type: 'text', class: 'input', placeholder: '빈칸' });
            inputs[`${i}-${col}`] = inp;
            return h('td', { class: 'blank-cell' }, inp);
          })))));
      return {
        el: h('div', { class: 'table-wrap' }, tbl),
        get: () => Object.fromEntries(Object.entries(inputs).map(([k, v]) => [k, v.value.trim()])),
        lock: (res) => {
          const cells = tableBlanks(q);
          cells.forEach((c, i) => { const inp = inputs[c.key]; inp.disabled = true; if (res?.parts) inp.classList.add(res.parts[i] ? 'right' : 'wrong'); });
        },
      };
    }
    case 'essay': {
      const ta = textArea('답안을 작성하세요.', 8);
      const rub = h('details', { class: 'rubric-hint' }, h('summary', null, '채점 기준 보기'),
        h('ul', null, q.rubric.map((r) => h('li', null, `${r.criterion} (${r.points}점)`))));
      return { el: h('div', null, rub, ta.el), get: ta.get, lock: ta.lock };
    }
    default:
      return { el: h('p', null, '지원하지 않는 유형'), get: () => null, lock: () => {} };
  }
}
function textArea(placeholder, rows) {
  const ta = h('textarea', { class: 'input', rows, placeholder });
  return { el: ta, get: () => ta.value.trim(), lock: () => { ta.readOnly = true; } };
}

export function resultView(q, a, res) {
  const status = res.correct ? 'right' : res.score > 0 ? 'partial' : 'wrong';
  const label = res.correct ? '정답' : res.score > 0 ? '부분 정답' : '오답';
  const showScore = ['essay', 'case', 'matching', 'ordering', 'blank', 'table'].includes(q.type);
  return h('div', { class: `result ${status}` },
    h('div', { class: 'result-head' },
      h('strong', null, (res.correct ? '✔ ' : res.score > 0 ? '◐ ' : '✘ ') + label),
      showScore && h('span', { class: 'score' }, q.type === 'essay' || (q.type === 'case' && !q.options.length) ? `${Math.round(res.score * 10 * 10) / 10} / 10점` : `${Math.round(res.score * 100)}%`),
      !res.correct && h('span', { class: 'muted small' }, '오답노트에 저장됨')),
    !['mc', 'select_correct', 'select_incorrect', 'combo', 'ox'].includes(q.type) || q.type === 'case' ? h('div', { class: 'kv' }, h('span', null, '내 답'), h('pre', null, userAnswerText(q, a))) : null,
    h('div', { class: 'kv' }, h('span', null, q.type === 'essay' || (q.type === 'case' && !q.options.length) ? '모범 답안' : '정답'), h('pre', null, answerText(q))),
    res.rubric?.length ? h('table', { class: 'rubric-table' },
      h('thead', null, h('tr', null, h('th', null, '채점 기준'), h('th', null, '점수'), h('th', null, '코멘트'))),
      h('tbody', null, res.rubric.map((r) => h('tr', null, h('td', null, r.criterion), h('td', { class: 'num' }, `${r.got}/${r.max}`), h('td', null, r.comment))))) : null,
    res.feedback && h('div', { class: 'feedback' }, h('b', null, 'AI 피드백 '), res.feedback),
    res.missing?.length ? h('div', { class: 'feedback' }, h('b', null, '빠진 핵심 요소'), h('ul', null, res.missing.map((m) => h('li', null, m)))) : null,
    res.improve && h('div', { class: 'feedback' }, h('b', null, '개선 방법 '), res.improve),
    q.explanation && h('div', { class: 'explain' }, h('b', null, '해설 '), q.explanation),
    sourceChips(q.sources));
}
