// DOM 헬퍼, 공통 UI 조각. AI가 만든 문자열은 모두 textContent로만 넣는다.
import { resolveSource } from './docs.js';

export function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (['value', 'checked', 'disabled', 'selected', 'htmlFor', 'indeterminate'].includes(k)) el[k] = v;
      else el.setAttribute(k, v === true ? '' : String(v));
    }
  }
  append(el, kids);
  return el;
}
export function append(el, kids) {
  for (const k of kids.flat(Infinity)) {
    if (k == null || k === false) continue;
    el.appendChild(k instanceof Node ? k : document.createTextNode(String(k)));
  }
  return el;
}
export const add = (el, ...kids) => append(el, kids);
export function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); return el; }
export const $ = (sel, root = document) => root.querySelector(sel);

export const CIRC = ['①', '②', '③', '④', '⑤', '⑥', '⑦', '⑧'];

export function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ---------- 토스트 ----------
export function toast(msg, kind = 'info', ms = 4000) {
  let box = $('#toasts');
  if (!box) { box = h('div', { id: 'toasts', 'aria-live': 'polite' }); document.body.appendChild(box); }
  const t = h('div', { class: `toast ${kind}` }, msg);
  box.appendChild(t);
  setTimeout(() => t.classList.add('out'), ms - 400);
  setTimeout(() => t.remove(), ms);
}

// ---------- 로딩 ----------
export function loadingBox(msg = 'AI가 자료를 읽고 있습니다…') {
  return h('div', { class: 'loading' }, h('span', { class: 'spinner', 'aria-hidden': 'true' }), h('span', null, msg));
}
// 비동기 작업 동안 버튼을 잠그고 오류를 보여 준다.
export async function busy(btn, fn) {
  const label = btn?.textContent;
  if (btn) { btn.disabled = true; btn.dataset.busy = '1'; }
  try {
    return await fn();
  } catch (e) {
    showError(e);
    return undefined;
  } finally {
    if (btn) { btn.disabled = false; delete btn.dataset.busy; btn.textContent = label; }
  }
}
export function showError(e) {
  console.error(e);
  if (e && e.name === 'NeedKeyError') {
    toast(e.message, 'error');
    location.hash = '#/settings';
    return;
  }
  toast(e?.message || String(e), 'error');
}
export function errorBox(e, retry) {
  return h('div', { class: 'notice error' },
    h('p', null, e?.message || String(e)),
    retry && h('button', { class: 'btn', onclick: retry }, '다시 시도'));
}

// ---------- 출처 ----------
export function sourceChips(sources, { label = '출처' } = {}) {
  const list = (sources || []).map(resolveSource).filter(Boolean);
  const seen = new Set();
  const uniq = list.filter((s) => (seen.has(s.label) ? false : seen.add(s.label)));
  if (!uniq.length) return h('div', { class: 'sources none' }, `${label}: 자료 위치 표기 없음`);
  return h('div', { class: 'sources' },
    h('span', { class: 'src-label' }, label),
    uniq.map((s) => h('span', {
      class: 'chip src' + (s.valid ? '' : ' bad'),
      title: s.valid ? (s.inScope ? '학습 범위 안의 위치' : '학습 범위 밖의 위치') : '자료에서 확인되지 않는 위치',
    }, (s.valid ? '📄 ' : '⚠ ') + s.label + (s.valid ? '' : ' (확인 불가)'))));
}

// 채팅 답변 등 자유 텍스트: [[D1:12]] → 출처 칩, 〔자료 외〕 → 강조, **굵게**, 목록
export function richText(text) {
  const wrap = h('div', { class: 'rich' });
  const lines = String(text || '').split('\n');
  let list = null;
  for (const raw of lines) {
    const line = raw.trimEnd();
    if (!line.trim()) { list = null; continue; }
    const bullet = line.match(/^\s*(?:[-*•]|\d+[.)])\s+(.*)$/);
    const external = /〔자료 외〕|\[자료 외\]/.test(line);
    const node = h(bullet ? 'li' : 'p', { class: external ? 'external' : null }, inline(bullet ? bullet[1] : line));
    if (bullet) {
      if (!list) { list = h('ul'); wrap.appendChild(list); }
      list.appendChild(node);
    } else {
      list = null;
      wrap.appendChild(node);
    }
  }
  return wrap;
}
function inline(s) {
  const out = [];
  const re = /\[\[(D\d+):(\d+)\]\]|\*\*([^*]+)\*\*|(〔자료 외〕|\[자료 외\])/g;
  let last = 0, m;
  while ((m = re.exec(s))) {
    if (m.index > last) out.push(s.slice(last, m.index));
    if (m[1]) {
      const r = resolveSource({ doc: m[1], page: +m[2] });
      out.push(h('span', { class: 'chip src inline' + (r.valid ? '' : ' bad') }, (r.valid ? '📄 ' : '⚠ ') + r.label));
    } else if (m[3]) out.push(h('strong', null, m[3]));
    else out.push(h('span', { class: 'tag external' }, '자료 외'));
    last = re.lastIndex;
  }
  if (last < s.length) out.push(s.slice(last));
  return out;
}

// ---------- 모달 ----------
export function modal(title, body, actions = []) {
  const close = () => back.remove();
  const back = h('div', { class: 'modal-back', onclick: (e) => { if (e.target === back) close(); } },
    h('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
      h('div', { class: 'modal-head' }, h('h3', null, title), h('button', { class: 'icon-btn', 'aria-label': '닫기', onclick: close }, '✕')),
      h('div', { class: 'modal-body' }, body),
      actions.length ? h('div', { class: 'modal-actions' }, actions.map((a) => h('button', { class: 'btn ' + (a.primary ? 'primary' : ''), onclick: () => { if (a.onclick() !== false) close(); } }, a.label))) : null));
  document.body.appendChild(back);
  return close;
}
export function confirmBox(msg) {
  return new Promise((resolve) => {
    modal('확인', h('p', null, msg), [
      { label: '취소', onclick: () => resolve(false) },
      { label: '확인', primary: true, onclick: () => resolve(true) },
    ]);
  });
}

// ---------- 현재 풀고 있는 문제 (AI 질문 연결용) ----------
export const current = { ctx: null };
export function setCurrent(ctx) {
  current.ctx = ctx;
  document.dispatchEvent(new CustomEvent('ctxchange'));
}

export function fmtDate(ts) {
  const d = new Date(ts);
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
export function pct(x) { return Math.round(x * 100) + '%'; }

export function pageHead(title, desc, ...extra) {
  return h('header', { class: 'page-head' }, h('h1', null, title), desc && h('p', { class: 'muted' }, desc), extra);
}

export function field(label, control, hint) {
  return h('label', { class: 'field' }, h('span', { class: 'field-label' }, label), control, hint && h('span', { class: 'hint' }, hint));
}
export function select(options, value, onchange) {
  return h('select', { onchange: (e) => onchange && onchange(e.target.value) },
    options.map(([v, l]) => h('option', { value: v, selected: String(v) === String(value) }, l)));
}
