// 백업 내보내기/불러오기 (덮어쓰기·합치기)와 백업 알림
import { S, freshState, replaceState, flush } from './store.js';
import { allDocs } from './docs.js';

export const BACKUP_REMIND_DAYS = 30;
const ARRAYS = ['wrong', 'qlog', 'attempts', 'cards', 'exams', 'bank', 'reports'];
const OBJECTS = ['quoteBank', 'maps', 'recent', 'scope'];

function localDate(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function backupFileName() {
  return `사회학학습_백업_${localDate()}.json`;
}

// 원본 PDF/PPT는 넣지 않고 파일 이름과 범위만 기록한다.
export function buildBackup() {
  const st = S();
  const docs = allDocs();
  const data = {};
  for (const k of [...ARRAYS, ...OBJECTS, 'lastBackup', 'firstUse']) data[k] = st[k];
  data.settings = { ...st.settings, apiKey: '' };
  const files = docs.map((d) => ({ name: d.name, kind: d.kind, units: d.units.length }));
  const scopeByFile = Object.fromEntries(docs.map((d) => [d.name, st.scope[d.id] || []]));
  return JSON.stringify({ app: 'socstudy', version: 2, exportedAt: new Date().toISOString(), files, scopeByFile, data }, null, 1);
}

export function downloadBackup() {
  const blob = new Blob([buildBackup()], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = backupFileName();
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  S().lastBackup = Date.now();
  flush();
}

// 형식 검사. 문제가 있으면 예외를 던지고, 기존 기록은 건드리지 않는다.
export function parseBackup(text) {
  let obj;
  try { obj = JSON.parse(text); } catch { throw new Error('백업 파일이 손상되었거나 JSON 형식이 아닙니다.'); }
  if (!obj || obj.app !== 'socstudy' || typeof obj.data !== 'object' || !obj.data) throw new Error('이 프로그램의 백업 파일이 아닙니다.');
  const d = obj.data;
  for (const k of ARRAYS) if (d[k] != null && !Array.isArray(d[k])) throw new Error(`백업 파일 형식이 올바르지 않습니다. (${k})`);
  for (const k of OBJECTS) if (d[k] != null && (typeof d[k] !== 'object' || Array.isArray(d[k]))) throw new Error(`백업 파일 형식이 올바르지 않습니다. (${k})`);
  if ((d.wrong || []).some((w) => !w || typeof w !== 'object' || !w.q)) throw new Error('백업 파일의 오답노트 항목이 손상되었습니다.');
  if ((d.bank || []).some((b) => !b || !b.id || !b.q)) throw new Error('백업 파일의 문제 은행 항목이 손상되었습니다.');
  return obj;
}

export function summarize(obj) {
  const d = obj.data;
  return `오답 ${(d.wrong || []).length}개 · 질문 기록 ${(d.qlog || []).length}개 · 채점 기록 ${(d.attempts || []).length}개 · 플래시카드 ${(d.cards || []).length}장 · 문제 은행 ${(d.bank || []).length}개 · 신고 ${(d.reports || []).length}개`;
}

const stamp = (x) => Math.max(x?.updatedAt || 0, x?.masteredAt || 0, x?.ts || 0, x?.last || 0, x?.lastAt || 0, x?.createdAt || 0, x?.created || 0);
const KEYS = {
  wrong: (w) => w.q?.id || w.id,
  qlog: (x) => x.id,
  attempts: (a) => `${a.ts}|${a.qid || ''}|${a.type}|${a.feature}`,
  cards: (c) => c.id,
  exams: (e) => String(e.ts),
  bank: (b) => b.id,
  reports: (r) => r.id,
};
function mergeList(cur = [], inc = [], keyFn) {
  const map = new Map();
  for (const x of cur) map.set(keyFn(x), x);
  for (const x of inc) {
    const k = keyFn(x);
    const have = map.get(k);
    if (!have || stamp(x) > stamp(have)) map.set(k, x);
  }
  return [...map.values()];
}
// 내용이 같은 항목(다른 id) 정리: 더 최근 것을 남긴다
function dedupeBy(list, keyFn) {
  const map = new Map();
  for (const x of list) {
    const k = keyFn(x);
    if (!k) { map.set(Symbol(), x); continue; }
    const have = map.get(k);
    if (!have || stamp(x) > stamp(have)) map.set(k, x);
  }
  return [...map.values()];
}

function scopeFromBackup(obj) {
  const out = {};
  for (const d of allDocs()) {
    const pages = obj.scopeByFile?.[d.name];
    if (Array.isArray(pages)) out[d.id] = pages.filter((n) => d.units.some((u) => u.n === n));
  }
  return out;
}

// mode: 'overwrite' | 'merge'
export function applyBackup(obj, mode) {
  const d = obj.data;
  const cur = S();
  let next;
  if (mode === 'overwrite') {
    next = { ...freshState(), firstUse: d.firstUse || Date.now() };
    for (const k of ARRAYS) next[k] = Array.isArray(d[k]) ? d[k] : [];
    for (const k of ['quoteBank', 'maps', 'recent']) next[k] = d[k] || {};
    next.scope = { ...cur.scope, ...scopeFromBackup(obj) };
    next.settings = cur.settings; // 설정(API 키, 모델)은 이 기기 것을 유지
    next.lastBackup = d.lastBackup || 0;
  } else {
    next = { ...cur };
    for (const k of ARRAYS) next[k] = mergeList(cur[k], d[k], KEYS[k]);
    next.cards = dedupeBy(next.cards, (c) => (c.front || '').replace(/\s/g, ''));
    next.bank = dedupeBy(next.bank, (b) => (b.q?.type && b.q?.stem ? `${b.q.type}|${b.q.stem.replace(/\s/g, '')}` : ''));
    next.quoteBank = { ...(d.quoteBank || {}), ...cur.quoteBank };
    for (const [k, v] of Object.entries(d.quoteBank || {})) {
      if (cur.quoteBank[k]) next.quoteBank[k] = { ...cur.quoteBank[k], quotes: mergeList(cur.quoteBank[k].quotes, v.quotes, (q) => q.id) };
    }
    next.maps = { ...(d.maps || {}), ...cur.maps };
    next.recent = { ...cur.recent };
    for (const [k, v] of Object.entries(d.recent || {})) next.recent[k] = [...new Set([...(cur.recent[k] || []), ...v])].slice(-15);
    const fromBackup = scopeFromBackup(obj);
    next.scope = { ...cur.scope };
    for (const [id, pages] of Object.entries(fromBackup)) if (!(cur.scope[id] || []).length) next.scope[id] = pages;
    next.lastBackup = Math.max(cur.lastBackup || 0, d.lastBackup || 0);
    next.firstUse = Math.min(cur.firstUse || Date.now(), d.firstUse || Date.now());
  }
  next.wrong.sort((a, b) => (b.ts || 0) - (a.ts || 0));
  next.qlog.sort((a, b) => (b.ts || 0) - (a.ts || 0));
  next.attempts.sort((a, b) => (a.ts || 0) - (b.ts || 0));
  next.exams.sort((a, b) => (b.ts || 0) - (a.ts || 0));
  next.reports.sort((a, b) => (b.ts || 0) - (a.ts || 0));
  replaceState(next);
}

export function backupOverdue() {
  const st = S();
  const hasRecords = ARRAYS.some((k) => (st[k] || []).length);
  if (!hasRecords) return false;
  const since = st.lastBackup || st.firstUse || Date.now();
  return Date.now() - since > BACKUP_REMIND_DAYS * 24 * 60 * 60 * 1000;
}
