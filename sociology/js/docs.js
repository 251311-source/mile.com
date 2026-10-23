// PDF/PPTX 파싱, 자료 목록, 학습 범위 관리.
import { docsDB, S, save, uid, settings } from './store.js';
import { loadMaterials, saveMaterial, deleteMaterial, currentUid, currentSubject, saveDocText, loadAllDocText, deleteDocText } from './cloud.js';

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
  const sid = currentSubject();
  const local = (await docsDB.all()).filter((d) => d.owner === owner && (d.subject || 'soc') === sid); // 이 과목의 자료만
  const materials = await loadMaterials();
  const { docFromAnalysis } = await import('./analysis.js');
  // 이 기기에 없는 자료는 계정에 저장된 본문을 받아 이 기기에도 보관한다
  const missing = materials.filter((m) => !local.some((d) => d.id === m.id));
  const texts = missing.some((m) => m.textSaved) ? await loadAllDocText() : new Map();
  const out = [];
  for (const m of materials) {
    let full = local.find((d) => d.id === m.id);
    if (!full && texts.get(m.id)?.length) {
      full = { id: m.id, tag: m.tag, name: m.name, kind: m.kind, addedAt: m.addedAt || 0, chapters: m.chapters || [], units: texts.get(m.id).sort((a, b) => a.n - b.n), owner, subject: sid, textSaved: true };
      docsDB.put(full).catch(() => {});
    }
    if (full) {
      const doc = { ...full, tag: m.tag, analysis: m, textSaved: !!m.textSaved };
      out.push(doc);
      if (!m.textSaved) ensureText(doc); // 이전에 올린 자료는 본문을 계정에 올려 둔다
    } else out.push(docFromAnalysis(m));
  }
  // 분석 결과를 아직 못 올린 원본(오프라인 등)도 보여 주고 다시 올린다
  for (const d of local) if (!materials.some((m) => m.id === d.id)) { out.push(d); ensureText(d).then(() => syncAnalysis(d)); }
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
    const doc = { ...d, owner: currentUid(), subject: currentSubject(), tag: nextTag() };
    await docsDB.put(doc);
    docs.push(doc);
    await syncAnalysis(doc);
  }
}

// 자료 본문(쪽 텍스트)을 계정에 올린다. 다른 기기에서도 원본 없이 모든 기능을 쓸 수 있게 된다.
export async function ensureText(doc) {
  if (doc.textSaved || doc.analysisOnly) return;
  try {
    await saveDocText(doc);
    doc.textSaved = true;
    if (doc.analysis) { doc.analysis.textSaved = true; await saveMaterial(doc.analysis); }
    document.dispatchEvent(new CustomEvent('docanalysis', { detail: doc }));
  } catch (e) {
    console.warn('자료 본문 저장 실패', e);
  }
}

