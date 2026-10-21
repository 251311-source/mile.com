// 화면 옆에 고정된 [AI 질문]·[질문 기록] 버튼과 패널.
import { h, add, clear, richText, current, toast, showError, fmtDate } from './ui.js';
import { chat } from './ai.js';
import { S, addQlog, updateQlog, removeQlog, onChange } from './store.js';
import { hasScope } from './docs.js';

let chatPanel, logPanel, chatList, chatInput, linkBox, linkCheck;
const history = []; // {role, content, display}
let qlogFilter = 'all';

export function initPanels() {
  const dock = h('div', { class: 'dock', role: 'toolbar', 'aria-label': '빠른 도구' },
    h('button', { class: 'dock-btn ai', onclick: () => toggle('chat'), 'aria-label': 'AI 질문 열기' }, h('span', { class: 'dock-ico' }, '💬'), h('span', { class: 'dock-txt' }, 'AI 질문')),
    h('button', { class: 'dock-btn log', onclick: () => toggle('log'), 'aria-label': '질문 기록 열기' }, h('span', { class: 'dock-ico' }, '📝'), h('span', { class: 'dock-txt' }, '질문 기록'), h('span', { class: 'dock-badge', id: 'qlog-badge' })));
  document.body.appendChild(dock);

  // ---- AI 질문 패널 ----
  chatList = h('div', { class: 'chat-list' });
  chatInput = h('textarea', { class: 'input', rows: 3, placeholder: '궁금한 것을 물어보세요. (Enter 전송, Shift+Enter 줄바꿈)', onkeydown: (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); } } });
  linkCheck = h('input', { type: 'checkbox', checked: true });
  linkBox = h('label', { class: 'link-box' }, linkCheck, h('span', { class: 'link-label' }));
  chatPanel = h('aside', { class: 'panel', id: 'chat-panel', 'aria-label': 'AI 질문', hidden: true },
    h('div', { class: 'panel-head' }, h('h2', null, '💬 AI 질문'),
      h('button', { class: 'btn ghost small', onclick: () => { history.length = 0; clear(chatList); chatList.appendChild(chatIntro()); } }, '새 대화'),
      h('button', { class: 'icon-btn', 'aria-label': '닫기', onclick: () => toggle(null) }, '✕')),
    chatList,
    h('div', { class: 'chat-compose' }, linkBox, chatInput,
      h('div', { class: 'row end' }, h('button', { class: 'btn primary', id: 'chat-send', onclick: send }, '보내기'))));
  chatList.appendChild(chatIntro());
  document.body.appendChild(chatPanel);

  // ---- 질문 기록 패널 ----
  logPanel = h('aside', { class: 'panel', id: 'log-panel', 'aria-label': '질문 기록', hidden: true });
  document.body.appendChild(logPanel);
  drawLog();
  onChange(() => { if (!logPanel.hidden) drawLog(); badge(); });
  badge();

  document.addEventListener('ctxchange', updateLink);
  updateLink();
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') toggle(null); });
}

function chatIntro() {
  return h('div', { class: 'chat-intro muted' },
    h('p', null, '업로드한 자료를 우선으로 답하고, 근거가 된 쪽/슬라이드를 표시합니다. 자료 밖 내용으로 보충할 때는 「자료 외」로 표시합니다.'),
    h('p', null, '문제를 풀다가 열면 그 문제와 연결해서 질문할 수 있습니다.'));
}

function badge() {
  const n = S().qlog.filter((x) => !x.resolved).length;
  const b = document.getElementById('qlog-badge');
  if (b) { b.textContent = n ? String(n) : ''; b.hidden = !n; }
}

function toggle(which) {
  const openChat = which === 'chat' && chatPanel.hidden;
  const openLog = which === 'log' && logPanel.hidden;
  chatPanel.hidden = !openChat;
  logPanel.hidden = !openLog;
  document.body.classList.toggle('panel-open', openChat || openLog);
  if (openChat) { updateLink(); chatInput.focus(); }
  if (openLog) { drawLog(); logPanel.querySelector('textarea')?.focus(); }
}

