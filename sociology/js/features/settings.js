// 설정: API 키, 모델, 데이터 백업
import { h, add, pageHead, field, select, toast, confirmBox, busy, modal, fmtDate, clear } from '../ui.js';
import { settings, save, resetRecords, S } from '../store.js';
import { testKey, providerLabel } from '../ai.js';
import { downloadBackup, parseBackup, applyBackup, summarize, backupFileName } from '../backup.js';
import { REASONS, reportedLabel, showReview } from '../report.js';
import { TYPES } from '../questions.js';
import { saveSecret, waitSaved } from '../cloud.js';
import { subject, SUBJECTS, SUBJECT_IDS } from '../subjects.js';
import { listGeminiModels } from '../gemini.js';
import { deleteAccount } from '../auth.js';
import { fb } from '../firebase.js';
import { legacySummary, askMigration } from '../migrate.js';

export function render(root) {
  const s = settings();
  // 키 입력칸: 입력이 멈추면 계정의 비공개 문서에 저장
  const keyInput = (field, label, placeholder, name) => {
    let t = null;
    return h('input', { class: 'input', type: 'password', value: s[field] || '', placeholder, autocomplete: 'off', 'aria-label': label, oninput: (e) => {
      const v = e.target.value.trim();
      s[field] = v;
      clearTimeout(t);
      t = setTimeout(() => saveSecret(field, v).then(() => toast(v ? `${name} 키를 계정에 저장했어요.` : `${name} 키를 지웠어요.`)).catch((err) => toast(`${name} 키 저장 실패: ` + err.message, 'error')), 600);
      // 키가 하나뿐이면 그 AI를 자동으로 고른다
      const other = field === 'apiKey' ? 'geminiKey' : 'apiKey';
      if (v && !(s[other] || '').trim()) selectProvider(field === 'apiKey' ? 'anthropic' : 'gemini', false);
    } });
  };
  const key = keyInput('apiKey', 'API 키 입력', 'sk-ant-...', 'API');
  const gKey = keyInput('geminiKey', 'Gemini API 키 입력', 'AIza...', 'Gemini API');
  const testBtn = h('button', { class: 'btn', onclick: () => busy(testBtn, async () => { await testKey(); toast(`${providerLabel()}에 연결되었습니다. ✔`); }) }, '연결 확인');

  // Gemini 모델: 기본 목록 + 직접 입력 + 키로 사용 가능한 모델 불러오기
  const G_DEFAULT = [['gemini-2.5-pro', 'Gemini 2.5 Pro (정확)'], ['gemini-2.5-flash', 'Gemini 2.5 Flash (빠르고 저렴)'], ['gemini-2.5-flash-lite', 'Gemini 2.5 Flash-Lite (가장 저렴)']];
  const gModelInput = h('input', { class: 'input', type: 'text', value: s.geminiModel || 'gemini-2.5-pro', 'aria-label': 'Gemini 모델 ID', oninput: (e) => { s.geminiModel = e.target.value.trim(); save(); } });
  const gModelList = h('select', { class: 'input', 'aria-label': 'Gemini 모델 선택', onchange: (e) => { if (e.target.value) { s.geminiModel = e.target.value; gModelInput.value = e.target.value; save(); } } });
  const fillModels = (list) => {
    gModelList.replaceChildren(h('option', { value: '' }, '목록에서 고르기'), ...list.map(([id, l]) => h('option', { value: id, selected: id === s.geminiModel }, l)));
  };
  fillModels(G_DEFAULT);
  const loadModelsBtn = h('button', { class: 'btn small', onclick: () => busy(loadModelsBtn, async () => {
    if (!s.geminiKey) return toast('먼저 Gemini API 키를 입력해 주세요.', 'warn');
    const list = await listGeminiModels(s.geminiKey);
    fillModels(list.map((m) => [m.id, `${m.label} (${m.id})`]));
    toast(`사용할 수 있는 Gemini 모델 ${list.length}개를 불러왔어요.`);
  }) }, '사용 가능한 모델 불러오기');

  const claudeBox = h('div', { class: 'provider-box' },
    field('API 키 입력 (Anthropic Claude)', key, '키 발급: console.anthropic.com'),
    field('Claude 모델', select([['claude-opus-5-5', 'Claude Opus 5.5 (기본·가장 정확)'], ['claude-sonnet-5-5', 'Claude Sonnet 5.5 (더 빠르고 저렴)'], ['claude-haiku-5-5', 'Claude Haiku 5.5 (가장 빠르고 저렴)']], s.model, (v) => { s.model = v; save(); })));
  const geminiBox = h('div', { class: 'provider-box' },
    field('Gemini API 키 입력 (Google)', gKey, '키 발급: aistudio.google.com → Get API key'),
    h('div', { class: 'grid-2' },
      field('Gemini 모델', gModelList),
      field('모델 ID (직접 입력 가능)', gModelInput)),
    h('div', { class: 'row' }, loadModelsBtn, h('span', { class: 'muted small' }, '새 모델이 나오면 목록을 불러오거나 모델 ID를 직접 입력하세요.')));
  const showProvider = () => {
    claudeBox.classList.toggle('dim', s.provider === 'gemini');
    geminiBox.classList.toggle('dim', s.provider !== 'gemini');
  };
  showProvider();
  const PROVIDERS = [['anthropic', 'Anthropic Claude'], ['gemini', 'Google Gemini']];
  const providerSeg = h('div', { class: 'seg', role: 'radiogroup', 'aria-label': 'AI 제공자' },
    PROVIDERS.map(([v, l]) => h('button', { type: 'button', 'data-provider': v, class: (s.provider || 'anthropic') === v ? 'on' : '', 'aria-pressed': String((s.provider || 'anthropic') === v), onclick: () => selectProvider(v, true) }, l)));
  function selectProvider(v, announce) {
    if (s.provider === v && !announce) return;
    s.provider = v; save();
    providerSeg.querySelectorAll('button').forEach((x) => { const on = x.dataset.provider === v; x.classList.toggle('on', on); x.setAttribute('aria-pressed', String(on)); });
    showProvider();
    toast(`${PROVIDERS.find((p) => p[0] === v)[1]}를 사용합니다.`);
  }
  const fileIn = h('input', { type: 'file', accept: 'application/json,.json', hidden: true, onchange: async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    e.target.value = '';
    let obj;
    try { obj = parseBackup(await f.text()); } catch (err) { toast(err.message + ' 기존 기록은 그대로입니다.', 'error'); return; }
    const apply = async (mode) => {
      toast('백업을 적용하는 중이에요…');
      try { await applyBackup(obj, mode); await waitSaved(15000); } catch (err) { toast('불러오기에 실패했습니다: ' + err.message, 'error'); return; }
      toast(mode === 'overwrite' ? '백업으로 기록을 덮어썼습니다.' : '백업과 현재 기록을 합쳤습니다.');
      setTimeout(() => location.reload(), 600);
    };
    modal('백업 파일 불러오기', h('div', null,
      h('p', null, h('b', null, `백업에 든 과목(${Object.keys(obj.subjects).map((k) => SUBJECTS[k].name).join(', ')})의 기록이 변경됩니다.`)),
      h('p', { class: 'muted small' }, `백업 내용: ${summarize(obj)}${obj.exportedAt ? ` (${new Date(obj.exportedAt).toLocaleString('ko-KR')} 저장)` : ''}`),
      h('ul', { class: 'muted small' },
        h('li', null, '덮어쓰기: 현재 기록을 모두 지우고 백업으로 바꿉니다.'),
        h('li', null, '합치기: 현재 기록과 백업을 합칩니다. 같은 항목은 더 최근 것을 남기고 중복은 지웁니다.'))), [
      { label: '취소', onclick: () => {} },
      { label: '덮어쓰기', onclick: () => apply('overwrite') },
      { label: '합치기', primary: true, onclick: () => apply('merge') },
    ]);
  } });
  let exportWhich = 'all';
  const exportSel = select([['all', '모든 과목'], ...SUBJECT_IDS.map((k) => [k, `${SUBJECTS[k].name}만`])], exportWhich, (v) => { exportWhich = v; });
  exportSel.setAttribute('aria-label', '내보낼 과목');
  const legacyBtn = h('span');
  legacySummary().then((sum) => {
    if (sum) legacyBtn.replaceWith(h('button', { class: 'btn', onclick: () => askMigration(fb.auth.currentUser.uid, sum) }, '이 브라우저의 기존 기록을 계정으로 옮기기'));
  });
  const reportBox = h('div');
  const drawReports = () => {
    clear(reportBox);
    const list = S().reports;
    if (!list.length) { reportBox.appendChild(h('p', { class: 'muted' }, '신고한 문제가 없습니다.')); return; }
    reportBox.appendChild(h('div', { class: 'report-list' }, list.map((r) => h('div', { class: 'wrong-item' },
      h('div', { class: 'qmeta' },
        h('span', { class: 'tag ' + (r.status === 'corrected' ? 'label-verified' : r.status === 'cancelled' ? 'soft' : 'label-unverified') }, reportedLabel(r)),
        h('span', { class: 'tag' }, TYPES[r.q?.type] || r.q?.type || ''),
        h('span', { class: 'grow' }),
        h('span', { class: 'muted small' }, fmtDate(r.ts))),
      h('p', { class: 'wrong-stem' }, (r.q?.type === 'passage' ? r.q.data?.modified : r.q?.stem || '').slice(0, 140)),
      h('p', { class: 'small' }, h('b', null, '신고 이유 '), REASONS[r.reason] + (r.detail ? ` — ${r.detail}` : '')),
      r.review?.explanation && h('details', null, h('summary', null, '처리 결과 보기'), h('p', { class: 'small' }, r.review.explanation)),
      ['failed', 'valid', 'reviewing'].includes(r.status) && h('div', { class: 'row' },
        h('button', { class: 'btn small', onclick: () => showReview(r, drawReports) }, r.status === 'valid' ? '신고 취소 / 그래도 제외 선택' : '다시 검토'))))));
  };
  drawReports();

  add(root, 
    pageHead('설정', null),
    h('section', { class: 'card' },
      h('h2', null, 'AI 연결'),
      field('사용할 AI', h('div', { class: 'row wrap' }, providerSeg, testBtn)),
      h('p', { class: 'muted small' }, '입력한 API 키는 로그인한 계정의 비공개 저장 공간(본인만 읽을 수 있음)에 저장되어, 다른 기기에서 로그인해도 자동으로 불러옵니다. 프로그램 코드에는 키가 들어 있지 않습니다. 요청은 브라우저에서 고른 AI 회사로 바로 전송됩니다. 두 키를 모두 넣어 두고 위에서 바꿔 쓸 수 있습니다.'),
      claudeBox,
      geminiBox,
      h('div', { class: 'grid-3' },
        field('속도', select([['fast', '빠르게 (기본)'], ['balanced', '보통'], ['accurate', '정확하게 (느림)']], s.speed || 'fast', (v) => { s.speed = v; save(); }),
          'AI가 생각하는 깊이입니다. 빠르게: 문제가 빨리 나옵니다. 정확하게: 더 오래 걸리지만 어려운 문제·서술형 채점에 유리합니다.'),
        field('AI에 보낼 자료 최대 길이', h('input', { class: 'input', type: 'number', min: 20000, step: 10000, value: s.maxChars, oninput: (e) => { s.maxChars = Math.max(20000, +e.target.value || 400000); save(); } }), '글자 수. 범위가 이보다 길면 뒷부분은 빠집니다.'))),
    h('section', { class: 'card' },
      h('h2', null, '학습 기록'),
      h('p', { class: 'muted' }, `[${subject().name}] 오답 ${S().wrong.length}개 · 질문 기록 ${S().qlog.length}개 · 채점 기록 ${S().attempts.length}개 · 플래시카드 ${S().cards.length}장 · 문제 은행 ${S().bank.length}개. 기록은 로그인한 계정에 자동 저장되어 어느 기기·브라우저에서 로그인해도 이어집니다.`),
      h('p', { class: 'muted small' }, `백업 파일에는 과목별 오답노트·질문 기록·정답률·플래시카드 진도·문제 은행·신고 기록·학습 범위가 들어갑니다. 올린 PDF/PPT 원본은 용량 때문에 넣지 않고 파일 이름만 기록합니다. 파일 이름 예: ${backupFileName()} · 마지막 백업: ${S().lastBackup ? fmtDate(S().lastBackup) : '없음'}`),
      h('div', { class: 'row wrap' },
        exportSel,
        h('button', { class: 'btn', onclick: async (e) => {
          const btn = e.currentTarget;
          btn.disabled = true;
          try { await downloadBackup(exportWhich === 'all' ? null : exportWhich); toast('백업 파일을 내보냈습니다.'); document.getElementById('backup-banner')?.remove(); }
          catch (err) { toast('내보내지 못했습니다: ' + err.message, 'error'); }
          finally { btn.disabled = false; }
        } }, '⬇ 백업 파일 내보내기'),
        h('button', { class: 'btn', onclick: () => fileIn.click() }, '⬆ 백업 파일 불러오기'), fileIn,
        legacyBtn)),
    h('section', { class: 'card' },
      h('h2', null, '계정'),
      h('p', { class: 'muted' }, `로그인한 계정: ${fb?.auth?.currentUser?.email || ''}`),
      h('div', { class: 'row wrap' },
        h('button', { class: 'btn danger', onclick: async () => {
          if (!(await confirmBox(`[${subject().name}] 과목의 오답노트, 질문 기록, 정답률, 플래시카드 진도, 문제 은행, 신고 기록을 모두 삭제할까요? (올린 자료와 API 키, 학습 범위, 다른 과목의 기록은 남습니다)`))) return;
          if (!(await confirmBox('정말 삭제할까요? 모든 기기에서 사라지며 되돌릴 수 없습니다. (필요하면 먼저 백업 파일을 내보내세요)'))) return;
          resetRecords();
          toast(`${subject().name} 학습 기록을 삭제했어요.`);
          setTimeout(() => location.reload(), 1500);
        } }, `${subject().name} 학습 기록 삭제`),
        h('button', { class: 'btn danger', onclick: async () => {
          if (!(await confirmBox('계정을 탈퇴할까요? 이 계정의 모든 학습 기록, 자료 분석 결과, API 키가 삭제됩니다.'))) return;
          if (!(await confirmBox('정말 탈퇴할까요? 되돌릴 수 없습니다. 마지막 확인입니다.'))) return;
          deleteAccount();
        } }, '계정 탈퇴'))),
    h('section', { class: 'card', id: 'reports' },
      h('h2', null, '신고한 문제 목록'),
      h('p', { class: 'muted small' }, '신고 이유와 처리 결과입니다. 신고한 문제는 출제에서 빠지고 오답노트·정답률에서도 제외됩니다.'),
      reportBox),
    h('section', { class: 'card' },
      h('h2', null, '이 프로그램에 대해'),
      h('ul', { class: 'muted' },
        h('li', null, '모든 문제·해설·채점은 [자료·범위]에서 고른 자료만 근거로 하며, 근거가 된 쪽/슬라이드 번호를 표시합니다.'),
        h('li', null, '웹을 쓰는 기능(발화자 맞히기의 [추가], 현실 사례 연결, 이론 렌즈 분석의 [교과서 밖 사례])은 출처 링크와 검증 여부를 함께 표시합니다.'),
        h('li', null, '「⚠ 확인 불가」 출처 표시는 AI가 적은 위치가 자료에 없을 때 나타납니다. 그 내용은 자료와 대조해 보세요.'))));
}
