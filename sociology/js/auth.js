// 로그인 화면(구글·이메일), 상단 계정 표시와 로그아웃, 재인증, 계정 탈퇴
import { h, toast, modal } from './ui.js';
import { fb } from './firebase.js';
import { waitSaved, hasUnsaved, deleteAllUserData, stopSync } from './cloud.js';
import { docsDB } from './store.js';

const MSG = {
  'auth/invalid-email': '이메일 주소 형식이 올바르지 않아요.',
  'auth/missing-email': '이메일을 입력해 주세요.',
  'auth/missing-password': '비밀번호를 입력해 주세요.',
  'auth/invalid-credential': '이메일 또는 비밀번호가 맞지 않아요.',
  'auth/wrong-password': '비밀번호가 맞지 않아요.',
  'auth/user-not-found': '가입되지 않은 이메일이에요. [회원가입]을 눌러 주세요.',
  'auth/email-already-in-use': '이미 가입된 이메일이에요. [로그인]을 눌러 주세요.',
  'auth/weak-password': '비밀번호는 6자 이상이어야 해요.',
  'auth/too-many-requests': '시도가 너무 많아요. 잠시 후 다시 해 주세요.',
  'auth/network-request-failed': '인터넷 연결을 확인해 주세요.',
  'auth/popup-closed-by-user': '로그인 창이 닫혔어요. 다시 시도해 주세요.',
  'auth/cancelled-popup-request': '로그인 창이 닫혔어요. 다시 시도해 주세요.',
  'auth/operation-not-allowed': '이 로그인 방식이 아직 켜져 있지 않아요. (Firebase 콘솔에서 로그인 방법을 사용 설정해야 합니다)',
  'auth/unauthorized-domain': '이 주소는 로그인 허용 도메인에 없어요. (Firebase 콘솔 → Authentication → 설정 → 승인된 도메인)',
  'auth/requires-recent-login': '보안을 위해 다시 로그인한 뒤 시도해 주세요.',
  'auth/user-mismatch': '처음 로그인한 계정과 같은 계정으로 다시 로그인해 주세요.',
  'auth/internal-error': '로그인 중 오류가 발생했어요. 인터넷 연결을 확인하고 다시 시도해 주세요.',
  'auth/popup-blocked': '팝업이 차단되었어요. 팝업을 허용하거나 다시 눌러 주세요.',
};
export const authMessage = (e) => MSG[e?.code] || (e?.message ? `로그인 오류: ${e.message}` : '로그인 중 오류가 발생했어요.');

export function showLoginScreen() {
  const { A, auth } = fb;
  document.body.classList.add('signed-out');
  document.getElementById('auth-screen')?.remove();
  const err = h('p', { class: 'auth-error', role: 'alert' });
  const info = h('p', { class: 'auth-info', role: 'status' });
  const email = h('input', { class: 'input', type: 'email', autocomplete: 'email', placeholder: '이메일', 'aria-label': '이메일' });
  const pw = h('input', { class: 'input', type: 'password', autocomplete: 'current-password', placeholder: '비밀번호 (6자 이상)', 'aria-label': '비밀번호',
    onkeydown: (e) => { if (e.key === 'Enter') run(login); } });
  const btns = [];
  const run = async (fn) => {
    err.textContent = ''; info.textContent = '';
    btns.forEach((b) => { b.disabled = true; });
    try { await fn(); } catch (e) { console.warn(e); err.textContent = authMessage(e); } finally { btns.forEach((b) => { b.disabled = false; }); }
  };
  const google = async () => {
    const provider = new A.GoogleAuthProvider();
    provider.setCustomParameters({ prompt: 'select_account' });
    try {
      await A.signInWithPopup(auth, provider);
    } catch (e) {
      if (['auth/popup-blocked', 'auth/operation-not-supported-in-environment'].includes(e.code)) return A.signInWithRedirect(auth, provider);
      throw e;
    }
  };
  const login = () => A.signInWithEmailAndPassword(auth, email.value.trim(), pw.value);
  const signup = () => A.createUserWithEmailAndPassword(auth, email.value.trim(), pw.value);
  const reset = async () => {
    if (!email.value.trim()) { err.textContent = '비밀번호를 재설정할 이메일을 먼저 입력해 주세요.'; return; }
    await A.sendPasswordResetEmail(auth, email.value.trim());
    info.textContent = `${email.value.trim()}(으)로 비밀번호 재설정 메일을 보냈어요. 메일함(스팸함 포함)을 확인해 주세요.`;
  };
  const gBtn = h('button', { class: 'btn google-btn', onclick: () => run(google) }, h('span', { class: 'g-mark', 'aria-hidden': 'true' }, 'G'), 'Google 계정으로 로그인');
  const lBtn = h('button', { class: 'btn primary', onclick: () => run(login) }, '로그인');
  const sBtn = h('button', { class: 'btn', onclick: () => run(signup) }, '회원가입');
  const rBtn = h('button', { class: 'linklike', onclick: () => run(reset) }, '비밀번호를 잊으셨나요?');
  btns.push(gBtn, lBtn, sBtn, rBtn);
  const screen = h('section', { id: 'auth-screen', class: 'auth-screen', 'aria-label': '로그인' },
    h('div', { class: 'auth-card' },
      h('div', { class: 'auth-brand' }, h('span', { class: 'brand-mark', 'aria-hidden': 'true' }, '社'), h('h1', null, '사회학 학습')),
      h('p', { class: 'muted' }, '로그인하면 오답노트·질문 기록·정답률·문제 은행이 계정에 저장되어, 어느 기기에서든 같은 기록으로 이어서 공부할 수 있어요.'),
      gBtn,
      h('div', { class: 'auth-or' }, h('span', null, '또는 이메일로')),
      email, pw,
      h('div', { class: 'row' }, lBtn, sBtn),
      rBtn, err, info));
  document.body.appendChild(screen);
}

