// PDF/PPTX 파싱, 자료 목록, 학습 범위 관리.
import { docsDB, S, save, uid, settings } from './store.js';
import { loadMaterials, saveMaterial, deleteMaterial, currentUid } from './cloud.js';

const PDFJS = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@6.3.289';
const JSZIP = 'https://cdn.jsdelivr.net/npm/jszip@3.10.1/+esm';

let docs = [];
export const allDocs = () => docs;
export const docById = (id) => docs.find((d) => d.id === id);
export const docByTag = (tag) => docs.find((d) => d.tag === tag);

// 계정에 저장된 자료 분석 결과 + 이 기기에 있는 원본(IndexedDB)을 합친다.
// 원본이 없는 자료는 분석 결과(핵심 문장)만으로 동작한다.
export async function loadDocs() {
  const owner = currentUid();
  const local = (await docsDB.all()).filter((d) => d.owner === owner);
  const materials = await loadMaterials();
  const { docFromAnalysis } = await import('./analysis.js');
  const out = [];
  for (const m of materials) {
    const full = local.find((d) => d.id === m.id);
    out.push(full ? { ...full, tag: m.tag, analysis: m } : docFromAnalysis(m));
  }
  // 분석 결과를 아직 못 올린 원본(오프라인 등)도 보여 주고 다시 올린다
  for (const d of local) if (!materials.some((m) => m.id === d.id)) { out.push(d); syncAnalysis(d); }
  docs = out.sort((a, b) => (a.addedAt || 0) - (b.addedAt || 0));
  return docs;
}

// 로그인 이전 버전에서 이 브라우저에 올린 자료 (계정으로 옮기기용)
export async function legacyDocs() {
  return (await docsDB.all()).filter((d) => !d.owner);
}
export async function adoptLegacyDocs(list) {
  for (const d of list) {
    if (docs.some((x) => x.id === d.id || x.name === d.name)) continue;
    const doc = { ...d, owner: currentUid(), tag: nextTag() };
    await docsDB.put(doc);
    docs.push(doc);
    await syncAnalysis(doc);
  }
}

// 분석 결과를 계정에 올린다. API 키가 없거나 실패하면 구조만 올리고 나중에 다시 분석할 수 있게 둔다.
export async function syncAnalysis(doc, { analyze = true } = {}) {
  const { structureOf, analyzeDoc } = await import('./analysis.js');
  let m = doc.analysis?.analyzed ? doc.analysis : structureOf(doc);
  if (analyze && !m.analyzed && (settings().apiKey || settings().geminiKey)) {
    if (!doc.analysis) { m.tag = doc.tag; saveMaterial(m).catch(() => {}); } // 구조부터 먼저 올려 둔다
    doc.analyzing = true;
    document.dispatchEvent(new CustomEvent('docanalysis', { detail: doc }));
    try { m = await analyzeDoc(doc); } catch (e) { console.warn('자료 분석 실패', e); m.analysisError = e.message; }
    doc.analyzing = false;
  }
  m.tag = doc.tag;
  doc.analysis = m;
  try { await saveMaterial(m); } catch (e) { console.warn('분석 결과 저장 실패', e); }
  document.dispatchEvent(new CustomEvent('docanalysis', { detail: doc }));
  return m;
}
export const needsOriginal = () => [...new Set(scopeUnits().filter((x) => x.doc.analysisOnly).map((x) => x.doc.name))];

export const unitName = (doc) => (doc.kind === 'pptx' ? '슬라이드' : '쪽');
export const unitLabel = (doc, n) => (doc.kind === 'pptx' ? `슬라이드 ${n}` : `p.${n}`);

function nextTag() {
  const used = new Set(docs.map((d) => d.tag));
  let i = 1;
  while (used.has('D' + i)) i++;
  return 'D' + i;
}

