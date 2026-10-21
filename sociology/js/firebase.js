// Firebase 초기화 (CDN ES 모듈). 인증 상태는 브라우저를 닫아도 유지되고, Firestore는 오프라인 캐시를 쓴다.
import { firebaseConfig } from './firebase-config.js';

const V = '12.19.0';
const CDN = `https://www.gstatic.com/firebasejs/${V}/`;

export let fb = null; // { app, auth, db, A: auth 모듈, F: firestore 모듈 }

// 로컬 테스트용: 주소에 ?emulator=1 을 붙이면 Firebase 에뮬레이터에 연결한다.
function emulatorMode() {
  try {
    if (new URLSearchParams(location.search).has('emulator')) sessionStorage.setItem('socstudy:emulator', '1');
    return ['localhost', '127.0.0.1'].includes(location.hostname) && sessionStorage.getItem('socstudy:emulator') === '1';
  } catch {
    return false;
  }
}

export const configured = () => !String(firebaseConfig.apiKey).startsWith('REPLACE');

export async function initFirebase() {
  if (fb) return fb;
  const emu = emulatorMode();
  if (!configured() && !emu) throw new Error('Firebase 설정이 아직 없습니다. js/firebase-config.js에 프로젝트 설정을 넣어 주세요.');
  const [appM, A, F] = await Promise.all([
    import(CDN + 'firebase-app.js'),
    import(CDN + 'firebase-auth.js'),
    import(CDN + 'firebase-firestore.js'),
  ]);
  const config = emu && !configured() ? { apiKey: 'demo-key', projectId: 'demo-socstudy', authDomain: location.host } : firebaseConfig;
  const app = appM.initializeApp(config);
  const auth = A.initializeAuth(app, {
    persistence: [A.indexedDBLocalPersistence, A.browserLocalPersistence],
    popupRedirectResolver: A.browserPopupRedirectResolver,
  });
  auth.languageCode = 'ko';
  let db;
  try {
    db = F.initializeFirestore(app, { localCache: F.persistentLocalCache({ tabManager: F.persistentMultipleTabManager() }) });
  } catch {
    db = F.getFirestore(app); // 오프라인 캐시를 쓸 수 없는 환경(사생활 보호 모드 등)
  }
  if (emu) {
    A.connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
    F.connectFirestoreEmulator(db, '127.0.0.1', 8080);
  }
  fb = { app, auth, db, A, F, emu };
  return fb;
}

// 사용자 데이터 경로: users/{uid}/{컬렉션}/{문서}
export const userCol = (uid, name) => fb.F.collection(fb.db, 'users', uid, name);
export const userDoc = (uid, name, id) => fb.F.doc(fb.db, 'users', uid, name, id);
