// 계정 동기화: 기록을 users/{uid}/{컬렉션}/{항목} 문서로 나눠 저장하고, 바뀐 항목만 올린다.
// 다른 기기에서 바뀐 항목은 실시간으로 받아 반영한다. Firestore 오프라인 캐시 덕분에 인터넷이 없어도 동작한다.
import { fb, userCol, userDoc } from './firebase.js';
import { S, replaceState, freshState, onChange, flush } from './store.js';

// 항목 하나 = 문서 하나인 컬렉션과 문서 ID 규칙
const ID_COLS = {
  wrong: (x) => x.id,
  qlog: (x) => x.id,
  cards: (x) => x.id,
  exams: (x) => String(x.ts),
  bank: (x) => x.id,
  reports: (x) => x.id,
};
const SORT = {
  wrong: (a, b) => (b.ts || 0) - (a.ts || 0),
  qlog: (a, b) => (b.ts || 0) - (a.ts || 0),
  cards: (a, b) => (a.created || 0) - (b.created || 0),
  exams: (a, b) => (b.ts || 0) - (a.ts || 0),
  bank: (a, b) => (a.createdAt || 0) - (b.createdAt || 0),
  reports: (a, b) => (b.ts || 0) - (a.ts || 0),
};
const OBJ_COLS = ['quoteBank', 'maps'];        // { 키: 값 } → 키마다 문서
const SYNC_COLS = [...Object.keys(ID_COLS), 'attempts', ...OBJ_COLS, 'meta'];
export const ALL_COLS = [...SYNC_COLS, 'materials', 'pages', 'private'];
const ATTEMPT_CHUNK = 2000;                    // 채점 기록은 날짜별 문서(하루 2000개마다 나눔)
const MAX_DOC = 900 * 1024;

let uid = null;
let ready = false;
// 서버에서 한 번이라도 최신 상태를 받은 컬렉션. 모두 받기 전에는 계정에 쓰지 않는다
// (느린 연결에서 빈 화면 상태로 계정의 기록을 덮어쓰는 일을 막는다).
let fromServer = new Set();
const canWrite = () => fromServer.size === SYNC_COLS.length || (!navigator.onLine && synced.has('meta/state'));
let synced = new Map(); // "컬렉션/문서ID" → 계정에 있는 JSON (마지막으로 맞춘 상태)
let unsubs = [];
let timer = null;
let pending = 0;
let failed = false;

