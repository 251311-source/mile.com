// 백업 내보내기/불러오기 (덮어쓰기·합치기)와 백업 알림. 모든 과목 또는 한 과목만 내보낼 수 있다.
import { S, freshState, replaceState, flush } from './store.js';
import { allDocs } from './docs.js';
import { subject, SUBJECTS, SUBJECT_IDS } from './subjects.js';
import { readSubject, writeSubject } from './cloud.js';

export const BACKUP_REMIND_DAYS = 30;
const ARRAYS = ['wrong', 'qlog', 'attempts', 'cards', 'exams', 'bank', 'reports', 'pairs', 'mastered'];
const OBJECTS = ['quoteBank', 'maps', 'timelines', 'confusions', 'recent', 'scope'];

function localDate(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function backupFileName(only = null) {
  return `${only ? SUBJECTS[only].name : '학습'}_백업_${localDate()}.json`;
}

// 과목 하나의 백업 내용. 원본 PDF/PPT는 넣지 않고 파일 이름과 범위만 기록한다.
// docs: [{id, name, kind, units: 개수}]
function subjectPayload(st, docs) {
  const data = {};
  for (const k of [...ARRAYS, ...OBJECTS, 'firstUse']) data[k] = st[k];
  const files = docs.map((d) => ({ name: d.name, kind: d.kind, units: d.units }));
  const scopeByFile = Object.fromEntries(docs.map((d) => [d.name, st.scope?.[d.id] || []]));
  return { files, scopeByFile, data };
}
const docsOfMaterials = (list) => (list || []).map((m) => ({ id: m.id, name: m.name, kind: m.kind, units: (m.pages || []).length, pages: (m.pages || []).map((p) => p.n) }));
const currentDocs = () => allDocs().map((d) => ({ id: d.id, name: d.name, kind: d.kind, units: d.units.length, pages: d.units.map((u) => u.n) }));
const wrap = (subjects, st) => JSON.stringify({ app: 'socstudy', version: 3, exportedAt: new Date().toISOString(), lastBackup: st.lastBackup || 0, settings: { ...st.settings, apiKey: '', geminiKey: '', openrouterKey: '' }, subjects }, null, 1);

// only: 과목 id(그 과목만) 또는 null(모든 과목)
export async function buildBackup(only = null) {
  const subjects = {};
  for (const sid of only ? [only] : SUBJECT_IDS) {
    if (sid === subject().id) subjects[sid] = subjectPayload(S(), currentDocs());
    else {
      const { state, materials } = await readSubject(sid);
      subjects[sid] = subjectPayload(state, docsOfMaterials(materials));
    }
  }
  return wrap(subjects, S());
}
// 과목 구조로 옮기기 전 기록의 백업 (migrate.js)
export const buildBackupOf = (sid, st) => wrap({ [sid]: subjectPayload(st, docsOfMaterials(st.materials)) }, st);

export function saveFile(text, name) {
  const blob = new Blob([text], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

export async function downloadBackup(only = null) {
  saveFile(await buildBackup(only), backupFileName(only));
  S().lastBackup = Date.now();
  flush();
}

// 형식 검사. 문제가 있으면 예외를 던지고, 기존 기록은 건드리지 않는다.
// 예전 형식(version 2, 사회학만)은 사회학 과목으로 읽는다. 반환: { subjects: { 과목: {files, scopeByFile, data} } }
export function parseBackup(text) {
  let obj;
  try { obj = JSON.parse(text); } catch { throw new Error('백업 파일이 손상되었거나 JSON 형식이 아닙니다.'); }
  if (!obj || obj.app !== 'socstudy') throw new Error('이 프로그램의 백업 파일이 아닙니다.');
  if (!obj.subjects && obj.data) obj = { ...obj, subjects: { soc: { files: obj.files, scopeByFile: obj.scopeByFile, data: obj.data } } };
  if (!obj.subjects || typeof obj.subjects !== 'object') throw new Error('이 프로그램의 백업 파일이 아닙니다.');
  for (const [sid, p] of Object.entries(obj.subjects)) {
    if (!SUBJECTS[sid]) throw new Error(`알 수 없는 과목이 들어 있습니다. (${sid})`);
    if (!p || typeof p.data !== 'object' || !p.data) throw new Error('백업 파일 형식이 올바르지 않습니다.');
    checkData(p.data);
  }
  return obj;
}
function checkData(d) {
  for (const k of ARRAYS) if (d[k] != null && !Array.isArray(d[k])) throw new Error(`백업 파일 형식이 올바르지 않습니다. (${k})`);
  for (const k of OBJECTS) if (d[k] != null && (typeof d[k] !== 'object' || Array.isArray(d[k]))) throw new Error(`백업 파일 형식이 올바르지 않습니다. (${k})`);
  if ((d.wrong || []).some((w) => !w || typeof w !== 'object' || !w.q)) throw new Error('백업 파일의 오답노트 항목이 손상되었습니다.');
  if ((d.bank || []).some((b) => !b || !b.id || !b.q)) throw new Error('백업 파일의 문제 은행 항목이 손상되었습니다.');
}

export function summarizeData(d) {
  return `오답 ${(d.wrong || []).length}개 · 질문 기록 ${(d.qlog || []).length}개 · 채점 기록 ${(d.attempts || []).length}개 · 플래시카드 ${(d.cards || []).length}장 · 문제 은행 ${(d.bank || []).length}개 · 신고 ${(d.reports || []).length}개`;
}
export function summarize(obj) {
  return Object.entries(obj.subjects).map(([sid, p]) => `[${SUBJECTS[sid].name}] ${summarizeData(p.data)}`).join(' / ');
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
  pairs: (x) => x.id,
  mastered: (x) => String(x.name || '').replace(/\s+/g, ''),
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

function scopeFromBackup(p, docs) {
  const out = {};
  for (const d of docs) {
    const pages = p.scopeByFile?.[d.name];
    if (Array.isArray(pages)) out[d.id] = pages.filter((n) => d.pages.includes(n));
  }
  return out;
}

// mode: 'overwrite' | 'merge'. 백업에 든 과목마다 적용한다(현재 과목은 화면 상태로, 다른 과목은 계정에 바로 쓴다).
export async function applyBackup(obj, mode) {
  for (const [sid, p] of Object.entries(obj.subjects)) {
    if (sid === subject().id) {
      const next = combine(S(), p, mode, currentDocs());
      next.lastBackup = Math.max(S().lastBackup || 0, obj.lastBackup || p.data.lastBackup || 0);
      replaceState(next);
    } else {
      const { state, materials, docs } = await readSubject(sid);
      await writeSubject(sid, combine(state, p, mode, docsOfMaterials(materials)), docs);
    }
  }
}

// 과목 하나의 기록(cur)과 백업(p)을 합친 새 상태
function combine(cur, p, mode, docs) {
  const d = p.data;
  let next;
  if (mode === 'overwrite') {
    next = { ...freshState(), firstUse: d.firstUse || Date.now() };
    for (const k of ARRAYS) next[k] = Array.isArray(d[k]) ? d[k] : [];
    for (const k of ['quoteBank', 'maps', 'timelines', 'confusions', 'recent']) next[k] = d[k] || {};
    next.scope = { ...cur.scope, ...scopeFromBackup(p, docs) };
    // 설정(API 키, 모델)과 계정 공통 값은 그대로 둔다
    for (const k of ['settings', 'prefSubject', 'migratedAt', 'lastBackup']) next[k] = cur[k];
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
    next.timelines = { ...(d.timelines || {}), ...cur.timelines };
    next.confusions = { ...(d.confusions || {}), ...cur.confusions };
    next.pairs = dedupeBy(next.pairs, (x) => [x.a, x.b].map((s) => String(s || '').replace(/\s/g, '')).sort().join('|'));
    next.recent = { ...cur.recent };
    for (const [k, v] of Object.entries(d.recent || {})) next.recent[k] = [...new Set([...(cur.recent[k] || []), ...v])].slice(-15);
    const fromBackup = scopeFromBackup(p, docs);
    next.scope = { ...cur.scope };
    for (const [id, pages] of Object.entries(fromBackup)) if (!(cur.scope[id] || []).length) next.scope[id] = pages;
    next.firstUse = Math.min(cur.firstUse || Date.now(), d.firstUse || Date.now());
  }
  next.wrong.sort((a, b) => (b.ts || 0) - (a.ts || 0));
  next.qlog.sort((a, b) => (b.ts || 0) - (a.ts || 0));
  next.attempts.sort((a, b) => (a.ts || 0) - (b.ts || 0));
  next.exams.sort((a, b) => (b.ts || 0) - (a.ts || 0));
  next.reports.sort((a, b) => (b.ts || 0) - (a.ts || 0));
  return next;
}

export function backupOverdue() {
  const st = S();
  const hasRecords = ARRAYS.some((k) => (st[k] || []).length);
  if (!hasRecords) return false;
  const since = st.lastBackup || st.firstUse || Date.now();
  return Date.now() - since > BACKUP_REMIND_DAYS * 24 * 60 * 60 * 1000;
}
