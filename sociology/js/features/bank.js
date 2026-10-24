// 문제 은행 화면: 유형별·개념별 저장 문제 수와 문제 목록
import { subject } from '../subjects.js';
import { h, add, clear, pageHead, select, fmtDate, pct } from '../ui.js';
import { S, unmasterConcept } from '../store.js';
import { TYPES, DIFF, answerText } from '../questions.js';
import { inScopeCopy } from '../bank.js';

const KIND = { quiz: '퀴즈·시험', passage: '비판적 읽기', concept: '개념 맞히기', quote: '발화자 맞히기' };
if (subject().id === 'ir') Object.assign(KIND, { quiz: '퀴즈·연표·개념 구별', concept: '이론 맞히기' });
const STATUS = { active: '검증됨', learned: '학습 완료', reported: '신고됨', excluded: '제외됨' };
const filt = { type: 'all', status: 'all', q: '', limit: 50 };

export function render(root) {
  const bank = S().bank;
  const inScope = bank.filter((e) => e.status === 'active' && inScopeCopy(e)).length;
  add(root,
    pageHead(`문제 은행 · ${subject().name}`, '이 과목에서 AI가 만들고 자체 검증을 통과한 문제가 모두 저장됩니다. 새 문제를 요청하면 이곳에서 조건에 맞는 문제를 먼저 꺼내 쓰고, 모자란 만큼만 새로 만듭니다.'),
    h('div', { class: 'stat-row' },
      stat(String(bank.length), '저장된 문제'),
      stat(String(bank.filter((e) => e.status === 'active').length), '검증됨(출제 가능)'),
      stat(String(bank.filter((e) => e.status === 'learned').length), '학습 완료'),
      stat(String(bank.filter((e) => e.status === 'reported' || e.status === 'excluded').length), '신고됨·제외됨'),
      stat(String(inScope), '현재 학습 범위에서 사용 가능')));
  root.appendChild(learnedBox());
  if (!bank.length) {
    root.appendChild(h('div', { class: 'notice' }, '아직 저장된 문제가 없습니다. 종합 퀴즈나 시험 모드를 풀면 문제가 쌓입니다.'));
    return;
  }

  const byType = {};
  const byConcept = {};
  for (const e of bank) {
    const t = e.q.type;
    (byType[t] ||= { n: 0, active: 0 }).n++;
    if (e.status === 'active') byType[t].active++;
    for (const c of e.q.concepts || []) (byConcept[c] ||= { n: 0, active: 0 }).n++, e.status === 'active' && byConcept[c].active++;
  }
  const table = (title, rows, label) => h('section', { class: 'card' }, h('h2', null, title),
    h('div', { class: 'table-wrap' }, h('table', { class: 'data-table' },
      h('thead', null, h('tr', null, h('th', null, title.replace('별 문제 수', '')), h('th', { class: 'num' }, '저장'), h('th', { class: 'num' }, '출제 가능'))),
      h('tbody', null, rows.map(([k, v]) => h('tr', null, h('td', null, label(k)), h('td', { class: 'num' }, String(v.n)), h('td', { class: 'num' }, String(v.active))))))));
  root.appendChild(h('div', { class: 'grid-2' },
    table('유형별 문제 수', Object.entries(byType).sort((a, b) => b[1].n - a[1].n), (k) => TYPES[k] || k),
    table('개념별 문제 수', Object.entries(byConcept).sort((a, b) => b[1].n - a[1].n).slice(0, 40), (k) => k)));

  const list = h('div');
  const tools = h('div', { class: 'row wrap' },
    select([['all', '모든 유형'], ...Object.keys(byType).map((t) => [t, TYPES[t] || t])], filt.type, (v) => { filt.type = v; filt.limit = 50; draw(); }),
    select([['all', '모든 상태'], ...Object.entries(STATUS)], filt.status, (v) => { filt.status = v; filt.limit = 50; draw(); }),
    h('input', { class: 'input', type: 'search', placeholder: '문제·개념·학자 검색', value: filt.q, oninput: (e) => { filt.q = e.target.value; filt.limit = 50; draw(); } }));
  root.appendChild(h('section', { class: 'card' }, h('h2', null, '저장된 문제'), tools, list));

  function draw() {
    clear(list);
    const items = [...bank].reverse().filter((e) => {
      if (filt.type !== 'all' && e.q.type !== filt.type) return false;
      if (filt.status !== 'all' && e.status !== filt.status) return false;
      if (filt.q) {
        const hay = [e.q.stem, e.q.data?.modified, ...(e.q.concepts || []), ...(e.q.sociologists || [])].join(' ');
        if (!hay.includes(filt.q)) return false;
      }
      return true;
    });
    if (!items.length) { list.appendChild(h('p', { class: 'muted empty' }, '조건에 맞는 문제가 없습니다.')); return; }
    items.slice(0, filt.limit).forEach((e) => list.appendChild(entry(e)));
    if (items.length > filt.limit) list.appendChild(h('div', { class: 'row center' }, h('button', { class: 'btn', onclick: () => { filt.limit += 50; draw(); } }, `더 보기 (${items.length - filt.limit}개 남음)`)));
  }
  draw();
}

