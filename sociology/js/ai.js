// Claude API 호출. 브라우저에서 사용자의 API 키로 직접 호출한다.
import { settings } from './store.js';
import { buildMaterial, hasScope } from './docs.js';

const SDK = 'https://cdn.jsdelivr.net/npm/@anthropic-ai/sdk@0.131.0/+esm';

export class NeedKeyError extends Error {
  constructor(msg) { super(msg); this.name = 'NeedKeyError'; }
}

let clientP = null, clientKey = null;
async function client() {
  const key = (settings().apiKey || '').trim();
  if (!key) throw new NeedKeyError('먼저 [설정]에서 Anthropic API 키를 입력해 주세요.');
  if (!clientP || clientKey !== key) {
    clientKey = key;
    clientP = import(SDK).then((m) => {
      const Anthropic = m.default || m.Anthropic;
      return new Anthropic({ apiKey: key, dangerouslyAllowBrowser: true, maxRetries: 2 });
    });
  }
  return clientP;
}

// API가 거부한 선택 기능은 이번 세션 동안 끈다.
const off = { fallbacks: false, format: false };

const RULES = `너는 대학 사회학 학습 프로그램의 출제·채점·설명 엔진이다.

[근거 원칙]
- 모든 문제, 정답, 해설, 채점은 <자료> 안의 내용만 근거로 한다. 자료에 없는 학자·이론·개념·사실·인용을 만들어 내지 않는다.
- 자료 본문의 [[D1:12]] 표지는 "자료 D1의 12쪽(PPT면 슬라이드 12)이 여기서 시작된다"는 뜻이다. 근거가 된 위치는 sources에 {"doc":"D1","page":12}처럼 실제 위치로만 적는다. 위치를 추측하지 않는다.
- 요청이 자료 밖 정보(웹 검색, 학계의 일반적 비판 등)를 명시적으로 허용한 경우에만 자료 밖 내용을 쓰고, 그 부분은 자료 밖 정보임을 분명히 구분한다.
- 자료의 내용이 부족하면 지어내지 말고 그 사실을 밝힌다.

[언어]
- 모든 출력은 한국어로 쓴다. 학자의 원어 인용문은 원어 그대로 둘 수 있다.

[형식]
- JSON을 요구받으면 설명이나 코드 블록 없이 JSON 객체 하나만 출력한다.`;

function system(useMaterial, materialText) {
  const blocks = [{ type: 'text', text: RULES }];
  if (materialText) {
    blocks.push({ type: 'text', text: `다음은 분석할 자료다.\n\n${materialText}` });
  } else if (useMaterial) {
    const m = buildMaterial();
    blocks.push({
      type: 'text',
      text: `다음은 사용자가 업로드하고 학습 범위로 선택한 자료다.\n\n${m.text}`,
      cache_control: { type: 'ephemeral' },
    });
  }
  return blocks;
}

function friendly(e) {
  const status = e?.status;
  let msg = e?.message || String(e);
  if (status === 401) msg = 'API 키가 올바르지 않습니다. [설정]에서 다시 확인해 주세요.';
  else if (status === 403) msg = '이 API 키로는 요청할 수 없습니다(권한 없음).';
  else if (status === 429) msg = '요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.';
  else if (status === 529 || status === 503) msg = 'AI 서버가 혼잡합니다. 잠시 후 다시 시도해 주세요.';
  else if (status === 400 && /too long|context|prompt is too long/i.test(msg)) msg = '선택한 범위의 자료가 너무 깁니다. 범위를 줄이거나 [설정]의 자료 최대 길이를 낮춰 주세요.';
  else if (!status && /fetch|network|load/i.test(msg)) msg = '네트워크 연결을 확인해 주세요. (' + msg + ')';
  const err = new Error(msg);
  err.cause = e;
  return err;
}

async function run(params, { onText } = {}) {
  const c = await client();
  for (let attempt = 0; attempt < 4; attempt++) {
    const req = { ...params };
    if (!off.fallbacks) {
      req.betas = ['server-side-fallback-2026-07-01'];
      req.fallbacks = 'default';
    }
    if (off.format && req.output_config?.format) {
      req.output_config = { ...req.output_config };
      delete req.output_config.format;
    }
    try {
      const stream = c.beta.messages.stream(req);
      if (onText) stream.on('text', onText);
      return await stream.finalMessage();
    } catch (e) {
      const msg = String(e?.message || '');
      if (e?.status === 400 && !off.fallbacks && /fallback|anthropic-beta|beta/i.test(msg)) { off.fallbacks = true; continue; }
      if (e?.status === 400 && !off.format && req.output_config?.format && /output_config|format|schema/i.test(msg)) { off.format = true; continue; }
      throw friendly(e);
    }
  }
  throw new Error('AI 요청에 실패했습니다.');
}

