// 업로드한 자료의 분석 결과(개념·학자·핵심 문장과 쪽 번호)를 만든다. 원본 파일 대신 이것을 계정에 저장한다.
import { askJSON, T } from './ai.js';

const SCHEMA = T.obj({
  concepts: T.arr(T.obj({ name: T.str, pages: T.arr(T.int) })),
  sociologists: T.arr(T.obj({ name: T.str, pages: T.arr(T.int) })),
  key_sentences: T.arr(T.obj({ page: T.int, text: T.str })),
});
const PAGES_PER_CALL = 30;

// 구조 정보만 담은 분석 결과 (AI 분석 전, 또는 API 키가 없을 때)
export function structureOf(doc) {
  return {
    id: doc.id, tag: doc.tag, name: doc.name, kind: doc.kind, addedAt: doc.addedAt,
    chapters: doc.chapters || [],
    pages: doc.units.map((u) => ({ n: u.n, title: u.title || '', chars: u.text.length })),
    concepts: [], sociologists: [], keySentences: [],
    analyzed: false,
  };
}

export async function analyzeDoc(doc) {
  const m = structureOf(doc);
  const units = doc.units.filter((u) => u.text.trim());
  const parts = [];
  for (let i = 0; i < units.length; i += PAGES_PER_CALL) parts.push(units.slice(i, i + PAGES_PER_CALL));
  const results = await Promise.all(parts.map((part) => askJSON({
    material: true,
    materialText: part.map((u) => `[[${doc.tag}:${u.n}]]\n${u.text}`).join('\n\n'),
    effort: 'low',
    schema: SCHEMA,
    task: [
      `자료 "${doc.name}"의 이 부분을 분석하라. 다른 기기에서 원본 없이도 문제를 낼 수 있도록 내용을 보존하는 것이 목적이다.`,
      '- concepts: 등장하는 사회학 개념·이론 이름과 나오는 쪽 번호들. sociologists: 등장하는 학자 이름과 쪽 번호들. 자료에 쓰인 표기 그대로.',
      '- key_sentences: 쪽마다 정의·주장·비교·예시를 담은 핵심 문장 2~6개를 자료 원문 그대로 옮긴다(page는 [[D:쪽]] 표지의 번호). 문장을 지어내거나 바꾸지 않는다.',
    ].join('\n'),
  })));
  const merge = (list) => {
    const map = new Map();
    for (const x of list) {
      if (!x?.name) continue;
      const have = map.get(x.name) || new Set();
      (x.pages || []).forEach((p) => have.add(p));
      map.set(x.name, have);
    }
    return [...map].map(([name, pages]) => ({ name, pages: [...pages].sort((a, b) => a - b) }));
  };
  const valid = new Set(doc.units.map((u) => u.n));
  m.concepts = merge(results.flatMap((r) => r.data.concepts || []));
  m.sociologists = merge(results.flatMap((r) => r.data.sociologists || []));
  m.keySentences = results.flatMap((r) => r.data.key_sentences || []).filter((k) => k.text && valid.has(k.page)).map((k) => ({ page: k.page, text: String(k.text).slice(0, 400) }));
  m.analyzed = true;
  m.analyzedAt = Date.now();
  return m;
}

// 원본이 없는 기기에서 쓰는 자료 객체 (분석 결과의 핵심 문장으로 쪽 내용을 만든다)
export function docFromAnalysis(m) {
  const byPage = new Map();
  for (const k of m.keySentences || []) { if (!byPage.has(k.page)) byPage.set(k.page, []); byPage.get(k.page).push(k.text); }
  return {
    id: m.id, tag: m.tag, name: m.name, kind: m.kind, addedAt: m.addedAt || 0, chapters: m.chapters || [],
    units: (m.pages || []).map((p) => ({ n: p.n, title: p.title, text: (byPage.get(p.n) || []).join('\n') })),
    analysisOnly: true, analysis: m,
  };
}
