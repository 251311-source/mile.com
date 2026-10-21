// 학습 기록(localStorage)과 업로드 자료(IndexedDB) 저장소.
const KEY = 'socstudy:v1';
const MAX_ATTEMPTS = 8000;

const DEFAULTS = () => ({
  settings: { apiKey: '', model: 'claude-opus-5-5', effort: 'medium', maxChars: 400000 },
  scope: {},          // { [docId]: number[] } 선택된 쪽/슬라이드 번호
  wrong: [],          // 오답노트 항목
  qlog: [],           // 질문 기록
  attempts: [],       // 채점 기록 (대시보드용)
  cards: [],          // 플래시카드
  exams: [],          // 시험 결과 요약
  quoteBank: {},      // { [scopeKey]: {quotes, sociologists, topics} }
  maps: {},           // { [scopeKey]: graph }
  recent: {},         // 중복 방지용 최근 출제 기록 { passage: [], critique: [], realworld: [] }
});

let state = load();
const listeners = new Set();

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return DEFAULTS();
    const parsed = JSON.parse(raw);
    const base = DEFAULTS();
    return { ...base, ...parsed, settings: { ...base.settings, ...(parsed.settings || {}) } };
  } catch {
    return DEFAULTS();
  }
}

let saveTimer = null;
export function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flush, 50);
}
export function flush() {
  clearTimeout(saveTimer);
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch (e) {
    // 용량 초과 시 오래된 채점 기록부터 줄인다.
    if (state.attempts.length > 1000) {
      state.attempts = state.attempts.slice(-1000);
      try { localStorage.setItem(KEY, JSON.stringify(state)); } catch {}
    }
    console.warn('저장 실패', e);
  }
  listeners.forEach((fn) => fn());
}
export function onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }

export const S = () => state;
export const settings = () => state.settings;

export function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// ---------- 채점 기록 ----------
export function recordAttempt({ feature, type, concepts = [], sociologists = [], correct, score }) {
  state.attempts.push({
    ts: Date.now(), feature, type,
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
  if (e) { Object.assign(e, patch); save(); }
}
export function removeQlog(id) {
  state.qlog = state.qlog.filter((x) => x.id !== id);
  save();
}

export function pushRecent(kind, value, keep = 15) {
  const arr = (state.recent[kind] ||= []);
  arr.push(value);
  if (arr.length > keep) arr.splice(0, arr.length - keep);
  save();
}

// ---------- 백업 ----------
export function exportData() {
  const copy = { ...state, settings: { ...state.settings, apiKey: '' } };
  return JSON.stringify({ app: 'socstudy', version: 1, exportedAt: new Date().toISOString(), data: copy }, null, 1);
}
export function importData(json) {
  const parsed = JSON.parse(json);
  if (parsed.app !== 'socstudy' || !parsed.data) throw new Error('이 프로그램의 백업 파일이 아닙니다.');
  const key = state.settings.apiKey;
  state = { ...DEFAULTS(), ...parsed.data };
  state.settings = { ...DEFAULTS().settings, ...(parsed.data.settings || {}), apiKey: key };
  flush();
}
export function resetRecords() {
  const keep = { settings: state.settings, scope: state.scope };
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