function textOf(message) {
  return message.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
}

function searchResultsOf(messages) {
  const out = [];
  for (const m of messages) {
    for (const b of m.content || []) {
      if (b.type === 'web_search_tool_result' && Array.isArray(b.content)) {
        for (const r of b.content) if (r.url) out.push({ url: r.url, title: r.title || '', age: r.page_age || '' });
      }
    }
  }
  return out;
}

export function parseJSON(text) {
  const t = String(text).trim();
  try { return JSON.parse(t); } catch {}
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) { try { return JSON.parse(fence[1]); } catch {} }
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a >= 0 && b > a) { try { return JSON.parse(t.slice(a, b + 1)); } catch {} }
  return null;
}

// JSON 결과를 받는 호출.
// web: true면 웹 검색 도구를 허용한다(이때는 출력 형식 강제를 쓰지 않는다).
export async function askJSON({ task, schema, material = true, web = false, maxTokens = 32000, effort, materialText = '' }) {
  if (material && !materialText && !hasScope()) throw new Error('먼저 [자료·범위]에서 자료를 올리고 학습 범위를 선택해 주세요.');
  const s = settings();
  const content = `${task}\n\n출력은 다음 JSON 스키마를 따르는 JSON 객체 하나다:\n${JSON.stringify(schema)}`;
  const params = {
    model: s.model,
    max_tokens: maxTokens,
    system: system(material, materialText),
    messages: [{ role: 'user', content }],
    output_config: { effort: effort || s.effort },
  };
  if (web) params.tools = [{ type: 'web_search_20260209', name: 'web_search', max_uses: 6 }];
  else params.output_config.format = { type: 'json_schema', schema };

  const turns = [];
  let msg = await run(params);
  turns.push(msg);
  // 웹 검색이 길어지면 pause_turn으로 멈출 수 있으므로 이어서 진행한다.
  for (let i = 0; i < 4 && msg.stop_reason === 'pause_turn'; i++) {
    params.messages = [...params.messages, { role: 'assistant', content: msg.content }];
    msg = await run(params);
    turns.push(msg);
  }
  if (msg.stop_reason === 'refusal') throw new Error('AI가 이 요청을 처리하지 않았습니다. 범위나 조건을 바꿔 다시 시도해 주세요.');
  if (msg.stop_reason === 'max_tokens') throw new Error('응답이 너무 길어 잘렸습니다. 문항 수를 줄여 다시 시도해 주세요.');

  let data = parseJSON(textOf(msg));
  if (!data) data = await repairJSON(textOf(msg), schema);
  if (!data) throw new Error('AI 응답을 해석하지 못했습니다. 다시 시도해 주세요.');
  return { data, searchResults: searchResultsOf(turns) };
}

async function repairJSON(text, schema) {
  const s = settings();
  const msg = await run({
    model: s.model,
    max_tokens: 32000,
    system: [{ type: 'text', text: RULES }],
    messages: [{ role: 'user', content: `아래 텍스트에 담긴 내용을 스키마에 맞는 유효한 JSON 객체 하나로만 다시 출력하라. 내용은 바꾸지 마라.\n\n스키마:\n${JSON.stringify(schema)}\n\n텍스트:\n${text.slice(0, 60000)}` }],
    output_config: { effort: 'low', format: { type: 'json_schema', schema } },
  });
  return parseJSON(textOf(msg));
}

// 자유 대화(AI 질문 패널). onText로 스트리밍 텍스트를 받는다.
export async function chat({ messages, onText }) {
  const s = settings();
  const msg = await run({
    model: s.model,
    max_tokens: 16000,
    system: system(hasScope()),
    messages,
    output_config: { effort: s.effort },
  }, { onText });
  if (msg.stop_reason === 'refusal') throw new Error('AI가 이 질문에 답하지 않았습니다.');
  return textOf(msg);
}

export async function testKey() {
  const s = settings();
  const msg = await run({
    model: s.model,
    max_tokens: 2000,
    messages: [{ role: 'user', content: '연결 확인입니다. "연결됨"이라고만 답하세요.' }],
    output_config: { effort: 'low' },
  });
  return textOf(msg);
}

// JSON 스키마 헬퍼 (구조화 출력용: 모든 속성 필수, 추가 속성 금지)
export const T = {
  str: { type: 'string' },
  int: { type: 'integer' },
  num: { type: 'number' },
  bool: { type: 'boolean' },
  arr: (items) => ({ type: 'array', items }),
  obj: (props) => ({ type: 'object', properties: props, required: Object.keys(props), additionalProperties: false }),
  oneOf: (...v) => ({ type: 'string', enum: v }),
};
export const SOURCES = T.arr(T.obj({ doc: T.str, page: T.int }));