export async function addFile(file, onProgress = () => {}) {
  const lower = file.name.toLowerCase();
  let parsed;
  if (lower.endsWith('.pdf')) parsed = await parsePdf(file, onProgress);
  else if (lower.endsWith('.pptx')) parsed = await parsePptx(file, onProgress);
  else if (lower.endsWith('.ppt')) throw new Error(`${file.name}: 구형 .ppt 형식은 읽을 수 없습니다. PowerPoint에서 .pptx로 저장한 뒤 올려 주세요.`);
  else throw new Error(`${file.name}: PDF 또는 PPTX 파일만 올릴 수 있습니다.`);

  // 같은 이름의 자료가 계정에 있으면 그 분석 결과에 연결한다(다른 기기에서 다시 올린 경우).
  const same = docs.find((d) => d.name === file.name);
  if (same) {
    const doc = { ...parsed, id: same.id, tag: same.tag, name: file.name, addedAt: same.addedAt || Date.now(), owner: currentUid(), analysis: same.analysis };
    await docsDB.put(doc);
    docs[docs.indexOf(same)] = doc;
    if (!doc.analysis?.analyzed) syncAnalysis(doc);
    save();
    doc.linked = true;
    return doc;
  }
  const doc = { id: uid(), tag: nextTag(), name: file.name, addedAt: Date.now(), owner: currentUid(), ...parsed };
  await docsDB.put(doc);
  docs.push(doc);
  // 새 자료는 기본적으로 전체 범위 선택
  S().scope[doc.id] = doc.units.filter((u) => u.text.trim()).map((u) => u.n);
  save();
  syncAnalysis(doc); // 분석은 뒤에서 진행 (끝나면 docanalysis 이벤트)
  return doc;
}

export async function removeDoc(id) {
  await docsDB.remove(id);
  await deleteMaterial(id);
  docs = docs.filter((d) => d.id !== id);
  delete S().scope[id];
  save();
}

// ---------- PDF ----------
let pdfjsP = null;
async function pdfjs() {
  if (!pdfjsP) {
    pdfjsP = import(`${PDFJS}/build/pdf.min.mjs`).then((lib) => {
      lib.GlobalWorkerOptions.workerSrc = `${PDFJS}/build/pdf.worker.min.mjs`;
      return lib;
    });
  }
  return pdfjsP;
}

async function parsePdf(file, onProgress) {
  const lib = await pdfjs();
  const data = new Uint8Array(await file.arrayBuffer());
  const task = lib.getDocument({
    data,
    cMapUrl: `${PDFJS}/cmaps/`,
    cMapPacked: true,
    standardFontDataUrl: `${PDFJS}/standard_fonts/`,
  });
  const pdf = await task.promise;
  const units = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const tc = await page.getTextContent();
    let text = '';
    let lastY = null;
    for (const it of tc.items) {
      if (!('str' in it)) continue;
      const y = it.transform ? it.transform[5] : null;
      if (lastY !== null && y !== null && Math.abs(y - lastY) > 2 && !text.endsWith('\n')) text += '\n';
      text += it.str;
      if (it.hasEOL) text += '\n';
      lastY = y;
    }
    text = text.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
    const firstLine = text.split('\n').find((l) => l.trim().length > 1) || '';
    units.push({ n: i, text, title: firstLine.slice(0, 60) });
    onProgress(i / pdf.numPages);
  }
  const chapters = await pdfChapters(pdf, units.length);
  await task.destroy();
  return { kind: 'pdf', units, chapters };
}

async function pdfChapters(pdf, total) {
  try {
    const outline = await pdf.getOutline();
    if (!outline || !outline.length) return [];
    const starts = [];
    const visit = async (items, depth) => {
      for (const it of items) {
        let dest = it.dest;
        if (typeof dest === 'string') dest = await pdf.getDestination(dest);
        if (Array.isArray(dest) && dest[0]) {
          const idx = typeof dest[0] === 'number' ? dest[0] : await pdf.getPageIndex(dest[0]);
          starts.push({ title: (depth ? '　'.repeat(depth) : '') + it.title, start: idx + 1, depth });
        }
        if (depth < 1 && it.items && it.items.length) await visit(it.items, depth + 1);
      }
    };
    await visit(outline, 0);
    starts.sort((a, b) => a.start - b.start || a.depth - b.depth);
    return starts.map((c, i) => {
      // 다음 같은 수준(또는 상위) 항목 직전까지
      const next = starts.slice(i + 1).find((x) => x.depth <= c.depth && x.start > c.start);
      return { title: c.title, start: c.start, end: next ? next.start - 1 : total };
    });
  } catch {
    return [];
  }
}

