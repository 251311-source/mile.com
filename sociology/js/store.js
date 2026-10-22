// 학습 기록 저장소. 로그인한 계정(Firestore)과 cloud.js가 동기화하고, 업로드 자료 원본은 이 기기의 IndexedDB에만 둔다.
export const LEGACY_KEY = 'socstudy:v1'; // 로그인 기능 이전에 브라우저에 저장하던 기록
const MAX_ATTEMPTS = 8000;

const DEFAULTS = () => ({
  settings: { provider: 'anthropic', apiKey: '', model: 'claude-opus-5-5', geminiKey: '', geminiModel: 'gemini-2.5-pro', speed: 'fast', effort: 'medium', maxChars: 400000 },
  scope: {},          // { [docId]: number[] } 선택된 쪽/슬라이드 번호
  wrong: [],          // 오답노트 항목
  qlog: [],           // 질문 기록
  attempts: [],       // 채점 기록 (대시보드용)
  cards: [],          // 플래시카드
  exams: [],          // 시험 결과 요약
  quoteBank: {},      // { [scopeKey]: {quotes, sociologists, topics} }
  maps: {},           // { [scopeKey]: graph }
  recent: {},         // 중복 방지용 최근 출제 기록 { passage: [], critique: [], realworld: [] }
  bank: [],           // 문제 은행 (검증 통과 문제)
  reports: [],        // 신고한 문제
  pairs: [],          // 직접 추가한 헷갈리는 개념 쌍 (국제정치)
  timelines: {},      // { [scopeKey]: 사건·이론 연표 } (국제정치)
  confusions: {},     // { [scopeKey]: 자동 추출한 헷갈리는 개념 쌍 } (국제정치)
  prefSubject: 'soc', // 마지막으로 고른 과목 (계정 공통)
  migratedAt: 0,      // 과목 구조로 옮긴 시각
  lastBackup: 0,      // 마지막 백업 시각
  firstUse: Date.now(),
});

let state = DEFAULTS();
const listeners = new Set();

// 로그인 이전 버전이 이 브라우저에 남긴 기록 (계정으로 옮기기용)
export function loadLegacy() {
  try {
    const raw = localStorage.getItem(LEGACY_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    const base = DEFAULTS();
    return { ...base, ...parsed, settings: { ...base.settings, ...(parsed.settings || {}) } };
  } catch {
    return null;
  }
}
export function clearLegacy() {
  try { localStorage.removeItem(LEGACY_KEY); } catch {}
}

let saveTimer = null;
export function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flush, 50);
}
// 변경 알림. 계정 저장은 cloud.js가 이 알림을 받아 바뀐 항목만 올린다.
export function flush() {
  clearTimeout(saveTimer);
  listeners.forEach((fn) => fn());
}
export function onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }

export const S = () => state;
export const settings = () => state.settings;

export function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// ---------- 채점 기록 ----------
export function recordAttempt({ qid, feature, type, concepts = [], sociologists = [], correct, score }) {
  if (qid) bankRecord(qid, !!correct);
  state.attempts.push({
    ts: Date.now(), qid, feature, type,
    concepts: concepts.filter(Boolean).slice(0, 5),
    sociologists: sociologists.filter(Boolean).slice(0, 5),
    correct: !!correct,
    score: typeof score === 'number' ? score : (correct ? 1 : 0),
  });
  if (state.attempts.length > MAX_ATTEMPTS) state.attempts = state.attempts.slice(-MAX_ATTEMPTS);
  save();
}

