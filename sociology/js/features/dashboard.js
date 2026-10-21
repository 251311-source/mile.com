// 8. 취약점 분석 대시보드
import { h, pageHead, pct } from '../ui.js';
import { TYPES } from '../questions.js';
import { S } from '../store.js';

const FEATURE = { quiz: '종합 퀴즈', passage: '비판적 읽기', speaker: '발화자 맞히기', concept: '개념 맞히기', realworld: '현실 사례', critique: '이론 비판', cards: '플래시카드', exam: '시험 모드', similar: '유사 문제' };
const TYPE_LABEL = { ...TYPES, speaker: '발화자 맞히기', concept: '개념 맞히기', flashcard: '플래시카드', realworld: '현실 사례 분석', critique: '이론 비판' };
const MIN_N = 3;     // 이 정도는 풀어야 판단한다
const WEAK = 0.6;    // 정답률 기준

function group(attempts, keyFn) {
  const m = new Map();
  for (const a of attempts) {
    for (const k of keyFn(a)) {
      if (!k) continue;
      const key = String(k).trim();
      const g = m.get(key) || { key, n: 0, right: 0, score: 0 };
      g.n++; g.right += a.correct ? 1 : 0; g.score += a.score ?? (a.correct ? 1 : 0);
      m.set(key, g);
    }
  }
  return [...m.values()].map((g) => ({ ...g, acc: g.right / g.n }));
}

export function render(root) {
  const at = S().attempts;
  root.appendChild(pageHead('취약점 분석', '모든 기능의 채점 기록으로 개념별·학자별·유형별 정답률을 보여 주고, 약한 부분을 짚어 줍니다.'));
  if (!at.length) {
    root.appendChild(h('div', { class: 'notice' }, '아직 채점 기록이 없습니다. 퀴즈나 시험을 풀면 여기에 분석이 나타납니다.'));
    return;
  }
  const overall = at.filter((a) => a.correct).length / at.length;
  const recent = at.slice(-30);
  const recentAcc = recent.filter((a) => a.correct).length / recent.length;
  const openWrong = S().wrong.filter((w) => !w.mastered).length;
  const due = S().cards.filter((c) => (c.due || 0) <= Date.now()).length;

  const byConcept = group(at, (a) => a.concepts);
  const bySoc = group(at, (a) => a.sociologists);
  const byType = group(at, (a) => [a.type]);
  const byFeature = group(at, (a) => [a.feature]);

  root.appendChild(h('div', { class: 'stat-row' },
    stat(pct(overall), `전체 정답률 (${at.length}문제)`),
    stat(pct(recentAcc), '최근 30문제 정답률'),
    stat(String(openWrong), '복습할 오답'),
    stat(String(due), '복습할 플래시카드')));

  // 약점 문장
  const weak = [
    ...bySoc.map((g) => ({ ...g, what: 'soc' })),
    ...byConcept.map((g) => ({ ...g, what: 'concept' })),
    ...byType.map((g) => ({ ...g, what: 'type' })),
  ].filter((g) => g.n >= MIN_N && g.acc < WEAK).sort((a, b) => a.acc - b.acc).slice(0, 6);

  const sentence = (g) => {
    if (g.what === 'soc') return `${g.key} 관련 문제의 정답률이 낮습니다 (${pct(g.acc)}, ${g.n}문제).`;
    if (g.what === 'concept') return `'${g.key}' 개념을 묻는 문제에서 자주 틀립니다 (${pct(g.acc)}, ${g.n}문제).`;
    return `${TYPE_LABEL[g.key] || g.key} 유형의 정답률이 낮습니다 (${pct(g.acc)}, ${g.n}문제).`;
  };
  const action = (g) => {
    if (g.what === 'type') {
      return QUIZ_TYPE(g.key)
        ? h('a', { class: 'btn small', href: `#/quiz` }, `✏️ ${TYPE_LABEL[g.key]} 연습`)
        : h('a', { class: 'btn small', href: `#/${FEATURE_ROUTE[g.key] || 'quiz'}` }, '연습하러 가기');
    }
    return h('a', { class: 'btn small', href: `#/quiz?focus=${encodeURIComponent(g.key)}` }, `✏️ '${g.key}' 집중 퀴즈`);
  };

  root.appendChild(h('section', { class: 'card insights' },
    h('h2', null, '분석과 추천'),
    weak.length
      ? h('ul', { class: 'insight-list' }, weak.map((g) => h('li', null, h('span', { class: 'status-dot warn', 'aria-hidden': 'true' }, '▲'), h('span', { class: 'grow' }, sentence(g)), action(g))))
      : h('p', null, at.length < 10 ? '기록이 더 쌓이면 약점을 짚어 드릴게요. (항목별 3문제 이상 필요)' : '뚜렷한 약점이 없습니다. 지금처럼 고르게 공부하세요! 👍'),
    weak.length ? h('p', { class: 'muted' }, recommend(weak, openWrong, due)) : null,
    h('div', { class: 'row wrap' },
      openWrong ? h('a', { class: 'btn', href: '#/wrong' }, `📕 오답 ${openWrong}개 다시 풀기`) : null,
      due ? h('a', { class: 'btn', href: '#/cards' }, `🃏 카드 ${due}장 복습`) : null,
      h('a', { class: 'btn', href: '#/exam' }, '⏱️ 실전 시험 보기'))));

  root.appendChild(h('div', { class: 'grid-2' },
    barCard('개념별 정답률', byConcept, (k) => k),
    barCard('사회학자별 정답률', bySoc, (k) => k),
    barCard('문제 유형별 정답률', byType, (k) => TYPE_LABEL[k] || k),
    barCard('기능별 정답률', byFeature, (k) => FEATURE[k] || k)));

  if (S().exams.length) {
    const ex = S().exams.slice(0, 10).reverse();
    root.appendChild(h('section', { class: 'card' }, h('h2', null, '시험 점수 변화'),
      h('div', { class: 'spark-bars', role: 'img', 'aria-label': '최근 시험 점수: ' + ex.map((e) => Math.round(e.score * 100) + '점').join(', ') },
        ex.map((e) => h('div', { class: 'spark', title: `${new Date(e.ts).toLocaleDateString('ko-KR')} · ${Math.round(e.score * 100)}점` },
          h('span', { class: 'spark-v' }, Math.round(e.score * 100)),
          h('i', { style: { height: Math.max(4, e.score * 100) + '%' } }),
          h('span', { class: 'spark-l' }, new Date(e.ts).toLocaleDateString('ko-KR', { month: 'numeric', day: 'numeric' })))))));
  }
}