// ---------- PPTX ----------
async function parsePptx(file, onProgress) {
  const mod = await import(JSZIP);
  const JSZip = mod.default || mod;
  const zip = await JSZip.loadAsync(await file.arrayBuffer());
  const parser = new DOMParser();
  const readXml = async (path) => {
    const f = zip.file(path);
    return f ? parser.parseFromString(await f.async('string'), 'application/xml') : null;
  };
  const rels = async (path) => {
    const dir = path.substring(0, path.lastIndexOf('/'));
    const name = path.substring(path.lastIndexOf('/') + 1);
    const x = await readXml(`${dir}/_rels/${name}.rels`);
    const map = {};
    if (x) for (const r of x.getElementsByTagName('Relationship')) map[r.getAttribute('Id')] = { target: resolvePath(dir, r.getAttribute('Target')), type: r.getAttribute('Type') || '' };
    return map;
  };

  const pres = await readXml('ppt/presentation.xml');
  const presRels = await rels('ppt/presentation.xml');
  let slidePaths = [];
  const idToNum = {};
  if (pres) {
    const lst = pres.getElementsByTagNameNS('*', 'sldIdLst')[0];
    const ids = lst ? [...lst.children] : [];
    ids.forEach((el, i) => {
      const rid = el.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'id') || el.getAttribute('r:id');
      if (presRels[rid]) slidePaths.push(presRels[rid].target);
      idToNum[el.getAttribute('id')] = i + 1;
    });
  }
  if (!slidePaths.length) {
    slidePaths = Object.keys(zip.files)
      .filter((p) => /^ppt\/slides\/slide\d+\.xml$/.test(p))
      .sort((a, b) => parseInt(a.match(/\d+/)[0]) - parseInt(b.match(/\d+/)[0]));
  }

  const units = [];
  for (let i = 0; i < slidePaths.length; i++) {
    const x = await readXml(slidePaths[i]);
    let title = '';
    const lines = [];
    if (x) {
      for (const sp of x.getElementsByTagNameNS('*', 'sp')) {
        const ph = sp.getElementsByTagNameNS('*', 'ph')[0];
        const isTitle = ph && /title/i.test(ph.getAttribute('type') || '');
        const paras = [...sp.getElementsByTagNameNS('*', 'p')]
          .map((p) => [...p.getElementsByTagNameNS('*', 't')].map((t) => t.textContent).join(''))
          .filter((s) => s.trim());
        if (isTitle && !title) title = paras.join(' ');
        lines.push(...paras);
      }
      // 표 안의 텍스트
      for (const tc of x.getElementsByTagNameNS('*', 'tc')) {
        const s = [...tc.getElementsByTagNameNS('*', 't')].map((t) => t.textContent).join(' ').trim();
        if (s && !lines.includes(s)) lines.push(s);
      }
    }
    // 발표자 노트
    const sr = await rels(slidePaths[i]);
    const notes = Object.values(sr).find((r) => /notesSlide/.test(r.type));
    if (notes) {
      const nx = await readXml(notes.target);
      if (nx) {
        const body = [...nx.getElementsByTagNameNS('*', 'sp')]
          .filter((sp) => { const ph = sp.getElementsByTagNameNS('*', 'ph')[0]; return ph && ph.getAttribute('type') === 'body'; })
          .flatMap((sp) => [...sp.getElementsByTagNameNS('*', 'p')].map((p) => [...p.getElementsByTagNameNS('*', 't')].map((t) => t.textContent).join('')))
          .filter((s) => s.trim());
        if (body.length) lines.push('[발표자 노트] ' + body.join(' '));
      }
    }
    units.push({ n: i + 1, text: lines.join('\n').trim(), title: (title || lines[0] || '').slice(0, 60) });
    onProgress((i + 1) / slidePaths.length);
  }

  // PowerPoint 구역(section)을 단원으로 사용
  const chapters = [];
  if (pres) {
    const sections = [...pres.getElementsByTagNameNS('*', 'section')];
    for (const sec of sections) {
      const nums = [...sec.getElementsByTagNameNS('*', 'sldId')].map((e) => idToNum[e.getAttribute('id')]).filter(Boolean);
      if (nums.length) chapters.push({ title: sec.getAttribute('name') || '구역', start: Math.min(...nums), end: Math.max(...nums) });
    }
  }
  return { kind: 'pptx', units, chapters };
}

function resolvePath(dir, target) {
  if (target.startsWith('/')) return target.slice(1);
  const parts = dir.split('/');
  for (const seg of target.split('/')) {
    if (seg === '..') parts.pop();
    else if (seg !== '.') parts.push(seg);
  }
  return parts.join('/');
}

// ---------- 범위 ----------
export function scopeUnits() {
  const out = [];
  for (const d of docs) {
    const sel = new Set(S().scope[d.id] || []);
    for (const u of d.units) if (sel.has(u.n) && u.text.trim()) out.push({ doc: d, unit: u });
  }
  return out;
}
export const hasScope = () => scopeUnits().length > 0;

