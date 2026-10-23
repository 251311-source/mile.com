// Google Gemini API 호출 (REST). 사용자의 Gemini API 키로 브라우저에서 직접 호출한다.
import { CancelledError } from './jobs.js';
import { settings, save } from './store.js';
import { toast } from './ui.js';

const BASE = 'https://generativelanguage.googleapis.com/v1beta';

// 요청이 거부된 선택 기능은 이번 세션 동안 끈다(구형 모델 등).
const off = { jsonSchema: false, thinking: false };

function friendly(status, msg) {
  let text = msg || 'Gemini 요청에 실패했습니다.';
  if (status === 400 && /api key/i.test(msg)) text = 'Gemini API 키가 올바르지 않습니다. [설정]에서 다시 확인해 주세요.';
  else if (status === 403) text = '이 Gemini API 키로는 요청할 수 없습니다(권한 없음 또는 API 미사용 설정).';
  else if (status === 404) text = 'Gemini 모델 이름을 찾을 수 없습니다. [설정]에서 모델을 다시 골라 주세요.';
  else if (status === 429) text = 'Gemini 요청 한도를 넘었습니다. 잠시 후 다시 시도하거나 요금제를 확인해 주세요.';
  else if (status === 503 || status === 500) text = 'Gemini 서버가 혼잡합니다. 잠시 후 다시 시도해 주세요.';
  else if (status === 400 && /token|too long|exceeds/i.test(msg)) text = '선택한 범위의 자료가 너무 깁니다. 범위를 줄이거나 [설정]의 자료 최대 길이를 낮춰 주세요.';
  const err = new Error(text);
  err.status = status;
  err.raw = msg;
  return err;
}

// 모델 이름을 찾을 수 없으면(지원이 끝난 옛 모델 등) 이 키로 쓸 수 있는 같은 종류의 최신 모델로 바꿔 다시 요청한다
const remap = new Map();
const famOf = (id) => (/flash-lite/.test(id) ? 'flash-lite' : /flash/.test(id) ? 'flash' : /pro/.test(id) ? 'pro' : '');
const verOf = (id) => parseFloat((id.match(/gemini-(\d+(?:\.\d+)?)/) || [])[1] || 0);
export function pickModel(list, wanted = '') {
  const ok = list.map((m) => m.id).filter((id) => /^gemini-/.test(id) && !/(embed|tts|image|live|audio|native|aqa|learnlm|robotics|computer|thinking)/i.test(id));
  const stable = ok.filter((id) => !/(preview|exp|latest|\d{3,}$)/i.test(id));
  const pool = (stable.length ? stable : ok).sort((a, b) => verOf(b) - verOf(a) || a.length - b.length);
  const fam = famOf(wanted) || 'flash';
  return pool.find((id) => famOf(id) === fam) || pool.find((id) => famOf(id) === 'flash') || pool[0] || null;
}
async function replacementFor(key, model) {
  if (remap.has(model)) return remap.get(model);
  let next = null;
  try { next = pickModel(await listGeminiModels(key), model); } catch {}
  remap.set(model, next);
  return next;
}

export const cleanModelId = (id) => String(id || '').trim().replace(/^models\//, '');

async function call(key, model, method, body, opts = {}) {
  model = cleanModelId(model);
  try {
    return await callOnce(key, model, method, body, opts);
  } catch (e) {
    if (e.status !== 404) throw e;
    const next = await replacementFor(key, model);
    if (!next || next === model) throw e;
    if (cleanModelId(settings().geminiModel) === model || !settings().geminiModel) {
      settings().geminiModel = next;
      save();
      document.dispatchEvent(new CustomEvent('geminimodel', { detail: next }));
    }
    toast(`'${model}' 모델은 더 이상 쓸 수 없어서 '${next}' 모델로 바꿨어요. ([설정]에 저장됨)`, 'info', 7000);
    return callOnce(key, next, method, body, opts);
  }
}

// 응답이 오지 않으면 무한히 기다리지 않는다(기본 4분: 긴 문제 생성도 넉넉히 끝나는 시간)
const TIMEOUT_MS = 240000;
export class TimeoutError extends Error {
  constructor() { super('Gemini가 제시간에 응답하지 않았습니다. 잠시 후 다시 시도하거나 [설정]에서 더 빠른 모델(Flash)을 골라 보세요.'); this.name = 'TimeoutError'; }
}
// 사용자 취소(signal)와 시간 제한을 함께 쓰는 신호
function withTimeout(signal, ms) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new TimeoutError()), ms);
  const onAbort = () => ctrl.abort(signal.reason);
  if (signal) { if (signal.aborted) ctrl.abort(signal.reason); else signal.addEventListener('abort', onAbort, { once: true }); }
  return { signal: ctrl.signal, done: () => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); }, timedOut: () => ctrl.signal.reason instanceof TimeoutError };
}

