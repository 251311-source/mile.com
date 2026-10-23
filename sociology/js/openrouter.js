// OpenRouter API 호출 (OpenAI 호환 REST). 사용자의 OpenRouter 키로 브라우저에서 직접 호출한다.
// 한 키로 여러 회사의 모델(Claude, Gemini, GPT 등)을 쓸 수 있다.
import { CancelledError } from './jobs.js';
import { settings, save } from './store.js';
import { toast } from './ui.js';

const BASE = 'https://openrouter.ai/api/v1';
const TIMEOUT_MS = 240000;

// 모델이 거부한 선택 기능은 이번 세션 동안 끈다
const off = { schema: false, jsonObject: false, reasoning: false, system: false, models: false };

export class TimeoutError extends Error {
  constructor() { super('OpenRouter가 제시간에 응답하지 않았습니다. 잠시 후 다시 시도하거나 [설정]에서 더 빠른 모델을 골라 보세요.'); this.name = 'TimeoutError'; }
}

function friendly(status, msg) {
  let text = msg || 'OpenRouter 요청에 실패했습니다.';
  if (status === 401) text = 'OpenRouter API 키가 올바르지 않습니다. [설정]에서 다시 확인해 주세요.';
  else if (status === 402) text = 'OpenRouter 크레딧이 부족합니다. openrouter.ai에서 크레딧을 충전하거나, [설정]에서 이름이 ":free"로 끝나는 무료 모델을 골라 주세요.';
  else if (status === 403) text = '이 요청은 OpenRouter에서 거부되었습니다(키 권한 또는 모델 제한).';
  else if (status === 404 || (status === 400 && /not a valid model|model.*not (found|exist)|no endpoints/i.test(msg))) text = 'OpenRouter 모델 이름을 찾을 수 없습니다. [설정]에서 모델을 다시 골라 주세요.';
  else if (status === 429 && /per[- ]day|daily|requests per day/i.test(msg)) text = '오늘 쓸 수 있는 무료 모델 요청 횟수를 다 썼어요(OpenRouter 계정에 크레딧을 산 적이 없으면 하루 약 50회). 내일 다시 쓰거나, OpenRouter에 크레딧을 $10 이상 한 번 충전하면 무료 모델 한도가 하루 약 1000회로 늘어나요(무료 모델은 크레딧이 차감되지 않음). Google AI Studio의 무료 Gemini 키를 [설정]에 넣어 써도 됩니다.';
  else if (status === 429) text = /:free/.test(String(settings().openrouterModel)) ? '무료 모델이 지금 너무 붐벼요(분당 요청 한도). 잠시 후 다시 시도하거나 [설정]에서 다른 무료 모델을 골라 주세요.' : 'OpenRouter 요청 한도를 넘었습니다. 잠시 후 다시 시도해 주세요.';
  else if (status >= 500) text = 'OpenRouter 또는 모델 서버가 혼잡합니다. 잠시 후 다시 시도해 주세요.';
  else if (status === 400 && /context|too long|maximum.*tokens/i.test(msg)) text = '선택한 범위의 자료가 너무 깁니다. 범위를 줄이거나 [설정]의 자료 최대 길이를 낮춰 주세요.';
  const err = new Error(text);
  err.status = status;
  err.raw = msg;
  err.badModel = /모델 이름을 찾을 수 없습니다/.test(text);
  err.daily = status === 429 && /per[- ]day|daily|requests per day/i.test(msg);
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
      const err = friendly(res.status, [j.error?.message, j.error?.metadata?.raw].filter(Boolean).join(' ') || res.statusText);
      if (res.status === 429) {
        // 언제 다시 보내도 되는지 알려 주면 그만큼 기다린다
        const ra = Number(res.headers.get('retry-after'));
        const reset = Number(res.headers.get('x-ratelimit-reset') || j.error?.metadata?.headers?.['X-RateLimit-Reset']);
        err.retryMs = ra > 0 ? ra * 1000 : reset > Date.now() ? reset - Date.now() : 0;
      }
      throw err;
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
      const zero = (v) => v != null && Number(v) === 0;
      return (j.data || []).map((m) => ({ id: m.id, label: m.name || m.id, images: (m.architecture?.input_modalities || []).includes('image'), free: /:free$/.test(m.id) || (zero(m.pricing?.prompt) && zero(m.pricing?.completion)) }));
    })();
    modelsP.catch(() => { modelsP = null; });
  }
  return modelsP;
}
const verOf = (id) => { const m = id.match(/(\d+(?:\.\d+)?)(?!.*\d)/); return m ? parseFloat(m[1]) : 0; };
// 기본으로 쓸 모델. 유료: Claude Sonnet 최신 → Gemini Flash → GPT. 무료(free): Gemini Flash → GPT → DeepSeek → Qwen → Llama
export function pickORModel(list, wanted = '', { free = /:free$/.test(wanted) || !!settings().openrouterFree } = {}) {
  const SKIP = /(:beta|preview|exp|image|audio|tts|embed|search|online|thinking|vision-only)/i;
  const ids = list.filter((m) => (free ? m.free : !m.free) && !SKIP.test(m.id)).map((m) => m.id);
  const newest = (re) => ids.filter((id) => re.test(id)).sort((a, b) => verOf(b) - verOf(a) || a.length - b.length)[0];
  // 원래 고른 모델과 같은 회사·종류가 있으면 그것의 최신판
  const fam = (wanted.match(/^([\w-]+)\/([a-z]+(?:-[a-z]+)?)/) || []);
  const same = fam[0] && newest(new RegExp('^' + fam[1] + '/' + fam[2].split('-')[0]));
  const order = free
    ? [/^google\/gemini.*flash/, /^google\/gemini/, /^openai\/gpt/, /^deepseek\//, /^qwen\//, /^meta-llama\/llama/, /^mistralai\//]
    : [/^anthropic\/claude-sonnet/, /^anthropic\/claude/, /^google\/gemini.*flash/, /^openai\/gpt/];
  return same || order.map(newest).find(Boolean) || ids[0] || null;
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

// ---------- 무료 모델: 요청 간격 조절 + 다른 무료 모델로 자동 전환 ----------
const isFree = (model) => /:free$/.test(model);
// 무료 모델은 분당 요청 수가 적어서, 동시에 2개까지·약 3초 간격으로 보낸다
const FREE_GAP = 3200, FREE_PARALLEL = 2;
let freeActive = 0, freeLast = 0;
const freeQueue = [];
function freeSlot() {
  return new Promise((ok) => { freeQueue.push(ok); pump(); });
}
function pump() {
  if (!freeQueue.length || freeActive >= FREE_PARALLEL) return;
  const waitMs = Math.max(0, freeLast + FREE_GAP - Date.now());
  if (waitMs) { setTimeout(pump, waitMs); return; }
  freeActive++;
  freeLast = Date.now();
  const ok = freeQueue.shift();
  let done = false;
  ok(() => { if (done) return; done = true; freeActive--; pump(); }); // 두 번 불러도 한 번만
  pump();
}
// 그 모델이 붐비면 OpenRouter가 대신 쓸 다른 무료 모델(최대 2개)
async function freeFallbacks(model, needImages) {
  try {
    const list = await listORModels();
    const SKIP = /(:beta|preview|exp|image|audio|tts|embed|search|online)/i;
    const pool = list.filter((m) => m.free && m.id !== model && !SKIP.test(m.id) && (!needImages || m.images));
    const pref = [/^google\/gemini/, /^openai\//, /^deepseek\//, /^qwen\//, /^meta-llama\//, /^mistralai\//];
    const rank = (id) => { const k = pref.findIndex((re) => re.test(id)); return k < 0 ? 99 : k; };
    return pool.sort((a, b) => rank(a.id) - rank(b.id) || verOf(b.id) - verOf(a.id)).slice(0, 2).map((m) => m.id);
  } catch {
    return [];
  }
}
const sleep = (ms, signal) => new Promise((ok, no) => {
  const t = setTimeout(ok, ms);
  signal?.addEventListener('abort', () => { clearTimeout(t); no(new CancelledError()); }, { once: true });
});
let waitNoticeAt = 0;

// 모델·선택 기능 문제를 자동으로 처리하며 요청한다
async function request(key, model, body, opts = {}) {
  model = cleanORModel(model) || (await resolveModel());
  const free = isFree(model);
  const needImages = JSON.stringify(body.messages).includes('"image_url"');
  const backups = free && !off.models ? await freeFallbacks(model, needImages) : [];
  let waited = 0;
  for (let attempt = 0; attempt < 9; attempt++) {
    const b = { ...body, model };
    if (backups.length && !off.models) b.models = [model, ...backups];
    if (off.reasoning) delete b.reasoning;
    if (off.system) b.messages = mergeSystem(b.messages);
    if (b.response_format?.type === 'json_schema' && off.schema) b.response_format = off.jsonObject ? undefined : { type: 'json_object' };
    const release = free ? await freeSlot() : null;
    try {
      return await post(key, b, opts);
    } catch (e) {
      const raw = String(e.raw || '');
      // 예비 모델 목록(models)을 받지 않는 경우에만 끈다(오류 문장 속 'models/이름' 경로와 구분)
      if (e.status === 400 && b.models && /(\bmodels\b(?!\/)[^.]*(invalid|not (allowed|supported)|unrecognized|must|array))|((invalid|unrecognized|unknown)[^.]*\bmodels\b(?!\/))/i.test(raw)) { off.models = true; continue; }
      // 분당 한도: 알려 준 시간(없으면 점점 길게) 기다렸다가 다시 보낸다. 하루 한도는 기다려도 소용없다.
      if (e.status === 429 && !e.daily && waited < 100000) {
        const ms = Math.min(30000, e.retryMs || [6000, 12000, 20000, 30000][Math.min(3, attempt)]);
        if (Date.now() - waitNoticeAt > 20000) { waitNoticeAt = Date.now(); toast(`무료 모델 요청 한도 때문에 ${Math.round(ms / 1000)}초 기다렸다가 자동으로 다시 보낼게요.`, 'info', Math.min(ms, 8000)); }
        release?.(); // 기다리는 동안 다른 요청이 자리를 쓰게 한다
        await sleep(ms, opts.signal);
        waited += ms;
        continue;
      }
      if (e.badModel && attempt === 0) { model = await resolveModel(model); continue; }
      if (e.status === 400 && b.reasoning && /reasoning/i.test(raw)) { off.reasoning = true; continue; }
      if (e.status === 400 && b.messages.some((m) => m.role === 'system') && /system|developer instruction/i.test(raw)) { off.system = true; continue; }
      if (e.status === 400 && b.response_format?.type === 'json_schema' && /response_format|json_schema|structured/i.test(raw)) { off.schema = true; continue; }
      if (e.status === 400 && b.response_format?.type === 'json_object' && /response_format|json/i.test(raw)) { off.jsonObject = true; continue; }
      throw e;
    } finally {
      release?.();
    }
  }
  throw new Error('OpenRouter 요청에 실패했습니다.');
}

function mergeSystem(messages) {
  const sys = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
  const rest = messages.filter((m) => m.role !== 'system');
  if (!sys || !rest.length) return rest;
  const first = rest[0];
  const content = typeof first.content === 'string' ? `${sys}\n\n${first.content}` : [{ type: 'text', text: sys }, ...first.content];
  return [{ ...first, content }, ...rest.slice(1)];
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