// 분석 결과를 계정에 올린다. API 키가 없거나 실패하면 구조만 올리고 나중에 다시 분석할 수 있게 둔다.
export async function syncAnalysis(doc, { analyze = true } = {}) {
  const { structureOf, analyzeDoc } = await import('./analysis.js');
  let m = doc.analysis?.analyzed ? doc.analysis : structureOf(doc);
  if (analyze && !m.analyzed && (settings().apiKey || settings().geminiKey || settings().openrouterKey)) {
    if (!doc.analysis) { m.tag = doc.tag; m.textSaved = !!doc.textSaved; saveMaterial(m).catch(() => {}); } // 구조부터 먼저 올려 둔다
    doc.analyzing = true;
    document.dispatchEvent(new CustomEvent('docanalysis', { detail: doc }));
    try { m = await analyzeDoc(doc); } catch (e) { console.warn('자료 분석 실패', e); m.analysisError = e.message; }
    doc.analyzing = false;
  }
  m.tag = doc.tag;
  m.textSaved = !!doc.textSaved;
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
    const doc = { ...parsed, id: same.id, tag: same.tag, name: file.name, addedAt: same.addedAt || Date.now(), owner: currentUid(), subject: currentSubject(), analysis: same.analysis, textSaved: false };
    await docsDB.put(doc);
    docs[docs.indexOf(same)] = doc;
    // 이전에 글자를 못 읽어 범위가 비어 있었다면(스캔본 등) 이번에 읽은 쪽을 선택한다
    const sel = S().scope[doc.id] || [];
    if (!sel.length) S().scope[doc.id] = doc.units.filter((u) => u.text.trim()).map((u) => u.n);
    // 글자가 없어 빠졌던 쪽을 이번에 읽었으면 범위에 넣는다
    else S().scope[doc.id] = [...new Set([...sel, ...doc.units.filter((u) => u.ocr && u.text.trim()).map((u) => u.n)])].sort((a, b) => a - b);
    // 글자를 새로 읽었으면 분석을 다시 한다
    const reanalyze = !doc.analysis?.analyzed || doc.units.some((u) => u.ocr);
    if (reanalyze && doc.analysis) doc.analysis = { ...doc.analysis, analyzed: false };
    ensureText(doc).then(() => { if (reanalyze) syncAnalysis(doc); });
    save();
    doc.linked = true;
    return doc;
  }
  const doc = { id: uid(), tag: nextTag(), name: file.name, addedAt: Date.now(), owner: currentUid(), subject: currentSubject(), ...parsed };
  await docsDB.put(doc);
  docs.push(doc);
  // 새 자료는 기본적으로 전체 범위 선택
  S().scope[doc.id] = doc.units.filter((u) => u.text.trim()).map((u) => u.n);
  save();
  await ensureText(doc); // 본문을 계정에 저장
  syncAnalysis(doc); // 개념 분석은 뒤에서 진행 (끝나면 docanalysis 이벤트)
  return doc;
}

export async function removeDoc(id) {
  await docsDB.remove(id);
  await deleteMaterial(id);
  await deleteDocText(id);
  docs = docs.filter((d) => d.id !== id);
  delete S().scope[id];
  save();
}

// ---------- PDF ----------
let pdfjsP = null;
async function pdfjs() {
  // pdf.js가 쪽을 그릴 때 쓰는 최신 기능을 아직 지원하지 않는 브라우저용(Safari 등)
  for (const C of [Map, WeakMap]) {
    if (!C.prototype.getOrInsertComputed) C.prototype.getOrInsertComputed = function (k, f) { if (!this.has(k)) this.set(k, f(k)); return this.get(k); };
    if (!C.prototype.getOrInsert) C.prototype.getOrInsert = function (k, v) { if (!this.has(k)) this.set(k, v); return this.get(k); };
  }
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
    let lastY = null, lastEnd = null;
    for (const it of tc.items) {
      if (!('str' in it)) continue;
      const y = it.transform ? it.transform[5] : null;
      const x = it.transform ? it.transform[4] : null;
      if (lastY !== null && y !== null && Math.abs(y - lastY) > 2 && !text.endsWith('\n')) text += '\n';
      // 같은 줄에서 글자 사이가 떨어져 있으면 띄어쓰기를 넣는다(슬라이드로 만든 PDF는 단어마다 따로 놓여 공백이 빠지는 경우가 많다)
      else if (lastEnd !== null && x !== null && it.str && !/\s$/.test(text) && !/^\s/.test(it.str)) {
        const gap = x - lastEnd;
        const size = Math.abs(it.transform[3]) || it.height || 10;
        if (gap > size * 0.15) text += ' ';
      }
      text += it.str;
      if (it.hasEOL) text += '\n';
      lastY = y;
      lastEnd = x !== null && typeof it.width === 'number' ? x + it.width : null;
    }
    text = text.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
    const firstLine = text.split('\n').find((l) => l.trim().length > 1) || '';
    units.push({ n: i, text, title: firstLine.slice(0, 60) });
    onProgress((i / pdf.numPages) * 0.3, '글자 읽는 중');
  }
  // 글자 정보가 (거의) 없는 쪽은 스캔 이미지일 수 있다 → 쪽을 그림으로 그려 AI 글자 인식
  const ocr = await ocrMissing(units, async (u) => [await renderPdfPage(await pdf.getPage(u.n))], onProgress, '쪽');
  const chapters = await pdfChapters(pdf, units.length);
  await task.destroy();
  return { kind: 'pdf', units, chapters, ocr };
}

