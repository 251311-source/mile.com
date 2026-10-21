// 문제 은행: 검증을 통과한 문제를 저장하고, 조건에 맞는 문제를 우선순위에 따라 다시 꺼낸다.
import { S, save, bankEntry } from './store.js';
import { allDocs, docByTag } from './docs.js';
import { shuffle } from './ui.js';

// 출처를 파일명으로도 기억해 두면, 다시 올린 자료(태그가 바뀐 경우)에서도 범위를 맞출 수 있다.
function srcFiles(q) {
  const list = q.type === 'passage' ? q.data?.sources || q.sources : q.sources;
  return (list || []).map((s) => ({ file: docByTag(String(s.doc))?.name || '', doc: s.doc, page: Number(s.page) })).filter((s) => s.page);
}

export function saveToBank(q, { feature, kind = 'quiz', correctedFrom = null } = {}) {
  if (!q?.id || bankEntry(q.id)) return bankEntry(q.id);
  const e = {
    id: q.id, q, kind, feature, verified: true, status: 'active', correctedFrom,
    files: srcFiles(q), asked: 0, correct: 0, streak: 0, lastResult: null, lastAt: 0,
    createdAt: Date.now(), updatedAt: Date.now(),
  };
  S().bank.push(e);
  save();
  return e;
}
export const saveAll = (qs, opts) => qs.forEach((q) => saveToBank(q, opts));

export function setBankStatus(qid, status) {
  const e = bankEntry(qid);
  if (e) { e.status = status; e.updatedAt = Date.now(); save(); }
}

// 현재 학습 범위 안의 쪽만 근거로 삼는 문제인지 확인하고, 현재 자료 태그로 출처를 맞춘 사본을 돌려준다.
export function inScopeCopy(e) {
  if (!e.files?.length) return null;
  const docs = allDocs();
  const remapped = [];
  for (const f of e.files) {
    const doc = docs.find((d) => d.name === f.file) || (!f.file && docByTag(f.doc));
    if (!doc || !(S().scope[doc.id] || []).includes(f.page)) return null;
    remapped.push({ doc: doc.tag, page: f.page });
  }
  return { ...e.q, sources: remapped };
}

export const usable = (e) => e.status === 'active' && e.verified;

// 우선순위: 틀렸거나 안 푼 문제 > 한 번 맞힌 문제(가끔) > 3번 연속 맞힌 문제(드물게)
function weight(e) {
  if (!e.asked || e.lastResult === false || !e.streak) return 10;
  if (e.streak < 3) return Math.random() < 0.5 ? 3 : 0;
  return Math.random() < 0.15 ? 1 : 0;
}
function weightedPick(cands, n) {
  const pool = cands.map((c) => ({ c, w: weight(c.e) })).filter((x) => x.w > 0);
  const out = [];
  while (out.length < n && pool.length) {
    const total = pool.reduce((a, x) => a + x.w, 0);
    let r = Math.random() * total;
    const i = pool.findIndex((x) => (r -= x.w) <= 0);
    out.push(pool.splice(i < 0 ? 0 : i, 1)[0].c);
  }
  return out;
}

const matchesFocus = (q, focus) => {
  if (!focus) return true;
  const words = focus.split(/[,\s]+/).filter(Boolean);
  const hay = [q.stem, q.context, ...(q.concepts || []), ...(q.sociologists || [])].join(' ');
  return words.some((w) => hay.includes(w));
};

// 계획된 유형 목록(slots)마다 은행에서 채울 수 있는 문제를 고른다. 채우지 못한 칸은 null.
export function pickFromBank({ slots, difficulty, focus, exclude = new Set() }) {
  const cands = [];
  for (const e of S().bank) {
    if (!usable(e) || e.kind !== 'quiz' || exclude.has(e.id)) continue;
    if (e.q.difficulty !== difficulty || !matchesFocus(e.q, focus)) continue;
    const q = inScopeCopy(e);
    if (q) cands.push({ e, q });
  }
  const byType = {};
  cands.forEach((c) => (byType[c.q.type] ||= []).push(c));
  const need = {};
  slots.forEach((t) => { need[t] = (need[t] || 0) + 1; });
  const picked = {};
  for (const [t, n] of Object.entries(need)) picked[t] = weightedPick(shuffle(byType[t] || []), n);
  return slots.map((t) => (picked[t].length ? picked[t].shift().q : null));
}

// 같은 범위·주제의 기존 문제 (새로 만들 때 겹치지 않게 AI에 넘긴다)
export function existingStems({ focus, types, limit = 40 }) {
  const list = S().bank.filter((e) => e.kind === 'quiz' && e.status !== 'excluded' && (!types || types.includes(e.q.type)) && matchesFocus(e.q, focus) && inScopeCopy(e));
  return list.slice(-limit).map((e) => `[${e.q.type}] ${e.q.stem.slice(0, 70)}${e.q.concepts?.length ? ' (' + e.q.concepts.join(',') + ')' : ''}`);
}

// 거의 같은 문제인지 (글자 2-gram 자카드 유사도)
function grams(s) {
  const t = String(s || '').replace(/\s+/g, '');
  const g = new Set();
  for (let i = 0; i < t.length - 1; i++) g.add(t.slice(i, i + 2));
  return g;
}
export function similarity(a, b) {
  const A = grams(a), B = grams(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  A.forEach((x) => { if (B.has(x)) inter++; });
  return inter / (A.size + B.size - inter);
}
const signature = (q) => [q.stem, q.context, ...(q.options || []), q.answer_text, (q.order_items || []).join(' ')].join(' ');
export function isNearDuplicate(q, others) {
  const sig = signature(q);
  return others.some((o) => o.type === q.type && similarity(sig, signature(o)) > 0.82);
}
export function bankQuizQuestions() {
  return S().bank.filter((e) => e.kind === 'quiz' && e.status !== 'excluded').map((e) => e.q);
}
