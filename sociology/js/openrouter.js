// OpenRouter API 호출 (OpenAI 호환 REST). 사용자의 OpenRouter 키로 브라우저에서 직접 호출한다.
// 한 키로 여러 회사의 모델(Claude, Gemini, GPT 등)을 쓸 수 있다.
import { CancelledError } from './jobs.js';
import { settings, save } from './store.js';
import { toast } from './ui.js';

const BASE = 'https://openrouter.ai/api/v1';
const TIMEOUT_MS = 240000;

// 모델이 거부한 선택 기능은 이번 세션 동안 끈다
const off = { schema: false, jsonObject: false, reasoning: false };

export class TimeoutError extends Error {
  constructor() { super('OpenRouter가 제시간에 응답하지 않았습니다. 잠시 후 다시 시도하거나 [설정]에서 더 빠른 모델을 골라 보세요.'); this.name = 'TimeoutError'; }
}

function friendly(status, msg) {
  let text = msg || 'OpenRouter 요청에 실패했습니다.';
  if (status === 401) text = 'OpenRouter API 키가 올바르지 않습니다. [설정]에서 다시 확인해 주세요.';
  else if (status === 402) text = 'OpenRouter 크레딧이 부족합니다. openrouter.ai에서 크레딧을 충전하거나, [설정]에서 이름이 ":free"로 끝나는 무료 모델을 골라 주세요.';
  else if (status === 403) text = '이 요청은 OpenRouter에서 거부되었습니다(키 권한 또는 모델 제한).';
  else if (status === 404 || (status === 400 && /not a valid model|model.*not (found|exist)|no endpoints/i.test(msg))) text = 'OpenRouter 모델 이름을 찾을 수 없습니다. [설정]에서 모델을 다시 골라 주세요.';
  else if (status === 429) text = 'OpenRouter 요청 한도를 넘었습니다. 잠시 후 다시 시도해 주세요.';
  else if (status >= 500) text = 'OpenRouter 또는 모델 서버가 혼잡합니다. 잠시 후 다시 시도해 주세요.';
  else if (status === 400 && /context|too long|maximum.*tokens/i.test(msg)) text = '선택한 범위의 자료가 너무 깁니다. 범위를 줄이거나 [설정]의 자료 최대 길이를 낮춰 주세요.';
  const err = new Error(text);
  err.status = status;
  err.raw = msg;
  err.badModel = /모델 이름을 찾을 수 없습니다/.test(text);
  return err;
}

function withTimeout(signal, ms) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new TimeoutError()), ms);
  const onAbort = () => ctrl.abort(signal.reason);
  if (signal) { if (signal.aborted) ctrl.abort(signal.reason); else signal.addEventListener('abort', onAbort, { once: true }); }
  return { signal: ctrl.signal, done: () => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); }, timedOut: () => ctrl.signal.reason instanceof TimeoutError };
}

async function post(key, body, { signal, timeout = TIMEOUT_MS, stream = false } = {}) {
  const t = withTimeout(signal, timeout);
  try {
    const res = await fetch(`${BASE}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}`, 'x-title': 'Sociology and IR Study' },
      body: JSON.stringify(body),
      signal: t.signal,
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      throw friendly(res.status, j.error?.message || res.statusText);
    }
    if (stream) return res;
    const data = await res.json();
    // 모델 쪽 오류가 200 응답 안에 오는 경우
    if (data.error) throw friendly(data.error.code || 500, data.error.message);
    return data;
  } catch (e) {
    if (t.timedOut()) throw new TimeoutError();
    if (signal?.aborted) throw new CancelledError();
    if (e.status) throw e;
    throw new Error('네트워크 연결을 확인해 주세요. (' + e.message + ')');
  } finally {
    t.done();
  }
}

// ---------- 모델 ----------
export const cleanORModel = (id) => String(id || '').trim();
let modelsP = null;
export async function listORModels() {
  if (!modelsP) {
    modelsP = (async () => {
      let res;
      try { res = await fetch(`${BASE}/models`, { signal: AbortSignal.timeout(20000) }); } catch (e) { throw new Error('OpenRouter 모델 목록을 받지 못했습니다. 인터넷 연결을 확인해 주세요.'); }
      if (!res.ok) throw friendly(res.status, res.statusText);
      const j = await res.json();
      return (j.data || []).map((m) => ({ id: m.id, label: m.name || m.id, images: (m.architecture?.input_modalities || []).includes('image') }));
    })();
    modelsP.catch(() => { modelsP = null; });
  }
  return modelsP;
}
const verOf = (id) => { const m = id.match(/(\d+(?:\.\d+)?)(?!.*\d)/); return m ? parseFloat(m[1]) : 0; };
// 기본으로 쓸 모델: Claude Sonnet 최신 → Gemini Flash 최신 → GPT 최신 → 아무거나
export function pickORModel(list, wanted = '') {
  const ids = list.map((m) => m.id).filter((id) => !/(:free|:beta|preview|exp|image|audio|tts|embed|search|online|thinking)/i.test(id));
  const newest = (re) => ids.filter((id) => re.test(id)).sort((a, b) => verOf(b) - verOf(a) || a.length - b.length)[0];
  // 원래 고른 모델과 같은 회사·종류가 있으면 그것의 최신판
  const fam = (wanted.match(/^([\w-]+)\/([a-z]+(?:-[a-z]+)?)/) || []);
  return (fam[0] && newest(new RegExp('^' + fam[1] + '/' + fam[2].split('-')[0]))) ||
    newest(/^anthropic\/claude-sonnet/) || newest(/^anthropic\/claude/) || newest(/^google\/gemini.*flash/) || newest(/^openai\/gpt/) || ids[0] || null;
}