export function hideLoginScreen() {
  document.body.classList.remove('signed-out');
  document.getElementById('auth-screen')?.remove();
}

export function showAccount(user) {
  const box = document.getElementById('account-box');
  if (!box) return;
  box.replaceChildren(
    h('span', { class: 'account-email', title: user.email || '' }, user.email || '로그인됨'),
    h('button', { class: 'btn small ghost', onclick: logout }, '로그아웃'));
}

// 이 브라우저에 남은 계정 데이터(오프라인 캐시)를 지우고 새로 고친다.
async function clearLocalCache() {
  const { F, db } = fb;
  await stopSync();
  try { await F.terminate(db); await F.clearIndexedDbPersistence(db); } catch (e) { console.warn(e); }
}

export async function logout() {
  if (hasUnsaved()) {
    const saved = await waitSaved(5000);
    if (!saved) {
      const ok = await new Promise((resolve) => modal('로그아웃', h('p', null, '아직 계정에 저장되지 않은 기록이 있어요(오프라인일 수 있어요). 지금 로그아웃하면 그 기록은 사라질 수 있어요. 그래도 로그아웃할까요?'), [
        { label: '취소', onclick: () => resolve(false) },
        { label: '로그아웃', primary: true, onclick: () => resolve(true) },
      ]));
      if (!ok) return;
    }
  }
  await fb.A.signOut(fb.auth);
  await clearLocalCache();
  location.reload();
}

// 계정 탈퇴처럼 민감한 작업 전에 다시 로그인을 확인한다.
async function reauthenticate(user) {
  const { A } = fb;
  const providers = user.providerData.map((p) => p.providerId);
  if (providers.includes('password')) {
    const pw = await new Promise((resolve) => {
      const input = h('input', { class: 'input', type: 'password', autocomplete: 'current-password', placeholder: '비밀번호' });
      modal('비밀번호 확인', h('div', null, h('p', null, '본인 확인을 위해 비밀번호를 입력해 주세요.'), input), [
        { label: '취소', onclick: () => resolve(null) },
        { label: '확인', primary: true, onclick: () => resolve(input.value) },
      ]);
      setTimeout(() => input.focus(), 50);
    });
    if (pw == null) throw new Error('취소했어요.');
    await A.reauthenticateWithCredential(user, A.EmailAuthProvider.credential(user.email, pw));
  } else {
    await A.reauthenticateWithPopup(user, new A.GoogleAuthProvider());
  }
}

export async function deleteAccount() {
  const { A, auth } = fb;
  const user = auth.currentUser;
  if (!user) return;
  try {
    await reauthenticate(user);
  } catch (e) {
    toast(authMessage(e), 'error');
    return;
  }
  toast('계정 데이터를 삭제하고 있어요…');
  try {
    await deleteAllUserData(user.uid);
    const local = (await docsDB.all()).filter((d) => d.owner === user.uid);
    for (const d of local) await docsDB.remove(d.id);
    await A.deleteUser(user);
  } catch (e) {
    console.error(e);
    toast('탈퇴 중 오류가 발생했어요: ' + authMessage(e), 'error');
    return;
  }
  await clearLocalCache();
  alert('계정과 모든 학습 기록을 삭제했어요.');
  location.reload();
}