export function scopeKey() {
  const parts = docs.map((d) => `${d.id}:${(S().scope[d.id] || []).join(',')}`).join('|');
  let h = 0;
  for (let i = 0; i < parts.length; i++) h = (h * 31 + parts.charCodeAt(i)) | 0;
  return 'k' + (h >>> 0).toString(36);
}

export function scopeSummary() {
  const units = scopeUnits();
  const files = new Set(units.map((x) => x.doc.id)).size;
  const chars = units.reduce((a, x) => a + x.unit.text.length, 0);
  return { files, units: units.length, chars };
}

// 모델에 보낼 자료 본문. [[D1:p12]] 표지가 출처 표기의 근거가 된다.
let materialCache = { key: null, value: null };
export function buildMaterial() {
  const key = scopeKey() + ':' + settings().maxChars;
  if (materialCache.key === key) return materialCache.value;
  const max = Number(settings().maxChars) || 400000;
  let total = 0;
  let truncated = false;
  const byDoc = new Map();
  for (const { doc, unit } of scopeUnits()) {
    const block = `[[${doc.tag}:${unit.n}]]\n${unit.text}\n`;
    if (total + block.length > max) { truncated = true; break; }
    total += block.length;
    if (!byDoc.has(doc)) byDoc.set(doc, []);
    byDoc.get(doc).push(block);
  }
  let text = '';
  for (const [doc, blocks] of byDoc) {
    text += `<자료 id="${doc.tag}" 파일명="${doc.name}" 단위="${doc.kind === 'pptx' ? '슬라이드' : '쪽'}">\n${blocks.join('\n')}</자료>\n\n`;
  }
  const value = { text, chars: total, truncated };
  materialCache = { key, value };
  return value;
}

// 범위 안의 자료에서 원문을 찾는다(공백 무시). 비판적 읽기 원문 검증용.
export function findInScope(snippet) {
  const norm = (s) => s.replace(/\s+/g, '');
  const target = norm(snippet);
  if (!target) return null;
  for (const { doc, unit } of scopeUnits()) {
    if (norm(unit.text).includes(target)) return { doc, unit };
  }
  // 부분 일치: 12자 조각의 85% 이상이 같은 쪽에 존재하면 인정
  const pieces = [];
  for (let i = 0; i + 12 <= target.length; i += 6) pieces.push(target.slice(i, i + 12));
  if (!pieces.length) return null;
  let best = null;
  for (const { doc, unit } of scopeUnits()) {
    const t = norm(unit.text);
    const hit = pieces.filter((p) => t.includes(p)).length / pieces.length;
    if (!best || hit > best.hit) best = { doc, unit, hit };
  }
  return best && best.hit >= 0.85 ? best : null;
}

// 출처 표기 검증: {doc:'D1', page:12} → 라벨
export function resolveSource(src) {
  if (!src) return null;
  const doc = docByTag(String(src.doc || '').trim());
  const n = Number(src.page);
  if (!doc || !n) return { valid: false, label: `${src.doc || '?'} ${src.page || '?'}` };
  const exists = doc.units.some((u) => u.n === n);
  const inScope = (S().scope[doc.id] || []).includes(n);
  return { valid: exists, inScope, doc, n, label: `${doc.name} · ${unitLabel(doc, n)}` };
}

export function unitText(docTag, n) {
  const doc = docByTag(docTag);
  return doc?.units.find((u) => u.n === Number(n))?.text || '';
}

// "1-5, 8, 10-12" → [1,2,3,4,5,8,10,11,12]
export function parseRanges(str, max) {
  const out = new Set();
  for (const part of String(str).split(/[,\s]+/)) {
    if (!part) continue;
    const m = part.match(/^(\d+)(?:[-~](\d+))?$/);
    if (!m) continue;
    let a = +m[1], b = m[2] ? +m[2] : a;
    if (a > b) [a, b] = [b, a];
    for (let i = Math.max(1, a); i <= Math.min(max, b); i++) out.add(i);
  }
  return [...out].sort((x, y) => x - y);
}
export function formatRanges(nums) {
  const s = [...nums].sort((a, b) => a - b);
  const out = [];
  for (let i = 0; i < s.length; i++) {
    let j = i;
    while (j + 1 < s.length && s[j + 1] === s[j] + 1) j++;
    out.push(i === j ? `${s[i]}` : `${s[i]}-${s[j]}`);
    i = j;
  }
  return out.join(', ');
}