// 글자가 (거의) 없거나, 스캔본에 딸린 숨은 글자층이 깨져 있으면(엉뚱한 기호·외국 문자) AI로 다시 읽는다
const OK_CHARS = /[가-힣ㄱ-ㅎㅏ-ㅣA-Za-z0-9.,·:;!?()'"“”‘’\-–—~%/\[\]<>〈〉《》「」『』…①-⑳•▪○●■□◆◇→←↔=+*#&@]/g;
function needsOCR(u) {
  const s = u.text.replace(/\s/g, '');
  if (s.length < 30) return true;
  return (s.match(OK_CHARS) || []).length / s.length < 0.8;
}

// 글자가 없는 단위를 AI로 읽는다. getImages(unit) → [{data, mediaType}]
async function ocrMissing(units, getImages, onProgress, kindLabel) {
  const targets = units.filter(needsOCR);
  if (!targets.length) { onProgress(1); return null; }
  const { canOCR, ocrUnits } = await import('./ocr.js');
  if (!canOCR()) { onProgress(1); return { needed: targets.length, done: 0, failed: 0, noKey: true }; }
  const items = [];
  for (let k = 0; k < targets.length; k++) {
    const images = (await getImages(targets[k]).catch((e) => { console.warn('쪽 이미지를 만들지 못했습니다', e); return []; })).filter(Boolean);
    if (images.length) items.push({ n: targets[k].n, images });
    onProgress(0.3 + 0.1 * ((k + 1) / targets.length), '쪽 이미지 준비 중');
  }
  if (!items.length) { onProgress(1); return { needed: targets.length, done: 0, failed: 0 }; }
  const { texts, failed } = await ocrUnits(items, { kindLabel, onProgress: (p) => onProgress(0.4 + 0.6 * p, `AI 글자 인식 중 (${Math.round(p * items.length)}/${items.length}${kindLabel})`) });
  for (const u of units) {
    const t = texts.get(u.n);
    if (!t) continue;
    const old = u.text.replace(/\s/g, '');
    // 원래 있던 몇 글자(쪽 번호 등)는 뒤에 두고, 깨진 글자층은 버린다
    u.text = old.length >= 30 || !old ? t : `${t}\n${u.text}`;
    u.ocr = true;
    if (!u.title || u.title.length < 2) u.title = (t.split('\n').find((l) => l.trim().length > 1) || '').slice(0, 60);
  }
  return { needed: targets.length, done: texts.size, failed };
}

// PDF 한 쪽을 글자 인식용 이미지로: 크게 그린 뒤 다듬는다(prepImage)
async function renderPdfPage(page) {
  const base = page.getViewport({ scale: 1 });
  const scale = Math.min(4, 2600 / Math.max(base.width, base.height));
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, viewport, canvas }).promise;
  const out = prepImage(canvas);
  canvas.width = canvas.height = 0;
  return out;
}

// 슬라이드 속 그림(파일 바이트) → 글자 인식용 이미지
async function prepImageBytes(bytes, mime) {
  const bmp = await createImageBitmap(new Blob([bytes], { type: mime }));
  const canvas = document.createElement('canvas');
  canvas.width = bmp.width; canvas.height = bmp.height;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bmp, 0, 0);
  bmp.close?.();
  if (canvas.width < 120 || canvas.height < 40) return null; // 아이콘 같은 작은 그림은 건너뜀
  const out = prepImage(canvas);
  canvas.width = canvas.height = 0;
  return out;
}