const day = (ts) => { const d = new Date(ts || 0); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const metaOf = (st) => ({ scope: st.scope, recent: st.recent, lastBackup: st.lastBackup || 0, firstUse: st.firstUse, settings: { model: st.settings.model, effort: st.settings.effort, maxChars: st.settings.maxChars, provider: st.settings.provider, geminiModel: st.settings.geminiModel } });
// API 키는 meta가 아니라 private 문서에만 둔다
export const SECRET_FIELDS = ['apiKey', 'geminiKey'];
const secretsOf = (settings) => Object.fromEntries(SECRET_FIELDS.map((k) => [k, settings[k] || '']));

function toDocs(st) {
  const out = new Map();
  for (const [col, key] of Object.entries(ID_COLS)) for (const x of st[col] || []) { const id = key(x); if (id) out.set(`${col}/${id}`, JSON.stringify(x)); }
  const byDay = new Map();
  for (const a of st.attempts || []) { const d = day(a.ts); if (!byDay.has(d)) byDay.set(d, []); byDay.get(d).push(a); }
  for (const [d, list] of byDay) for (let i = 0; i < list.length; i += ATTEMPT_CHUNK) out.set(`attempts/${d}${i ? '_' + i / ATTEMPT_CHUNK : ''}`, JSON.stringify(list.slice(i, i + ATTEMPT_CHUNK)));
  for (const col of OBJ_COLS) for (const [k, v] of Object.entries(st[col] || {})) out.set(`${col}/${k}`, JSON.stringify(v));
  out.set('meta/state', JSON.stringify(metaOf(st)));
  return out;
}

// ---------- 저장 상태 표시 ----------
let statusEl = null;
function setStatus() {
  if (!statusEl) return;
  let text, cls;
  if (!navigator.onLine) { text = '오프라인 – 연결되면 저장돼요'; cls = 'offline'; }
  else if (!ready) { text = '불러오는 중…'; cls = 'saving'; }
  else if (failed) { text = '저장 실패 – 다시 시도할게요'; cls = 'error'; }
  else if (pending > 0 || timer || (ready && !canWrite())) { text = '저장 중…'; cls = 'saving'; }
  else { text = '저장됨'; cls = 'saved'; }
  statusEl.textContent = (cls === 'saved' ? '✔ ' : cls === 'offline' ? '⚡ ' : '') + text;
  statusEl.className = 'sync-status ' + cls;
}
function mountStatus() {
  if (statusEl) return;
  statusEl = document.createElement('div');
  statusEl.id = 'sync-status';
  statusEl.setAttribute('role', 'status');
  statusEl.setAttribute('aria-live', 'polite');
  document.body.appendChild(statusEl);
  window.addEventListener('online', () => { setStatus(); schedule(); });
  // 창을 닫거나 새로 고칠 때는 기다리지 않고 바로 저장 대기열에 넣는다(오프라인 캐시에 남았다가 다음에 올라감)
  const now = () => { clearTimeout(timer); timer = null; syncNow(); };
  window.addEventListener('pagehide', now);
  window.addEventListener('beforeunload', now);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') now(); });
  window.addEventListener('offline', setStatus);
  setStatus();
}

// ---------- 올리기 ----------
function schedule() {
  if (!ready) return;
  clearTimeout(timer);
  timer = setTimeout(() => { timer = null; syncNow(); }, 250);
  setStatus();
}

export function syncNow() {
  if (!ready || !uid) return;
  if (!canWrite()) { setStatus(); return; } // 서버 기록을 다 받은 뒤에 올린다
  const { F, db } = fb;
  const cur = toDocs(S());
  const ops = [];
  for (const [k, v] of cur) if (synced.get(k) !== v) ops.push([k, v]);
  for (const k of synced.keys()) if (!cur.has(k)) ops.push([k, null]);
  if (!ops.length) { setStatus(); return; }
  for (const [k, v] of ops) (v == null ? synced.delete(k) : synced.set(k, v));
  for (let i = 0; i < ops.length; i += 400) {
    const batch = F.writeBatch(db);
    const part = ops.slice(i, i + 400);
    for (const [k, v] of part) {
      const [col, id] = splitKey(k);
      const ref = userDoc(uid, col, id);
      if (v == null) batch.delete(ref);
      else if (v.length > MAX_DOC) console.warn('문서가 너무 커서 건너뜀', k, v.length);
      else batch.set(ref, { v, t: Date.now() });
    }
    pending++;
    setStatus();
    batch.commit().then(() => { failed = false; }).catch((e) => {
      console.error('저장 실패', e);
      failed = true;
      for (const [k] of part) synced.delete(k); // 다음 변경 때 다시 올린다
      setTimeout(schedule, 5000);
    }).finally(() => { pending--; setStatus(); });
  }
}
const splitKey = (k) => { const i = k.indexOf('/'); return [k.slice(0, i), k.slice(i + 1)]; };

// ---------- 받기 ----------
function assemble() {
  const st = freshState();
  st.settings = { ...st.settings, ...secretsOf(S().settings) };
  const attempts = [];
  for (const [k, json] of synced) {
    const [col, id] = splitKey(k);
    const v = JSON.parse(json);
    if (ID_COLS[col]) st[col].push(v);
    else if (col === 'attempts') attempts.push(...v);
    else if (OBJ_COLS.includes(col)) st[col][id] = v;
    else if (col === 'meta') applyMeta(st, v);
  }
  st.attempts = attempts.sort((a, b) => (a.ts || 0) - (b.ts || 0));
  for (const col of Object.keys(SORT)) st[col].sort(SORT[col]);
  return st;
}
function applyMeta(st, m) {
  st.scope = m.scope || {};
  st.recent = m.recent || {};
  st.lastBackup = m.lastBackup || 0;
  if (m.firstUse) st.firstUse = m.firstUse;
  st.settings = { ...st.settings, ...(m.settings || {}), ...secretsOf(st.settings) };
}

function applyRemote(col, id, value) {
  const st = S();
  if (ID_COLS[col]) {
    const arr = st[col];
    const i = arr.findIndex((x) => ID_COLS[col](x) === id);
    if (value == null) { if (i >= 0) arr.splice(i, 1); }
    else if (i >= 0) arr[i] = value;
    else arr.push(value);
    arr.sort(SORT[col]);
  } else if (col === 'attempts') {
    const d = id.split('_')[0];
    const keep = st.attempts.filter((a) => day(a.ts) !== d);
    const fromDay = [];
    for (const [k, json] of synced) if (k.startsWith(`attempts/${d}`)) fromDay.push(...JSON.parse(json));
    st.attempts = [...keep, ...fromDay].sort((a, b) => (a.ts || 0) - (b.ts || 0));
  } else if (OBJ_COLS.includes(col)) {
    if (value == null) delete st[col][id]; else st[col][id] = value;
  } else if (col === 'meta' && value) {
    applyMeta(st, value);
  }
}

function onSnap(col, snap) {
  let changed = false;
  const changes = snap.docChanges();
  if (ready && changes.some((c) => !c.doc.metadata.hasPendingWrites)) syncNow(); // 이 기기의 미저장 변경을 먼저 올린다
  for (const c of changes) {
    const d = c.doc;
    // 준비된 뒤의 미확정 쓰기는 이 기기가 방금 쓴 것(메아리)이라 건너뛴다.
    // 시작할 때는 지난번에 못 올린 쓰기(오프라인 대기열)도 포함해야 기록이 사라지지 않는다.
    if (ready && d.metadata.hasPendingWrites) continue;
    const key = `${col}/${d.id}`;
    if (c.type === 'removed') {
      if (!synced.has(key)) continue;
      if (ready && key === 'meta/state') { accountGone(); return; } // 다른 기기에서 계정을 탈퇴함
      synced.delete(key);
      if (ready) applyRemote(col, d.id, null);
      changed = true;
      continue;
    }
    const json = d.data()?.v;
    if (typeof json !== 'string' || synced.get(key) === json) continue;
    synced.set(key, json);
    if (ready) { try { applyRemote(col, d.id, JSON.parse(json)); } catch (e) { console.warn(e); } }
    changed = true;
  }
  if (ready && changed) { flush(); document.dispatchEvent(new CustomEvent('remotechange')); } // 화면 갱신(올릴 변경은 없음)
}

// 로그인 직후: 계정 데이터를 불러와 화면 상태로 만든다.
export async function startSync(userId) {
  uid = userId;
  ready = false;
  synced = new Map();
  fromServer = new Set();
  mountStatus();
  const { F } = fb;
  // 온라인이면 서버 기준 첫 결과(캐시가 아닌)를 기다린다. 오프라인이거나 늦으면 캐시로 시작한다.
  await Promise.all(SYNC_COLS.map((col) => new Promise((resolve) => {
    let first = true;
    const done = () => { if (first) { first = false; resolve(); } };
    setTimeout(done, 15000);
    unsubs.push(F.onSnapshot(userCol(uid, col), { includeMetadataChanges: true }, (snap) => {
      onSnap(col, snap);
      if (!snap.metadata.fromCache && !fromServer.has(col)) {
        fromServer.add(col);
        if (ready && canWrite()) syncNow(); // 기다리던 변경을 이제 올린다
      }
      if (!snap.metadata.fromCache || !navigator.onLine) done();
    }, (err) => {
      console.error(col, err);
      failed = true;
      setStatus();
      if (first) { first = false; resolve(); }
    }));
  })));
  replaceState(assemble());
  ready = true;
  onChange(schedule);
  syncNow(); // 새 계정이면 기본 설정 문서 생성
  setStatus();
}

function accountGone() {
  stopSync();
  document.dispatchEvent(new CustomEvent('accountgone'));
}

export async function stopSync() {
  unsubs.forEach((u) => u());
  unsubs = [];
  ready = false;
  uid = null;
}

export const hasUnsaved = () => pending > 0 || !!timer;
export async function waitSaved(ms = 4000) {
  if (timer) { clearTimeout(timer); timer = null; syncNow(); }
  const t0 = Date.now();
  while (pending > 0 && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 100));
  return pending === 0;
}

