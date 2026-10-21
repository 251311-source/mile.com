// 설정: API 키, 모델, 데이터 백업
import { h, add, pageHead, field, select, toast, confirmBox, busy, modal, fmtDate, clear } from '../ui.js';
import { settings, save, resetRecords, S } from '../store.js';
import { testKey } from '../ai.js';
import { downloadBackup, parseBackup, applyBackup, summarize, backupFileName } from '../backup.js';
import { REASONS, reportedLabel, showReview } from '../report.js';
import { TYPES } from '../questions.js';

export function render(root) {
  const s = settings();
  const key = h('input', { class: 'input', type: 'password', value: s.apiKey, placeholder: 'sk-ant-...', autocomplete: 'off', oninput: (e) => { s.apiKey = e.target.value.trim(); save(); } });
  const testBtn = h('button', { class: 'btn', onclick: () => busy(testBtn, async () => { await testKey(); toast('연결되었습니다. ✔'); }) }, '연결 확인');
  const fileIn = h('input', { type: 'file', accept: 'application/json,.json', hidden: true, onchange: async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    e.target.value = '';
    let obj;
    try { obj = parseBackup(await f.text()); } catch (err) { toast(err.message + ' 기존 기록은 그대로입니다.', 'error'); return; }
    const apply = (mode) => {
      try { applyBackup(obj, mode); } catch (err) { toast('불러오기에 실패했습니다: ' + err.message, 'error'); return; }
      toast(mode === 'overwrite' ? '백업으로 기록을 덮어썼습니다.' : '백업과 현재 기록을 합쳤습니다.');
      setTimeout(() => location.reload(), 600);
    };
    modal('백업 파일 불러오기', h('div', null,
      h('p', null, h('b', null, '현재 기록이 변경됩니다.')),
      h('p', { class: 'muted small' }, `백업 내용: ${summarize(obj)}${obj.exportedAt ? ` (${new Date(obj.exportedAt).toLocaleString('ko-KR')} 저장)` : ''}`),
      h('ul', { class: 'muted small' },
        h('li', null, '덮어쓰기: 현재 기록을 모두 지우고 백업으로 바꿉니다.'),
        h('li', null, '합치기: 현재 기록과 백업을 합칩니다. 같은 항목은 더 최근 것을 남기고 중복은 지웁니다.'))), [
      { label: '취소', onclick: () => {} },
      { label: '덮어쓰기', onclick: () => apply('overwrite') },
      { label: '합치기', primary: true, onclick: () => apply('merge') },
    ]);
  } });
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
      field('Anthropic API 키', h('div', { class: 'row' }, key, testBtn),
        '키는 이 브라우저(localStorage)에만 저장되고, 요청은 브라우저에서 Anthropic API로 바로 전송됩니다. 공용 컴퓨터에서는 사용 후 지워 주세요. 키 발급: console.anthropic.com'),
      h('div', { class: 'grid-3' },
        field('모델', select([['claude-opus-5-5', 'Claude Opus 5.5 (기본·가장 정확)'], ['claude-sonnet-5-5', 'Claude Sonnet 5.5 (빠르고 저렴)'], ['claude-haiku-5-5', 'Claude Haiku 5.5 (가장 저렴)']], s.model, (v) => { s.model = v; save(); })),
        field('사고 깊이(effort)', select([['low', '낮음 (빠름)'], ['medium', '보통'], ['high', '높음 (정확, 느림)']], s.effort, (v) => { s.effort = v; save(); })),
        field('AI에 보낼 자료 최대 길이', h('input', { class: 'input', type: 'number', min: 20000, step: 10000, value: s.maxChars, oninput: (e) => { s.maxChars = Math.max(20000, +e.target.value || 400000); save(); } }), '글자 수. 범위가 이보다 길면 뒷부분은 빠집니다.'))),
    h('section', { class: 'card' },
      h('h2', null, '학습 기록'),
      h('p', { class: 'muted' }, `오답 ${S().wrong.length}개 · 질문 기록 ${S().qlog.length}개 · 채점 기록 ${S().attempts.length}개 · 플래시카드 ${S().cards.length}장 · 문제 은행 ${S().bank.length}개. 기록은 이 브라우저에 자동 저장되어 다음에 접속해도 유지됩니다.`),
      h('p', { class: 'muted small' }, `백업 파일에는 오답노트·질문 기록·정답률·플래시카드 진도·문제 은행·신고 기록·학습 범위가 들어갑니다. 올린 PDF/PPT 원본은 용량 때문에 넣지 않고 파일 이름만 기록합니다. 파일 이름 예: ${backupFileName()} · 마지막 백업: ${S().lastBackup ? fmtDate(S().lastBackup) : '없음'}`),
      h('div', { class: 'row wrap' },
        h('button', { class: 'btn', onclick: () => { downloadBackup(); toast('백업 파일을 내보냈습니다.'); document.getElementById('backup-banner')?.remove(); } }, '⬇ 백업 파일 내보내기'),
        h('button', { class: 'btn', onclick: () => fileIn.click() }, '⬆ 백업 파일 불러오기'), fileIn,
        h('button', { class: 'btn danger', onclick: async () => { if (await confirmBox('오답노트, 질문 기록, 정답률, 플래시카드를 모두 지울까요? 되돌릴 수 없습니다.')) { resetRecords(); toast('기록을 초기화했습니다.'); location.reload(); } } }, '기록 초기화'))),
    h('section', { class: 'card', id: 'reports' },
      h('h2', null, '신고한 문제 목록'),
      h('p', { class: 'muted small' }, '신고 이유와 처리 결과입니다. 신고한 문제는 출제에서 빠지고 오답노트·정답률에서도 제외됩니다.'),
      reportBox),
    h('section', { class: 'card' },
      h('h2', null, '이 프로그램에 대해'),
      h('ul', { class: 'muted' },
        h('li', null, '모든 문제·해설·채점은 [자료·범위]에서 고른 자료만 근거로 하며, 근거가 된 쪽/슬라이드 번호를 표시합니다.'),
        h('li', null, '웹을 쓰는 기능(발화자 맞히기의 [추가], 현실 사례 연결)은 출처 링크와 검증 여부를 함께 표시합니다.'),
        h('li', null, '「⚠ 확인 불가」 출처 표시는 AI가 적은 위치가 자료에 없을 때 나타납니다. 그 내용은 자료와 대조해 보세요.'))));
}