// 모델이 비어 있거나 찾을 수 없으면 최신 모델로 정해 설정에 저장한다
async function resolveModel(bad = '') {
  const next = pickORModel(await listORModels(), bad);
  if (!next) throw new Error('OpenRouter에서 쓸 모델을 찾지 못했습니다. [설정]에서 모델 ID를 직접 입력해 주세요.');
  settings().openrouterModel = next;
  save();
  document.dispatchEvent(new CustomEvent('openroutermodel', { detail: next }));
  if (bad) toast(`'${bad}' 모델을 쓸 수 없어서 '${next}' 모델로 바꿨어요. ([설정]에 저장됨)`, 'info', 7000);
  return next;
}

// 모델·선택 기능 문제를 자동으로 처리하며 요청한다
async function request(key, model, body, opts) {
  model = cleanORModel(model) || (await resolveModel());
  for (let attempt = 0; attempt < 5; attempt++) {
    const b = { ...body, model };
    if (off.reasoning) delete b.reasoning;
    if (b.response_format?.type === 'json_schema' && off.schema) b.response_format = off.jsonObject ? undefined : { type: 'json_object' };
    try {
      return await post(key, b, opts);
    } catch (e) {
      const raw = String(e.raw || '');
      if (e.badModel && attempt === 0) { model = await resolveModel(model); continue; }
      if (e.status === 400 && b.reasoning && /reasoning/i.test(raw)) { off.reasoning = true; continue; }
      if (e.status === 400 && b.response_format?.type === 'json_schema' && /response_format|json_schema|structured/i.test(raw)) { off.schema = true; continue; }
      if (e.status === 400 && b.response_format?.type === 'json_object' && /response_format|json/i.test(raw)) { off.jsonObject = true; continue; }
      throw e;
    }
  }
  throw new Error('OpenRouter 요청에 실패했습니다.');
}

const userContent = (prompt, images = []) => (images.length
  ? [...images.flatMap((im) => [im.label && { type: 'text', text: im.label }, { type: 'image_url', image_url: { url: `data:${im.mediaType};base64,${im.data}` } }].filter(Boolean)), { type: 'text', text: prompt }]
  : prompt);

function citations(msg) {
  return (msg?.annotations || []).filter((a) => a.type === 'url_citation' && a.url_citation?.url).map((a) => {
    const url = a.url_citation.url;
    let domain = '';
    try { domain = new URL(url).hostname.replace(/^www\./, ''); } catch {}
    return { url, title: a.url_citation.title || '', domain };
  });
}

// JSON 응답. web이면 웹 검색 플러그인을 켠다.
export async function orJSON({ key, model, systemText, prompt, schema, web = false, images = [], maxTokens = 32000, effort = 'low', signal }) {
  const body = {
    messages: [{ role: 'system', content: systemText }, { role: 'user', content: userContent(prompt, images) }],
    max_tokens: maxTokens,
    reasoning: { effort },
  };
  if (web) body.plugins = [{ id: 'web', max_results: 6 }];
  else body.response_format = { type: 'json_schema', json_schema: { name: 'result', strict: true, schema } };
  const data = await request(key, model, body, { signal });
  const msg = data.choices?.[0]?.message;
  const reason = data.choices?.[0]?.finish_reason;
  if (reason === 'length') throw new Error('응답이 너무 길어 잘렸습니다. 문항 수를 줄여 다시 시도해 주세요.');
  if (reason === 'content_filter') throw new Error('AI가 이 요청에 답하지 않았습니다. 조건을 바꿔 다시 시도해 주세요.');
  return { text: msg?.content || '', searchResults: citations(msg) };
}

// 대화(스트리밍). messages: [{role:'user'|'assistant', content}]
export async function orChat({ key, model, systemText, messages, onText, effort = 'low' }) {
  const body = { messages: [{ role: 'system', content: systemText }, ...messages], max_tokens: 16000, stream: true, reasoning: { effort } };
  const res = await request(key, model, body, { stream: true });
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '', full = '';
  for (;;) {
    let idle;
    const { value, done } = await Promise.race([reader.read(), new Promise((_, no) => { idle = setTimeout(() => no(new TimeoutError()), 90000); })]).finally(() => clearTimeout(idle));
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line.startsWith('data:')) continue; // ": OPENROUTER PROCESSING" 같은 알림 줄은 건너뜀
      const payload = line.slice(5).trim();
      if (payload === '[DONE]') return full;
      let data;
      try { data = JSON.parse(payload); } catch { continue; }
      if (data.error) throw friendly(data.error.code || 500, data.error.message);
      const t = data.choices?.[0]?.delta?.content;
      if (t) { full += t; onText && onText(t); }
    }
  }
  return full;
}

// 연결 확인: 짧은 요청 하나(30초 제한)
export async function orPing({ key, model }) {
  const data = await request(key, model, { messages: [{ role: 'user', content: '연결 확인입니다. "연결됨"이라고만 답하세요.' }], max_tokens: 300, reasoning: { effort: 'low' } }, { timeout: 30000 });
  return data.choices?.[0]?.message?.content || '연결됨';
}