function stat(v, l) {
  return h('div', { class: 'stat' }, h('span', { class: 'stat-v' }, v), h('span', { class: 'stat-l' }, l));
}

function entry(e) {
  const q = e.q;
  const files = (e.files || []).map((f) => `${f.file || f.doc} ${f.page}`).join(', ');
  return h('article', { class: 'wrong-item bank-item' },
    h('div', { class: 'qmeta' },
      h('span', { class: 'tag ' + (e.status === 'active' ? 'label-verified' : 'label-unverified') }, STATUS[e.status] || e.status),
      h('span', { class: 'tag' }, TYPES[q.type] || q.type),
      q.difficulty && h('span', { class: 'tag soft' }, DIFF[q.difficulty]),
      h('span', { class: 'tag soft' }, KIND[e.kind] || e.kind),
      e.correctedFrom && h('span', { class: 'tag ghost' }, '수정본'),
      (q.concepts || []).slice(0, 2).map((c) => h('span', { class: 'tag ghost' }, c))),
    h('p', { class: 'wrong-stem' }, (q.type === 'passage' ? q.data?.modified : q.stem || '').slice(0, 160)),
    h('p', { class: 'muted small' },
      `출제 ${e.asked || 0}회 · 정답 ${e.correct || 0}회${e.asked ? ` (${pct((e.correct || 0) / e.asked)})` : ''} · 마지막 풀이 ${e.lastAt ? fmtDate(e.lastAt) : '없음'}`,
      (q.sociologists || []).length ? ` · 학자: ${q.sociologists.join(', ')}` : '',
      files ? ` · 출처: ${files}` : ''),
    q.type !== 'passage' && h('details', null, h('summary', null, '정답과 해설'),
      h('div', { class: 'kv' }, h('span', null, '정답'), h('pre', null, answerText(q))),
      q.explanation && h('p', { class: 'small' }, q.explanation)));
}

// 학습 완료한 개념: 새 문제와 문제 은행 출제에서 빠진다. ✕로 되돌린다.
function learnedBox() {
  const box = h('div', { class: 'card learned-box' });
  const draw = () => {
    const list = S().mastered || [];
    box.replaceChildren(
      h('h3', null, `✅ 학습 완료한 개념 (${list.length})`),
      list.length
        ? h('div', { class: 'chip-row' }, list.map((m) => h('span', { class: 'chip' }, m.name, ' ',
            h('button', { class: 'icon-btn', 'aria-label': `${m.name} 학습 완료 취소`, title: '다시 출제되게 되돌리기', onclick: () => { unmasterConcept(m.name); draw(); } }, '✕'))))
        : h('p', { class: 'muted small' }, '문제를 푼 뒤 [✅ 학습 완료]를 누르면 그 개념은 앞으로 문제로 나오지 않아요. 여기서 ✕로 되돌릴 수 있어요.'));
  };
  draw();
  return box;
}