// ---------- 오답노트 ----------
// entry: { id, feature, q, userAnswer, feedback, ts, mastered, tries }
export function addWrong({ feature, q, userAnswer, feedback }) {
  const existing = state.wrong.find((w) => w.q && q && w.q.id === q.id);
  if (existing) {
    existing.userAnswer = userAnswer;
    existing.feedback = feedback || existing.feedback;
    existing.ts = Date.now();
    existing.mastered = false;
    existing.tries = (existing.tries || 0) + 1;
  } else {
    state.wrong.unshift({ id: uid(), feature, q, userAnswer, feedback, ts: Date.now(), mastered: false, tries: 1 });
  }
  save();
}
export function markMastered(qid, ok) {
  const w = state.wrong.find((x) => x.q && x.q.id === qid);
  if (!w) return false;
  w.tries = (w.tries || 0) + 1;
  if (ok) { w.mastered = true; w.masteredAt = Date.now(); }
  save();
  return true;
}
export function removeWrong(id) {
  state.wrong = state.wrong.filter((w) => w.id !== id);
  save();
}

// ---------- 질문 기록 ----------
export function addQlog({ text, answer = '', origin = 'manual', ctx = '' }) {
  const e = { id: uid(), text, answer, origin, ctx, resolved: false, ts: Date.now() };
  state.qlog.unshift(e);
  save();
  return e;
}
export function updateQlog(id, patch) {
  const e = state.qlog.find((x) => x.id === id);
  if (e) { Object.assign(e, patch, { updatedAt: Date.now() }); save(); }
}
export function removeQlog(id) {
  state.qlog = state.qlog.filter((x) => x.id !== id);
  save();
}

// ---------- 문제 은행 ----------
export const bankEntry = (qid) => state.bank.find((b) => b.id === qid);
function bankRecord(qid, ok) {
  const b = bankEntry(qid);
  if (!b) return;
  b.asked = (b.asked || 0) + 1;
  if (ok) { b.correct = (b.correct || 0) + 1; b.streak = (b.streak || 0) + 1; } else b.streak = 0;
  b.lastResult = ok;
  b.lastAt = b.updatedAt = Date.now();
}
// 신고된 문제의 오답·채점 기록을 빼고, 신고 취소 시 되돌릴 수 있게 돌려준다.
export function detachRecords(qid) {
  const wrong = state.wrong.filter((w) => w.q?.id === qid);
  const attempts = state.attempts.filter((a) => a.qid === qid);
  state.wrong = state.wrong.filter((w) => w.q?.id !== qid);
  state.attempts = state.attempts.filter((a) => a.qid !== qid);
  save();
  return { wrong, attempts };
}
export function reattachRecords(removed) {
  if (!removed) return;
  const ids = new Set(state.wrong.map((w) => w.id));
  state.wrong.unshift(...(removed.wrong || []).filter((w) => !ids.has(w.id)));
  state.attempts.push(...(removed.attempts || []));
  state.attempts.sort((a, b) => a.ts - b.ts);
  save();
}

export function pushRecent(kind, value, keep = 15) {
  const arr = (state.recent[kind] ||= []);
  arr.push(value);
  if (arr.length > keep) arr.splice(0, arr.length - keep);
  save();
}

// ---------- 백업 (backup.js가 사용) ----------
export function replaceState(next) {
  state = next;
  flush();
}
export const freshState = DEFAULTS;

export function resetRecords() {
  const keep = { settings: state.settings, scope: state.scope, lastBackup: state.lastBackup, prefSubject: state.prefSubject, migratedAt: state.migratedAt };
  state = { ...DEFAULTS(), ...keep };
  flush();
}

// ---------- IndexedDB: 업로드한 자료 ----------
let dbp = null;
function db() {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    const req = indexedDB.open('socstudy', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('docs', { keyPath: 'id' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbp;
}
function tx(mode, fn) {
  return db().then((d) => new Promise((resolve, reject) => {
    const t = d.transaction('docs', mode);
    const store = t.objectStore('docs');
    const out = fn(store);
    t.oncomplete = () => resolve(out && 'result' in out ? out.result : out);
    t.onerror = () => reject(t.error);
  }));
}
export const docsDB = {
  all: () => tx('readonly', (s) => s.getAll()),
  put: (doc) => tx('readwrite', (s) => s.put(doc)),
  remove: (id) => tx('readwrite', (s) => s.delete(id)),
};