async function callOnce(key, model, method, body, { stream = false, signal, timeout = TIMEOUT_MS } = {}) {
  const t = withTimeout(signal, timeout);
  let res;
  try {
    res = await fetch(`${BASE}/models/${encodeURIComponent(model)}:${method}${stream ? '?alt=sse' : ''}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify(body),
      signal: t.signal,
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      throw friendly(res.status, j.error?.message || res.statusText);
    }
    if (!stream) {
      // 본문까지 시간 제한 안에서 받는다
      const data = await res.json();
      return { json: async () => data };
    }
    return res; // 스트리밍은 받는 동안 따로 확인한다
  } catch (e) {
    if (t.timedOut()) throw new TimeoutError();
    if (signal?.aborted) throw new CancelledError();
    if (e.status) throw e;
    throw new Error('네트워크 연결을 확인해 주세요. (' + e.message + ')');
  } finally {
    t.done();
  }
}

// 생각 예산(thinkingBudget)을 지원하지 않는 모델이면 빼고 다시 요청한다
async function callThinking(key, model, method, body, opts) {
  try {
    return await call(key, model, method, body, opts);
  } catch (e) {
    if (e.status === 400 && body.generationConfig.thinkingConfig && /thinking/i.test(e.raw || e.message)) {
      off.thinking = true;
      delete body.generationConfig.thinkingConfig;
      return call(key, model, method, body, opts);
    }
    throw e;
  }
}

function partsText(cand) {
  return (cand?.content?.parts || []).filter((p) => p.text && !p.thought).map((p) => p.text).join('');
}
function checkFinish(data) {
  if (data.promptFeedback?.blockReason) throw new Error('Gemini가 이 요청을 처리하지 않았습니다. 범위나 조건을 바꿔 다시 시도해 주세요.');
  const reason = data.candidates?.[0]?.finishReason;
  if (reason === 'MAX_TOKENS') throw new Error('응답이 너무 길어 잘렸습니다. 문항 수를 줄여 다시 시도해 주세요.');
  if (['SAFETY', 'RECITATION', 'BLOCKLIST', 'PROHIBITED_CONTENT'].includes(reason)) throw new Error('Gemini가 이 요청에 답하지 않았습니다. 조건을 바꿔 다시 시도해 주세요.');
}
function grounding(data) {
  const chunks = data.candidates?.[0]?.groundingMetadata?.groundingChunks || [];
  // Gemini의 검색 결과 주소는 중계 주소이므로 title(사이트 도메인)을 함께 돌려준다.
  return chunks.filter((c) => c.web).map((c) => ({ url: c.web.uri, title: c.web.title || '', domain: (c.web.title || '').replace(/^www\./, ''), redirect: true }));
}

// JSON 응답. web이면 Google 검색 근거(grounding)를 켠다(이때는 JSON 형식 강제를 쓰지 않는다).
export async function geminiJSON({ key, model, systemText, prompt, schema, web = false, maxTokens = 32768, thinking = -1, images = [], signal }) {
  const body = {
    systemInstruction: { parts: [{ text: systemText }] },
    contents: [{ role: 'user', parts: [...images.flatMap((im) => [im.label && { text: im.label }, { inline_data: { mime_type: im.mediaType, data: im.data } }].filter(Boolean)), { text: prompt }] }],
    generationConfig: { maxOutputTokens: maxTokens },
  };
  if (thinking >= 0 && !off.thinking) body.generationConfig.thinkingConfig = { thinkingBudget: thinking };
  if (web) body.tools = [{ google_search: {} }];
  else {
    body.generationConfig.responseMimeType = 'application/json';
    if (!off.jsonSchema) body.generationConfig.responseJsonSchema = schema;
  }
  let res;
  try {
    res = await callThinking(key, model, 'generateContent', body, { signal });
  } catch (e) {
    if (e.status === 400 && !web && !off.jsonSchema) {
      off.jsonSchema = true; // 스키마 강제를 지원하지 않는 모델: 프롬프트의 스키마 설명만으로 진행
      delete body.generationConfig.responseJsonSchema;
      res = await callThinking(key, model, 'generateContent', body, { signal });
    } else throw e;
  }
  const data = await res.json();
  checkFinish(data);
  return { text: partsText(data.candidates?.[0]), searchResults: grounding(data) };
}

// 대화(스트리밍). messages: [{role:'user'|'assistant', content}]
export async function geminiChat({ key, model, systemText, messages, onText, thinking = -1 }) {
  const body = {
    systemInstruction: { parts: [{ text: systemText }] },
    contents: messages.map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] })),
    generationConfig: { maxOutputTokens: 16384 },
  };
  if (thinking >= 0 && !off.thinking) body.generationConfig.thinkingConfig = { thinkingBudget: thinking };
  const res = await callThinking(key, model, 'streamGenerateContent', body, { stream: true });
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '', full = '';
  for (;;) {
    // 90초 동안 아무것도 오지 않으면 멈춘 것으로 본다
    let idle;
    const step = await Promise.race([reader.read(), new Promise((_, no) => { idle = setTimeout(() => no(new TimeoutError()), 90000); })]).finally(() => clearTimeout(idle));
    const { value, done } = step;
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line.startsWith('data:')) continue;
      let data;
      try { data = JSON.parse(line.slice(5)); } catch { continue; }
      checkFinish(data);
      const t = partsText(data.candidates?.[0]);
      if (t) { full += t; onText && onText(t); }
    }
  }
  return full;
}

// 연결 확인: 짧은 요청 하나(생각 최소, 짧은 답). 200 응답이면 연결된 것으로 본다.
export async function geminiPing({ key, model }) {
  const body = {
    contents: [{ role: 'user', parts: [{ text: '연결 확인입니다. "연결됨"이라고만 답하세요.' }] }],
    generationConfig: { maxOutputTokens: 512, thinkingConfig: { thinkingBudget: 128 } },
  };
  if (off.thinking) delete body.generationConfig.thinkingConfig;
  const res = await callThinking(key, model, 'generateContent', body, { timeout: 30000 });
  const data = await res.json();
  if (data.promptFeedback?.blockReason) throw new Error('Gemini가 요청을 거부했습니다.');
  return partsText(data.candidates?.[0]) || '연결됨';
}

// 이 키로 쓸 수 있는 생성 모델 목록
export async function listGeminiModels(key) {
  const out = [];
  let token = '';
  for (let i = 0; i < 5; i++) {
    let res;
    try {
      res = await fetch(`${BASE}/models?pageSize=200${token ? '&pageToken=' + token : ''}`, { headers: { 'x-goog-api-key': key }, signal: AbortSignal.timeout(20000) });
    } catch (e) {
      throw new Error(e?.name === 'TimeoutError' ? 'Gemini 모델 목록을 받지 못했습니다(시간 초과). 인터넷 연결을 확인해 주세요.' : '네트워크 연결을 확인해 주세요. (' + e.message + ')');
    }
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      throw friendly(res.status, j.error?.message || res.statusText);
    }
    const j = await res.json();
    for (const m of j.models || []) {
      if ((m.supportedGenerationMethods || []).includes('generateContent') && /gemini/i.test(m.name)) {
        out.push({ id: m.name.replace(/^models\//, ''), label: m.displayName || m.name });
      }
    }
    if (!j.nextPageToken) break;
    token = j.nextPageToken;
  }
  return out;
}
