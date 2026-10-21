// 진입점: 상단 내비게이션, 해시 라우팅, 공통 안내.
import { h, clear, setCurrent } from './ui.js';
import { loadDocs, hasScope, scopeSummary } from './docs.js';
import { onChange, settings, flush } from './store.js';
import { initPanels } from './panels.js';
import { backupOverdue, downloadBackup, BACKUP_REMIND_DAYS } from './backup.js';

const ROUTES = [
  ['scope', '📚', '자료·범위', () => import('./features/scope.js')],
  ['quiz', '✏️', '종합 퀴즈', () => import('./features/quiz.js')],
  ['passage', '🔍', '비판적 읽기', () => import('./features/passage.js')],
  ['speaker', '🗣️', '발화자 맞히기', () => import('./features/speaker.js')],
  ['concept', '🧩', '개념 맞히기', () => import('./features/concept.js')],
  ['realworld', '📰', '현실 사례', () => import('./features/realworld.js')],
  ['critique', '⚖️', '이론 비판', () => import('./features/critique.js')],
  ['map', '🕸️', '개념 지도', () => import('./features/map.js')],
  ['cards', '🃏', '플래시카드', () => import('./features/flashcards.js')],
  ['exam', '⏱️', '시험 모드', () => import('./features/exam.js')],
  ['wrong', '📕', '오답노트', () => import('./features/wrong.js')],
  ['bank', '🗄️', '문제 은행', () => import('./features/bank.js')],
  ['dashboard', '📊', '취약점 분석', () => import('./features/dashboard.js')],
  ['settings', '⚙️', '설정', () => import('./features/settings.js')],
];
// 학습 범위가 없어도 쓸 수 있는 화면
const NO_SCOPE_OK = new Set(['scope', 'wrong', 'dashboard', 'settings', 'cards', 'bank']);

const nav = document.getElementById('nav');
const main = document.getElementById('main');
const scopeChip = document.getElementById('scope-chip');

function buildNav() {
  clear(nav);
  for (const [id, ico, label] of ROUTES) {
    nav.appendChild(h('a', { href: `#/${id}`, 'data-route': id, class: 'nav-item' }, h('span', { class: 'nav-ico', 'aria-hidden': 'true' }, ico), h('span', null, label)));
  }
}

function updateChip() {
  const s = scopeSummary();
  scopeChip.textContent = s.units ? `학습 범위: 파일 ${s.files}개 · ${s.units}쪽/슬라이드` : '학습 범위 미선택';
  scopeChip.classList.toggle('warn', !s.units);
}

let bannerDismissed = false;
function updateBanner() {
  const show = !bannerDismissed && backupOverdue();
  let el = document.getElementById('backup-banner');
  if (!show) { el?.remove(); return; }
  if (el) return;
  el = h('div', { id: 'backup-banner', class: 'backup-banner', role: 'status' },
    h('span', null, `💾 백업한 지 ${BACKUP_REMIND_DAYS}일이 지났어요.`),
    h('button', { class: 'btn small primary', onclick: () => { downloadBackup(); el.remove(); } }, '지금 백업'),
    h('button', { class: 'icon-btn', 'aria-label': '닫기', onclick: () => { bannerDismissed = true; el.remove(); } }, '✕'));
  main.before(el);
}

let renderToken = 0;
async function route() {
  const id = (location.hash.match(/^#\/(\w+)/) || [])[1] || (hasScope() ? 'quiz' : 'scope');
  const r = ROUTES.find((x) => x[0] === id) || ROUTES[0];
  nav.querySelectorAll('.nav-item').forEach((a) => a.classList.toggle('active', a.dataset.route === r[0]));
  nav.querySelector('.active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  setCurrent(null);
  const token = ++renderToken;
  clear(main);
  const root = h('section', { class: 'page', 'data-page': r[0] });
  main.appendChild(root);
  document.title = `${r[2]} · 사회학 학습`;

  if (!NO_SCOPE_OK.has(r[0]) && !hasScope()) {
    root.appendChild(h('div', { class: 'empty-state' },
      h('h1', null, r[2]),
      h('p', null, '이 기능은 업로드한 자료의 학습 범위 안에서만 문제를 만듭니다.'),
      h('a', { class: 'btn primary', href: '#/scope' }, '📚 자료 올리고 범위 선택하기')));
    return;
  }
  if (!settings().apiKey && !NO_SCOPE_OK.has(r[0])) {
    root.appendChild(h('div', { class: 'notice' }, 'AI 기능을 쓰려면 ', h('a', { href: '#/settings' }, '설정'), '에서 Anthropic API 키를 먼저 입력해 주세요.'));
  }
  const mod = await r[3]();
  if (token !== renderToken) return;
  const params = new URLSearchParams(location.hash.split('?')[1] || '');
  await mod.render(root, params);
  main.focus({ preventScroll: true });
}

async function init() {
  buildNav();
  initPanels();
  await loadDocs();
  updateChip();
  updateBanner();
  onChange(() => { updateChip(); updateBanner(); });
  window.addEventListener('hashchange', route);
  window.addEventListener('beforeunload', flush);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flush(); });
  route();
}
init();
