// 글자 인식(OCR): 글자 정보가 없는 쪽(스캔한 PDF, 그림으로 된 슬라이드)을 이미지로 AI에 보내 글자를 옮겨 적게 한다.
import { askJSON, T, hasAIKey } from './ai.js';

const SCHEMA = T.obj({ pages: T.arr(T.obj({ n: T.int, text: T.str })) });
const PER_CALL = 3;   // 한 번에 보내는 쪽 수
const PARALLEL = 2;   // 동시에 보내는 요청 수(너무 많으면 요청 한도에 걸린다)

export const canOCR = () => hasAIKey();

const wait = (ms) => new Promise((ok) => setTimeout(ok, ms));

// items: [{ n, images: [{ data, mediaType }] }] → { texts: Map(n → 글자), failed }
export async function ocrUnits(items, { onProgress = () => {}, kindLabel = '쪽' } = {}) {
  const texts = new Map();
  const answered = new Set(); // 응답을 받은 쪽(빈 쪽이라는 답 포함)
  let done = 0;

  async function readBatch(batch) {
    // 그림마다 바로 앞에 "[12쪽]" 같은 표시를 붙여 쪽이 섞이지 않게 한다
    const images = batch.flatMap((it) => it.images.map((im, k) => ({ ...im, label: `[${it.n}${kindLabel}${it.images.length > 1 ? ` 그림 ${k + 1}` : ''}]` })));
    const { data } = await askJSON({
      material: false, effort: 'low', maxTokens: 16000, schema: SCHEMA, images,
      task: [
        `위 그림들은 학습 자료(주로 한국어 교과서·강의 자료)의 ${kindLabel}을 찍은 것이다. 각 그림 앞의 [번호]가 그 ${kindLabel}의 번호다. ${kindLabel}마다 보이는 글자를 빠짐없이 그대로 옮겨 적어라.`,
        '- 원문 그대로: 요약·해석·설명·번역하지 않고, 내용을 고치거나 덧붙이지 않는다.',
        '- 스캔이 흐리거나 기울어져 있어도 끝까지 읽는다. 잘 안 보이는 글자는 앞뒤 문맥에 맞는 낱말로 읽되, 없는 문장을 지어내지 않는다. 띄어쓰기는 바르게 한다.',
        '- 읽는 순서: 위에서 아래로. 단이 둘 이상이면 왼쪽 단을 끝까지 읽은 뒤 오른쪽 단. 제목·소제목·글머리표·번호는 줄을 바꿔 유지하고, 한 문장이 줄 끝에서 끊긴 것은 이어 쓴다.',
        '- 표는 행마다 한 줄로, 칸은 " | "로 구분한다. 그림·도표 안의 글자와 각주도 적는다. 쪽 번호·머리말만 있는 줄은 빼도 된다.',
        `- pages에 ${kindLabel}마다 {n: [번호]의 숫자, text}를 넣는다. 글자가 없는 ${kindLabel}은 text를 빈 문자열로.`,
      ].join('\n'),
    });
    for (const p of data.pages || []) {
      if (!batch.some((it) => it.n === p.n)) continue;
      answered.add(p.n);
      if (p.text?.trim()) texts.set(p.n, p.text.trim());
    }
  }

  // 1차: 몇 쪽씩 묶어서 읽는다
  const batches = [];
  for (let i = 0; i < items.length; i += PER_CALL) batches.push(items.slice(i, i + PER_CALL));
  let next = 0;
  const worker = async () => {
    while (next < batches.length) {
      const batch = batches[next++];
      try { await readBatch(batch); } catch (e) { console.warn('글자 인식 실패', e); }
      done += batch.length;
      onProgress(Math.min(1, done / items.length));
    }
  };
  await Promise.all(Array.from({ length: Math.min(PARALLEL, batches.length) }, worker));

  // 2차: 응답을 못 받은 쪽만(요청 한도·네트워크 오류, 답에서 빠진 쪽) 한 쪽씩 다시 시도
  const missing = items.filter((it) => !answered.has(it.n));
  for (let i = 0; i < missing.length; i++) {
    await wait(1500);
    try { await readBatch([missing[i]]); } catch (e) { console.warn('글자 인식 재시도 실패', e); }
  }
  const failed = items.filter((it) => !answered.has(it.n)).length;
  return { texts, failed };
}
