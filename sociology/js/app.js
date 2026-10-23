// 진입점: 상단 내비게이션, 해시 라우팅, 공통 안내.
import { h, clear, setCurrent, confirmBox, toast } from './ui.js';
import { loadDocs, hasScope, scopeSummary } from './docs.js';
import { onChange, settings, flush, S } from './store.js';
import { subject, setSubject, SUBJECTS, SUBJECT_IDS } from './subjects.js';
import { anyRunning } from './jobs.js';
import { initPanels } from './panels.js';
import { initFirebase, fb } from './firebase.js';
import { startSync, loadPrivate, readAccount, waitSaved } from './cloud.js';
import { showLoginScreen, hideLoginScreen, showAccount, authMessage } from './auth.js';
import { maybeAskMigration, runSubjectMigration } from './migrate.js';
import { backupOverdue, downloadBackup, BACKUP_REMIND_DAYS } from './backup.js';
import { hasAIKey } from './ai.js';

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
  ['lens', '🔭', '이론 렌즈 분석', () => import('./features/lens.js')],
  ['history', '🕰️', '역사적 배경 연결', () => import('./features/history.js')],
  ['confuse', '🔀', '헷갈리는 개념', () => import('./features/confuse.js')],
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

// 현재 과목의 메뉴 (과목마다 이름이 다른 메뉴는 과목 설정의 labels로 바꾼다)
const subjectRoutes = () => subject().routes.map((id) => {
  const r = ROUTES.find((x) => x[0] === id);
  const [ico, label] = subject().labels[id] || [r[1], r[2]];
  return [id, ico, label, r[3]];
});

function buildNav() {
  clear(nav);
  for (const [id, ico, label] of subjectRoutes()) {
    nav.appendChild(h('a', { href: `#/${id}`, 'data-route': id, class: 'nav-item' }, h('span', { class: 'nav-ico', 'aria-hidden': 'true' }, ico), h('span', null, label)));
  }
}

// 상단 과목 선택 [사회학] [국제정치]. 고른 과목은 계정에 저장되고, 화면을 새로 불러와 그 과목의 기록만 보여 준다.
function buildSubjectSwitch() {
  const sub = subject();
  document.querySelector('.brand').replaceChildren(h('span', { class: 'brand-mark', 'aria-hidden': 'true' }, sub.mark), sub.title);
  document.querySelector('meta[name=description]')?.setAttribute('content', `업로드한 PDF·PPT 자료 범위 안에서만 공부하는 ${sub.name} 학습 프로그램`);
  let box = document.getElementById('subject-switch');
  if (!box) {
    box = h('div', { id: 'subject-switch', class: 'seg subject-switch', role: 'group', 'aria-label': '과목 선택' });
    document.querySelector('.brand').after(box);
  }
  box.replaceChildren(...SUBJECT_IDS.map((id) => h('button', {
    type: 'button', class: id === sub.id ? 'on' : '', 'aria-pressed': String(id === sub.id), 'data-subject': id,
    onclick: () => switchSubject(id),
  }, SUBJECTS[id].name)));
}