// ---------- 개인 설정(API 키): users/{uid}/private/settings — 본인만 읽고 쓸 수 있다 ----------
export async function loadPrivate(userId) {
  const { F } = fb;
  const apply = (snap) => {
    let changed = false;
    for (const k of SECRET_FIELDS) {
      const v = snap.exists() ? snap.data()[k] || '' : '';
      if (v !== (S().settings[k] || '')) { S().settings[k] = v; changed = true; }
    }
    return changed;
  };
  try {
    apply(await F.getDoc(userDoc(userId, 'private', 'settings')));
  } catch (e) {
    console.warn('개인 설정을 불러오지 못했습니다', e);
  }
  // 다른 기기에서 키를 바꾸면 반영
  unsubs.push(F.onSnapshot(userDoc(userId, 'private', 'settings'), (snap) => {
    if (snap.metadata.hasPendingWrites) return;
    if (apply(snap)) flush();
  }, () => {}));
}
// field: 'apiKey'(Anthropic) 또는 'geminiKey'(Google Gemini)
export async function saveSecret(field, value, userId = uid) {
  S().settings[field] = value;
  const { F } = fb;
  pending++;
  setStatus();
  try {
    await F.setDoc(userDoc(userId, 'private', 'settings'), { [field]: value, t: Date.now() }, { merge: true });
  } finally {
    pending--;
    setStatus();
  }
}
export const saveApiKey = (key) => saveSecret('apiKey', key);