function updateLink() {
  const c = current.ctx;
  linkBox.hidden = !c;
  if (c) linkBox.querySelector('.link-label').textContent = `현재 문제와 연결: ${c.label || '현재 문제'}`;
}

export function openChatAbout(ctx, prefill = '') {
  if (ctx) { current.ctx = ctx; document.dispatchEvent(new CustomEvent('ctxchange')); }
  if (chatPanel.hidden) toggle('chat');
  linkCheck.checked = true;
  chatInput.value = prefill;
  chatInput.focus();
}

function ctxText(c) {
  if (!c) return '';
  const q = c.q;
  const lines = ['[사용자가 지금 보고 있는 문제]'];
  if (c.text) lines.push(c.text);
  if (q) {
    lines.push(`유형: ${q.type}`, `문제: ${q.stem}`);
    if (q.context) lines.push(`사례/지문: ${q.context}`);
    if (q.statements) lines.push('보기: ' + q.statements.map((s) => `${s.label}. ${s.text}`).join(' / '));
    if (q.options?.length) lines.push('선지: ' + q.options.map((o, i) => `${i + 1}) ${o}`).join(' / '));
    if (q.matching) lines.push('정답 연결: ' + q.matching.map((r) => `${r.sociologist}-${r.theory}-${r.concept}`).join(' / '));
    if (q.order_items) lines.push('정답 순서: ' + q.order_items.join(' → '));
    if (q.table) lines.push('비교표: ' + JSON.stringify(q.table));
    if (q.answer_index >= 0 && q.options?.[q.answer_index]) lines.push('정답: ' + q.options[q.answer_index]);
    if (q.answer_text) lines.push('정답/모범답안: ' + q.answer_text);
    if (q.ox) lines.push('정답: ' + q.ox);
    if (q.blanks) lines.push('빈칸 정답: ' + q.blanks.map((b) => b.answer).join(', '));
    if (q.model_answer) lines.push('모범 답안: ' + q.model_answer);
    if (q.explanation) lines.push('해설: ' + q.explanation);
  }
  if (c.answer != null) lines.push('사용자의 답: ' + JSON.stringify(c.answer));
  if (c.result) lines.push(`채점 결과: ${c.result.correct ? '정답' : '오답'}${c.result.feedback ? ' / ' + c.result.feedback : ''}`);
  if (!c.result && q) lines.push('(아직 제출 전이므로 정답을 직접 알려 주지 말고 힌트와 개념 설명으로 도와줄 것)');
  return lines.join('\n');
}

const CHAT_RULES = `[답변 규칙]
- 업로드한 자료를 우선 근거로 답하고, 근거가 된 위치를 문장 끝에 [[D1:12]] 형식으로 표시한다(자료 본문의 표지 그대로).
- 자료에 없는 내용으로 보충해야 하면 그 문장 앞에 〔자료 외〕를 붙여 분명히 구분한다. 자료 외 내용은 최소한으로 쓴다.
- 쉬운 한국어로, 필요하면 짧은 목록을 쓴다. 마크다운 제목(#)이나 표는 쓰지 않는다.`;

async function send() {
  const text = chatInput.value.trim();
  if (!text) return;
  const btn = document.getElementById('chat-send');
  btn.disabled = true;
  chatInput.value = '';
  const linked = linkCheck.checked && current.ctx;
  const ctx = linked ? ctxText(current.ctx) : '';
  const userContent = `${history.length ? '' : CHAT_RULES + '\n\n'}${!hasScope() ? '(학습 범위가 선택되지 않아 자료가 없다. 자료 외 답변임을 밝힐 것)\n' : ''}${ctx ? ctx + '\n\n' : ''}[질문]\n${text}`;
  history.push({ role: 'user', content: userContent });

  chatList.querySelector('.chat-intro')?.remove();
  chatList.appendChild(h('div', { class: 'msg user' }, linked && h('div', { class: 'msg-ctx' }, '🔗 ' + current.ctx.label), text));
  const bubble = h('div', { class: 'msg ai' }, h('div', { class: 'typing' }, '답변 작성 중…'));
  chatList.appendChild(bubble);
  chatList.scrollTop = chatList.scrollHeight;

  let acc = '';
  try {
    const answer = await chat({
      messages: history.map(({ role, content }) => ({ role, content })),
      onText: (t) => {
        acc += t;
        bubble.replaceChildren(richText(acc));
        chatList.scrollTop = chatList.scrollHeight;
      },
    });
    history.push({ role: 'assistant', content: answer });
    bubble.replaceChildren(richText(answer), h('div', { class: 'msg-actions' },
      h('button', { class: 'btn ghost small', onclick: (e) => {
        addQlog({ text, answer, origin: 'ai', ctx: linked ? current.ctx.label : '' });
        e.target.textContent = '✔ 질문 기록에 저장됨';
        e.target.disabled = true;
      } }, '📝 질문 기록에 저장')));
  } catch (e) {
    history.pop();
    bubble.replaceChildren(h('div', { class: 'notice error' }, e.message));
    if (e.name === 'NeedKeyError') showError(e);
  } finally {
    btn.disabled = false;
    chatList.scrollTop = chatList.scrollHeight;
  }
}