const QUIZ_TYPE = (t) => Object.keys(TYPES).includes(t) && t !== 'passage';
const FEATURE_ROUTE = { passage: 'passage', speaker: 'speaker', concept: 'concept', flashcard: 'cards', realworld: 'realworld', critique: 'critique' };

function recommend(weak, openWrong, due) {
  const names = weak.filter((g) => g.what !== 'type').slice(0, 2).map((g) => g.key);
  const parts = [];
  if (names.length) parts.push(`${names.join(', ')} 부분을 자료에서 다시 읽고, 집중 퀴즈로 확인해 보세요.`);
  if (openWrong) parts.push('오답노트의 틀린 문제를 다시 풀어 「완전 정복」을 늘려 보세요.');
  if (due) parts.push('복습 시기가 된 플래시카드도 있습니다.');
  return parts.join(' ');
}

function stat(v, l) {
  return h('div', { class: 'stat' }, h('span', { class: 'stat-v' }, v), h('span', { class: 'stat-l' }, l));
}

function barCard(title, groups, label) {
  const rows = groups.sort((a, b) => b.n - a.n).slice(0, 12).sort((a, b) => a.acc - b.acc);
  return h('section', { class: 'card' }, h('h2', null, title),
    rows.length ? h('div', { class: 'bars' }, rows.map((g) => {
      const weak = g.n >= MIN_N && g.acc < WEAK;
      return h('div', { class: 'bar-row', title: `${label(g.key)}: ${g.right}/${g.n} 정답 (${pct(g.acc)})` },
        h('span', { class: 'bar-label' }, label(g.key)),
        h('span', { class: 'bar-track' }, h('i', { style: { width: Math.max(2, g.acc * 100) + '%' } })),
        h('span', { class: 'bar-val' }, `${pct(g.acc)}`, h('span', { class: 'muted' }, ` · ${g.n}`)),
        weak ? h('span', { class: 'tag warn-tag' }, '▲ 약점') : h('span', { class: 'tag-space' }));
    })) : h('p', { class: 'muted' }, '기록 없음'),
    h('p', { class: 'muted small' }, '막대 = 정답률, 숫자 뒤 = 푼 문제 수. 3문제 이상 풀고 60% 미만이면 약점으로 표시합니다.'));
}