// ---------- 자료 분석 결과: users/{uid}/materials/{docId} ----------
export async function loadMaterials() {
  const { F } = fb;
  try {
    const snap = await F.getDocs(userCol(uid, 'materials'));
    return snap.docs.map((d) => { try { return JSON.parse(d.data().v); } catch { return null; } }).filter(Boolean);
  } catch (e) {
    console.warn('자료 분석 결과를 불러오지 못했습니다', e);
    return [];
  }
}
export function saveMaterial(m) {
  const { F } = fb;
  const v = JSON.stringify(m);
  if (v.length > MAX_DOC) { console.warn('분석 결과가 너무 큽니다', m.name); return Promise.resolve(); }
  pending++;
  setStatus();
  return F.setDoc(userDoc(uid, 'materials', m.id), { v, t: Date.now() }).finally(() => { pending--; setStatus(); });
}
// ---------- 자료 본문: users/{uid}/pages/{docId}_{n} (쪽 텍스트를 약 300KB씩 묶어 저장) ----------
const PAGE_CHUNK = 300 * 1024;
export async function saveDocText(doc) {
  const { F, db } = fb;
  const parts = [];
  let cur = [], size = 0;
  for (const u of doc.units) {
    const s = JSON.stringify({ n: u.n, title: u.title || '', text: u.text });
    if (cur.length && size + s.length > PAGE_CHUNK) { parts.push(cur); cur = []; size = 0; }
    cur.push({ n: u.n, title: u.title || '', text: u.text });
    size += s.length;
  }
  if (cur.length) parts.push(cur);
  await deleteDocText(doc.id); // 같은 자료를 다시 올린 경우 이전 묶음 정리
  pending++;
  setStatus();
  try {
    for (let i = 0; i < parts.length; i += 20) {
      const batch = F.writeBatch(db);
      parts.slice(i, i + 20).forEach((units, k) => {
        batch.set(userDoc(uid, 'pages', `${doc.id}_${i + k}`), { v: JSON.stringify({ docId: doc.id, part: i + k, units }), t: Date.now() });
      });
      await batch.commit();
    }
  } finally {
    pending--;
    setStatus();
  }
}
// docId → units[] (계정에 저장된 모든 자료 본문)
export async function loadAllDocText() {
  const { F } = fb;
  const out = new Map();
  try {
    const snap = await F.getDocs(userCol(uid, 'pages'));
    const parts = snap.docs.map((d) => { try { return JSON.parse(d.data().v); } catch { return null; } }).filter(Boolean).sort((a, b) => a.part - b.part);
    for (const p of parts) { if (!out.has(p.docId)) out.set(p.docId, []); out.get(p.docId).push(...p.units); }
  } catch (e) {
    console.warn('자료 본문을 불러오지 못했습니다', e);
  }
  return out;
}
export async function deleteDocText(docId) {
  const { F, db } = fb;
  try {
    const snap = await F.getDocs(F.query(userCol(uid, 'pages'), F.where(F.documentId(), '>=', docId + '_'), F.where(F.documentId(), '<', docId + '_\uf8ff')));
    if (!snap.docs.length) return;
    const batch = F.writeBatch(db);
    snap.docs.forEach((d) => batch.delete(d.ref));
    await batch.commit();
  } catch (e) {
    console.warn(e);
  }
}

export function deleteMaterial(id) {
  const { F } = fb;
  return F.deleteDoc(userDoc(uid, 'materials', id)).catch((e) => console.warn(e));
}

// ---------- 계정 데이터 전체 삭제 ----------
export async function deleteAllUserData(userId) {
  const { F, db } = fb;
  await stopSync();
  for (const col of ALL_COLS) {
    const snap = await F.getDocs(userCol(userId, col));
    for (let i = 0; i < snap.docs.length; i += 400) {
      const batch = F.writeBatch(db);
      snap.docs.slice(i, i + 400).forEach((d) => batch.delete(d.ref));
      await batch.commit();
    }
  }
}

export const currentUid = () => uid;
