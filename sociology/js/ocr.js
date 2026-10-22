// 글자 인식(OCR): 글자 정보가 없는 쪽(스캔한 PDF, 그림으로 된 슬라이드)을 이미지로 AI에 보내 글자를 옮겨 적게 한다.
import { askJSON, T, hasAIKey } from './ai.js';

const SCHEMA = T.obj({ pages: T.arr(T.obj({ n: T.int, text: T.str })) });
const PER_CALL = 3;   // 한 번에 보내는 쪽 수
const PARALLEL = 3;   // 동시에 보내는 요청 수

export const canOCR = () => hasAIKey();

// items: [{ n, images: [{ data, mediaType }] }] → Map(n → 글자)
export async function ocrUnits(items, { onProgress = () => {}, kindLabel = '쪽' } = {}) {
  const out = new Map();
  const batches = [];
  for (let i = 0; i < items.length; i += PER_CALL) batches.push(items.slice(i, i + PER_CALL));
  let done = 0, failed = 0, next = 0;
  const worker = async () => {
    while (next < batches.length) {
      const batch = batches[next++];
      const images = batch.flatMap((it) => it.images);
      const order = batch.map((it) => `${it.n}${kindLabel}: 이미지 ${it.images.length}장`).join(', ');
      try {
        const { data } = await askJSON({
          material: false, effort: 'low', maxTokens: 16000, schema: SCHEMA, images,
          task: [
            `다음 이미지들은 학습 자료의 ${kindLabel}을 순서대로 찍은 것이다 (${order}). 각 ${kindLabel}에 보이는 글자를 빠짐없이 그대로 옮겨 적어라.`,
            '- 원문 그대로 적는다: 요약·해석·설명·번역을 하지 않고, 고치거나 덧붙이지 않는다. 띄어쓰기는 이미지에 보이는 대로 바르게 쓴다.',
            '- 읽는 순서(위→아래, 왼쪽→오른쪽 단)대로 적고, 제목·글머리표·번호는 줄을 바꿔 유지한다. 표는 행마다 한 줄로, 칸은 " | "로 구분한다. 그림·도표 안의 글자도 적는다.',
            '- 쪽 머리말·꼬리말의 쪽 번호만 있는 줄은 빼도 된다. 글자가 없는 쪽은 빈 문자열.',
            `- pages에 ${kindLabel}마다 {n: 위에 적은 번호, text}를 넣는다.`,
          ].join('\n'),
        });
        for (const p of data.pages || []) if (batch.some((it) => it.n === p.n) && p.text?.trim()) out.set(p.n, p.text.trim());
      } catch (e) {
        console.warn('글자 인식 실패', e);
        failed += batch.length;
      }
      done += batch.length;
      onProgress(done / items.length);
    }
  };
  await Promise.all(Array.from({ length: Math.min(PARALLEL, batches.length) }, worker));
  return { texts: out, failed };
}
