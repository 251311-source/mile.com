// Google Gemini API 호출 (REST). 사용자의 Gemini API 키로 브라우저에서 직접 호출한다.
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

async function call(key, model, method, body, { stream = false } = {}) {
  let res;
  try {
    res = await fetch(`${BASE}/models/${encodeURIComponent(model)}:${method}${stream ? '?alt=sse' : ''}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify(body),
    });
  } catch (e) {
    throw new Error('네트워크 연결을 확인해 주세요. (' + e.message + ')');
  }
  if (!res.ok) {
    const j = await res.json().catch(() => ({}));
    throw friendly(res.status, j.error?.message || res.statusText);
  }
  return res;
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
export async function geminiJSON({ key, model, systemText, prompt, schema, web = false, maxTokens = 32768, thinking = -1 }) {
  const body = {
    systemInstruction: { parts: [{ text: systemText }] },
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
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
    res = await callThinking(key, model, 'generateContent', body);
  } catch (e) {
    if (e.status === 400 && !web && !off.jsonSchema) {
      off.jsonSchema = true; // 스키마 강제를 지원하지 않는 모델: 프롬프트의 스키마 설명만으로 진행
      delete body.generationConfig.responseJsonSchema;
      res = await callThinking(key, model, 'generateContent', body);
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
    const { value, done } = await reader.read();
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

// 이 키로 쓸 수 있는 생성 모델 목록
export async function listGeminiModels(key) {
  const out = [];
  let token = '';
  for (let i = 0; i < 5; i++) {
    const res = await fetch(`${BASE}/models?pageSize=200${token ? '&pageToken=' + token : ''}`, { headers: { 'x-goog-api-key': key } });
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