// 같은 비용으로 더 잘 읽히게: 흑백 + 대비 보정 + 여백 잘라내기 + AI가 다시 줄이지 않는 크기(긴 변 1568px, 약 115만 화소 이하)
// (AI는 그림 크기만큼 사용량을 계산하므로, 여백을 자르면 사용량은 줄고 글자는 더 크게 보인다)
function prepImage(src) {
  const W = src.width, H = src.height;
  const img = src.getContext('2d').getImageData(0, 0, W, H);
  const d = img.data;
  const gray = new Uint8ClampedArray(W * H);
  const hist = new Uint32Array(256);
  for (let i = 0, j = 0; j < gray.length; i += 4, j++) {
    const g = (d[i] * 299 + d[i + 1] * 587 + d[i + 2] * 114) / 1000;
    gray[j] = g;
    hist[gray[j]]++;
  }
  // 대비: 어두운 쪽 1%, 밝은 쪽 1%를 기준으로 늘린다(바랜 스캔본을 진하게)
  const pick = (frac) => { let acc = 0; for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= gray.length * frac) return v; } return 255; };
  const lo = pick(0.01), hi = Math.max(pick(0.99), lo + 40);
  // 글자가 있는 영역(배경보다 확실히 어두운 점이 있는 행·열)만 남긴다
  const ink = lo + (hi - lo) * 0.6;
  const rows = new Uint32Array(H), cols = new Uint32Array(W);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (gray[y * W + x] < ink) { rows[y]++; cols[x]++; }
  const span = (arr, len, other) => {
    const min = Math.max(2, other * 0.002); // 먼지·스캔 얼룩 무시
    let a = 0, b = len - 1;
    while (a < len && arr[a] < min) a++;
    while (b > a && arr[b] < min) b--;
    return a >= b ? [0, len - 1] : [a, b];
  };
  let [y0, y1] = span(rows, H, W), [x0, x1] = span(cols, W, H);
  const pad = Math.round(Math.max(W, H) * 0.015);
  x0 = Math.max(0, x0 - pad); y0 = Math.max(0, y0 - pad); x1 = Math.min(W - 1, x1 + pad); y1 = Math.min(H - 1, y1 + pad);
  const cw = x1 - x0 + 1, ch = y1 - y0 + 1;
  // 대비 보정한 흑백 그림
  const k = 255 / (hi - lo);
  for (let i = 0, j = 0; j < gray.length; i += 4, j++) {
    const v = (gray[j] - lo) * k;
    d[i] = d[i + 1] = d[i + 2] = v;
  }
  const work = document.createElement('canvas');
  work.width = W; work.height = H;
  work.getContext('2d').putImageData(img, 0, 0);
  const s = Math.min(1, 1568 / Math.max(cw, ch), Math.sqrt(1150000 / (cw * ch)));
  const out = document.createElement('canvas');
  out.width = Math.max(1, Math.floor(cw * s)); out.height = Math.max(1, Math.floor(ch * s));
  const octx = out.getContext('2d');
  octx.imageSmoothingEnabled = true;
  octx.imageSmoothingQuality = 'high';
  octx.drawImage(work, x0, y0, cw, ch, 0, 0, out.width, out.height);
  const data = out.toDataURL('image/jpeg', 0.92).split(',')[1];
  work.width = work.height = out.width = out.height = 0;
  return { data, mediaType: 'image/jpeg' };
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
    const imgs = x ? [...x.getElementsByTagNameNS('*', 'blip')].map((b) => sr[b.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'embed') || b.getAttribute('r:embed')]?.target).filter(Boolean) : [];
    units.push({ n: i + 1, text: lines.join('\n').trim(), title: (title || lines[0] || '').slice(0, 60), _imgs: imgs });
    onProgress(((i + 1) / slidePaths.length) * 0.3, '글자 읽는 중');
  }
  // 글자가 그림으로만 들어 있는 슬라이드 → 슬라이드 속 그림을 AI 글자 인식
  const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };
  const ocr = await ocrMissing(units, async (u) => {
    const out = [];
    for (const path of u._imgs.slice(0, 4)) {
      const ext = path.split('.').pop().toLowerCase();
      const f = zip.file(path);
      if (!MIME[ext] || !f) continue;
      const im = await prepImageBytes(await f.async('uint8array'), MIME[ext]).catch(() => null);
      if (im) out.push(im);
    }
    return out;
  }, onProgress, '슬라이드');
  units.forEach((u) => { delete u._imgs; });

  // PowerPoint 구역(section)을 단원으로 사용
  const chapters = [];
  if (pres) {
    const sections = [...pres.getElementsByTagNameNS('*', 'section')];
    for (const sec of sections) {
      const nums = [...sec.getElementsByTagNameNS('*', 'sldId')].map((e) => idToNum[e.getAttribute('id')]).filter(Boolean);
      if (nums.length) chapters.push({ title: sec.getAttribute('name') || '구역', start: Math.min(...nums), end: Math.max(...nums) });
    }
  }
  return { kind: 'pptx', units, chapters, ocr };
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