let logBody = null;
function drawLog() {
  if (!logBody) {
    const ta = h('textarea', { class: 'input', rows: 3, placeholder: '이해 안 되는 것을 빠르게 적어 두세요. (Ctrl+Enter 추가)' });
    const submit = () => {
      const t = ta.value.trim();
      if (!t) return;
      addQlog({ text: t, ctx: current.ctx?.label || '' });
      ta.value = '';
      toast('질문 기록에 추가했습니다.');
    };
    ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) submit(); });
    logBody = h('div', { class: 'log-body-wrap' });
    add(logPanel,
      h('div', { class: 'panel-head' }, h('h2', null, '📝 질문 기록'), h('button', { class: 'icon-btn', 'aria-label': '닫기', onclick: () => toggle(null) }, '✕')),
      h('div', { class: 'log-compose' }, ta, h('div', { class: 'row end' }, h('button', { class: 'btn primary', onclick: submit }, '추가'))),
      logBody);
  }
  const items = S().qlog.filter((x) => qlogFilter === 'all' || (qlogFilter === 'open' ? !x.resolved : x.resolved));
  const counts = { all: S().qlog.length, open: S().qlog.filter((x) => !x.resolved).length };
  counts.done = counts.all - counts.open;
  logBody.replaceChildren(
    h('div', { class: 'seg', role: 'tablist' },
      [['all', '전체'], ['open', '미해결'], ['done', '해결']].map(([k, l]) => h('button', { role: 'tab', 'aria-selected': String(qlogFilter === k), class: qlogFilter === k ? 'on' : '', onclick: () => { qlogFilter = k; drawLog(); } }, `${l} ${counts[k]}`))),
    h('div', { class: 'log-list' }, items.length ? items.map(logItem) : h('p', { class: 'muted empty' }, qlogFilter === 'open' ? '미해결 질문이 없습니다.' : '기록이 없습니다.')));
}

function logItem(e) {
  const body = h('div', { class: 'log-body' }, h('p', { class: 'log-q' }, e.text));
  if (e.answer) body.appendChild(h('details', null, h('summary', null, 'AI 답변 보기'), richText(e.answer)));
  return h('div', { class: 'log-item' + (e.resolved ? ' done' : '') },
    h('div', { class: 'log-top' },
      h('button', { class: 'status ' + (e.resolved ? 'done' : 'open'), onclick: () => updateQlog(e.id, { resolved: !e.resolved }), title: '클릭하여 상태 변경' }, e.resolved ? '해결' : '미해결'),
      h('span', { class: 'muted small' }, fmtDate(e.ts) + (e.origin === 'ai' ? ' · AI 답변' : '') + (e.ctx ? ' · ' + e.ctx : '')),
      h('span', { class: 'grow' }),
      h('button', { class: 'icon-btn', title: 'AI에게 묻기', 'aria-label': 'AI에게 묻기', onclick: () => { toggle('chat'); linkCheck.checked = false; chatInput.value = e.text; chatInput.focus(); } }, '💬'),
      h('button', { class: 'icon-btn', title: '삭제', 'aria-label': '삭제', onclick: () => removeQlog(e.id) }, '🗑')),
    body);
}
