// 설정: API 키, 모델, 데이터 백업
import { h, add, pageHead, field, select, toast, confirmBox, busy } from '../ui.js';
import { settings, save, exportData, importData, resetRecords, S } from '../store.js';
import { testKey } from '../ai.js';

export function render(root) {
  const s = settings();
  const key = h('input', { class: 'input', type: 'password', value: s.apiKey, placeholder: 'sk-ant-...', autocomplete: 'off', oninput: (e) => { s.apiKey = e.target.value.trim(); save(); } });
  const testBtn = h('button', { class: 'btn', onclick: () => busy(testBtn, async () => { await testKey(); toast('연결되었습니다. ✔'); }) }, '연결 확인');
  const fileIn = h('input', { type: 'file', accept: 'application/json,.json', hidden: true, onchange: async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    try { importData(await f.text()); toast('기록을 불러왔습니다.'); location.reload(); } catch (err) { toast(err.message, 'error'); }
  } });

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
      h('p', { class: 'muted' }, `오답 ${S().wrong.length}개 · 질문 기록 ${S().qlog.length}개 · 채점 기록 ${S().attempts.length}개 · 플래시카드 ${S().cards.length}장. 기록은 이 브라우저에 자동 저장되어 다음에 접속해도 유지됩니다. 다른 기기로 옮기려면 백업 파일을 사용하세요.`),
      h('div', { class: 'row wrap' },
        h('button', { class: 'btn', onclick: () => {
          const blob = new Blob([exportData()], { type: 'application/json' });
          const a = h('a', { href: URL.createObjectURL(blob), download: `사회학학습-백업-${new Date().toISOString().slice(0, 10)}.json` });
          document.body.appendChild(a); a.click(); a.remove();
          setTimeout(() => URL.revokeObjectURL(a.href), 1000);
        } }, '⬇ 백업 파일 저장'),
        h('button', { class: 'btn', onclick: () => fileIn.click() }, '⬆ 백업 불러오기'), fileIn,
        h('button', { class: 'btn danger', onclick: async () => { if (await confirmBox('오답노트, 질문 기록, 정답률, 플래시카드를 모두 지울까요? 되돌릴 수 없습니다.')) { resetRecords(); toast('기록을 초기화했습니다.'); location.reload(); } } }, '기록 초기화'))),
    h('section', { class: 'card' },
      h('h2', null, '이 프로그램에 대해'),
      h('ul', { class: 'muted' },
        h('li', null, '모든 문제·해설·채점은 [자료·범위]에서 고른 자료만 근거로 하며, 근거가 된 쪽/슬라이드 번호를 표시합니다.'),
        h('li', null, '웹을 쓰는 기능(발화자 맞히기의 [추가], 현실 사례 연결)은 출처 링크와 검증 여부를 함께 표시합니다.'),
        h('li', null, '「⚠ 확인 불가」 출처 표시는 AI가 적은 위치가 자료에 없을 때 나타납니다. 그 내용은 자료와 대조해 보세요.'))));
}