async function switchSubject(id) {
  if (id === subject().id) return;
  if (anyRunning() && !(await confirmBox('생성 중인 작업이 있어요. 과목을 바꾸면 생성이 취소됩니다. 바꿀까요?'))) return;
  S().prefSubject = id;
  flush();
  toast(`${SUBJECTS[id].name} 과목으로 바꾸는 중…`);
  await waitSaved(8000);
  location.hash = '';
  location.reload();
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
  const routes = subjectRoutes();
  const id = (location.hash.match(/^#\/(\w+)/) || [])[1] || (hasScope() ? 'quiz' : 'scope');
  const r = routes.find((x) => x[0] === id) || routes[0]; // 다른 과목의 메뉴 주소면 첫 화면으로
  nav.querySelectorAll('.nav-item').forEach((a) => a.classList.toggle('active', a.dataset.route === r[0]));
  nav.querySelector('.active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  setCurrent(null);
  const token = ++renderToken;
  clear(main);
  const root = h('section', { class: 'page', 'data-page': r[0] });
  main.appendChild(root);
  document.title = `${r[2]} · ${subject().title}`;

  if (!NO_SCOPE_OK.has(r[0]) && !hasScope()) {
    root.appendChild(h('div', { class: 'empty-state' },
      h('h1', null, r[2]),
      h('p', null, '이 기능은 업로드한 자료의 학습 범위 안에서만 문제를 만듭니다.'),
      h('a', { class: 'btn primary', href: '#/scope' }, '📚 자료 올리고 범위 선택하기')));
    return;
  }
  if (!hasAIKey() && !NO_SCOPE_OK.has(r[0])) {
    root.appendChild(h('div', { class: 'notice' }, 'AI 기능을 쓰려면 ', h('a', { href: '#/settings' }, '설정'), '에서 Claude, Gemini 또는 OpenRouter API 키를 먼저 입력해 주세요.'));
  }
  const mod = await r[3]();
  if (token !== renderToken) return;
  const params = new URLSearchParams(location.hash.split('?')[1] || '');
  await mod.render(root, params);
  main.focus({ preventScroll: true });
}

function screenMessage(title, text) {
  clear(main);
  main.appendChild(h('div', { class: 'empty-state' }, h('h1', null, title), h('p', { class: 'muted' }, text)));
}

let started = false;
async function startApp(user) {
  started = true;
  hideLoginScreen();
  showAccount(user);
  screenMessage('불러오는 중…', '계정에 저장된 학습 기록을 불러오고 있어요.');
  await loadPrivate(user.uid); // API 키를 먼저 불러온 뒤 기록을 불러온다
  // 과목 구조 확인: 처음이면 기존 기록을 과목별 구조로 옮기고, 아니면 마지막으로 고른 과목을 연다
  const acct = await readAccount(user.uid);
  if (acct.state === 'offline') {
    screenMessage('인터넷 연결이 필요해요', '이 기기에서 처음 불러올 때는 인터넷 연결이 필요합니다. 연결한 뒤 새로 고쳐 주세요.');
    return;
  }
  let sid = acct.subject;
  if (acct.state === 'migrate') sid = await runSubjectMigration(user.uid, (el) => { clear(main); main.appendChild(el); });
  setSubject(SUBJECTS[sid] ? sid : 'soc');
  buildNav();
  buildSubjectSwitch();
  screenMessage('불러오는 중…', `${subject().name} 기록을 불러오고 있어요.`);
  await startSync(user.uid, subject().id);
  await loadDocs();
  initPanels();
  updateChip();
  updateBanner();
  onChange(() => { updateChip(); updateBanner(); });
  window.addEventListener('hashchange', route);
  // 다른 기기에서 이 계정을 탈퇴하면 이 기기도 로그아웃한다(지워진 기록을 다시 만들지 않도록)
  document.addEventListener('accountgone', async () => {
    alert('이 계정은 다른 기기에서 탈퇴되어 로그아웃합니다.');
    try { await fb.A.signOut(fb.auth); } catch {}
    location.reload();
  });
  // 다른 기기에서 바뀐 기록이 들어오면, 입력 중이 아닌 목록 화면은 새로 그린다
  document.addEventListener('remotechange', () => {
    const id = (location.hash.match(/^#\/(\w+)/) || [])[1];
    const typing = main.contains(document.activeElement) && /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName);
    if (['wrong', 'dashboard', 'bank', 'cards'].includes(id) && !typing && !main.querySelector('.qcard, .flashcard')) route();
  });
  route();
  if (fb.emu) window.__soc = { S, flush }; // 에뮬레이터 테스트 전용
  maybeAskMigration(user.uid);
}

async function init() {
  buildNav();
  document.body.classList.add('signed-out');
  try {
    await initFirebase();
  } catch (e) {
    console.error(e);
    screenMessage('시작할 수 없어요', e.message);
    return;
  }
  const { A, auth } = fb;
  A.getRedirectResult(auth).catch((e) => { showLoginScreen(); const el = document.querySelector('.auth-error'); if (el) el.textContent = authMessage(e); });
  A.onAuthStateChanged(auth, (user) => {
    if (user && !started) startApp(user).catch((e) => { console.error(e); screenMessage('불러오지 못했어요', e.message); });
    else if (!user && started) location.reload(); // 다른 탭에서 로그아웃함
    else if (!user) showLoginScreen();
  });
}
init();
