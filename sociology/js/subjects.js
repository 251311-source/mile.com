// 과목 정의. 공통 엔진(퀴즈·검증·문제 은행·오답노트·대시보드·동기화·백업)은 현재 과목의 설정만 읽는다.
// 과목마다 기록은 users/{uid}/subjects/{과목 id}/... 에 따로 저장된다(cloud.js).

const SOC = {
  id: 'soc',
  name: '사회학',
  mark: '社',
  title: '사회학 학습',
  domain: '사회학',
  role: '대학 사회학 학습 프로그램',
  person: '사회학자',
  routes: ['scope', 'quiz', 'passage', 'speaker', 'concept', 'realworld', 'critique', 'map', 'cards', 'exam', 'wrong', 'bank', 'dashboard', 'settings'],
  labels: {},
  quizTypes: ['mc', 'short', 'blank', 'ox', 'select_correct', 'select_incorrect', 'combo', 'matching', 'ordering', 'case', 'table', 'essay'],
  typeSpec: {},
  analysis: '등장하는 사회학 개념·이론 이름과 나오는 쪽 번호들',
  passageItems: '사회학 개념·이론 설명',
  passageSwap: '예: 기계적↔유기적, 계급↔지위, 증가↔감소, 학자 이름 바꾸기',
  focusExample: '예: 베버, 아노미 (비우면 범위 전체)',
};

const IR = {
  id: 'ir',
  name: '국제정치',
  mark: '政',
  title: '국제정치 학습',
  domain: '국제정치',
  role: '고등학교 국제정치 내신 대비 학습 프로그램',
  person: '학자',
  routes: ['scope', 'quiz', 'passage', 'lens', 'concept', 'history', 'confuse', 'wrong', 'bank', 'dashboard', 'settings'],
  labels: { concept: ['🎯', '이론 맞히기'] },
  // 순서 배열은 [역사적 배경 연결]에서 따로 다룬다
  quizTypes: ['mc', 'short', 'blank', 'ox', 'select_correct', 'select_incorrect', 'combo', 'matching', 'case', 'table', 'essay'],
  typeSpec: {
    combo: 'combo(합답형): statements에 ㄱ~ㄹ 4개 진술과 각 진술의 참/거짓(is_true)을 넣는다. 참인 진술은 1~3개. stem은 "옳은 것만을 〈보기〉에서 있는 대로 고른 것은?" 형태로 쓴다. options는 비워 둔다(프로그램이 만든다).',
    matching: 'matching(연결하기): matching에 3~4행의 {sociologist: 학자 이름, theory: 이론·학파, concept: 핵심 개념}을 넣는다. 각 행은 자료에서 서로 연결되는 학자-이론-핵심 개념이다. 행끼리 이론·개념이 겹치지 않게 한다.',
    case: 'case(사례 적용): context에 짧은 국제 상황(국가 간 갈등·협력·동맹·국제기구 활동 등, 3~5문장)을 쓰고, stem은 이를 가장 잘 설명하는 이론/개념을 묻는다. 상황은 자료에 나온 사례이거나 자료의 개념으로 설명이 정해지는 것이어야 한다. 객관식이면 options 5개와 answer_index, 서술형이면 options를 비우고 answer_text에 모범 답안, rubric에 채점 기준을 넣는다. 객관식과 서술형을 섞어 낸다.',
    table: 'table(이론 비교표 채우기): 두 이론/학파를 비교한다. table.col_a, table.col_b에 비교 대상, rows에 3~5개 비교 기준(인간 본성관, 주요 행위자, 국제 체제의 성격, 협력 가능성, 국제제도의 역할 등 자료에서 확인되는 것)과 각 칸 내용(a, b). 3~5칸을 a_blank/b_blank=true로 빈칸 처리한다. 빈칸 내용은 짧은 구로.',
  },
  typeLabels: { combo: '합답형(〈보기〉)', table: '이론 비교표 채우기', case: '사례 적용(국제 상황)' },
  analysis: '등장하는 국제정치 이론·학파(하위 학파 포함)·핵심 개념·역사적 사건과 시기 이름, 그리고 나오는 쪽 번호들',
  passageItems: '국제정치 이론·개념 설명',
  passageSwap: '핵심 국제정치 용어를 우선 바꾼다. 예: 상대적 이득↔절대적 이득, 무정부 상태↔위계, 세력 균형↔패권, 집단 안보↔집단 방위, 하드 파워↔소프트 파워, 학자 이름 바꾸기',
  focusExample: '예: 신현실주의, 안보 딜레마 (비우면 범위 전체)',
};

export const SUBJECTS = { soc: SOC, ir: IR };
export const SUBJECT_IDS = Object.keys(SUBJECTS);
export const DEFAULT_SUBJECT = 'soc';

let cur = SOC;
export const subject = () => cur;
export function setSubject(id) {
  cur = SUBJECTS[id] || SOC;
  document.documentElement.dataset.subject = cur.id;
  return cur;
}

// 기능 이름 (오답노트·대시보드 공통)
const FEATURES = {
  quiz: '종합 퀴즈', passage: '비판적 읽기', speaker: '발화자 맞히기', concept: '개념 맞히기', realworld: '현실 사례',
  critique: '이론 비판', cards: '플래시카드', exam: '시험 모드', similar: '유사 문제',
  lens: '이론 렌즈 분석', history: '역사적 배경 연결', confuse: '헷갈리는 개념',
};
export function featureLabels() {
  const out = {};
  const routes = new Set([...cur.routes, 'similar']);
  for (const [k, v] of Object.entries(FEATURES)) if (routes.has(k)) out[k] = cur.labels[k]?.[1] || v;
  return out;
}
