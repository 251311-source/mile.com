// 자체 검증: AI가 만든 문제를 사용자에게 보여 주기 전에 별도의 호출로 다시 확인한다.
import { askJSON, T } from './ai.js';
import { isCancel } from './jobs.js';

const SCHEMA = T.obj({
  results: T.arr(T.obj({
    index: T.int,
    pass: T.bool,
    answer_matches_source: T.bool,
    single_answer: T.bool,
    unambiguous: T.bool,
    explanation_consistent: T.bool,
    problems: T.arr(T.str),
  })),
});

const CHECKS = {
  quiz: [
    '1) 정답이 sources에 적힌 쪽(슬라이드)의 자료 내용과 실제로 일치하는가? (answer_matches_source)',
    '2) 객관식·<보기> 문제에서 정답이 정확히 하나이고, 정답처럼 볼 수 있는 다른 선지가 없는가? 연결하기·순서 배열·빈칸·비교표는 정답이 자료로 하나로 정해지는가? (single_answer)',
    '3) O/X, 옳은 것/옳지 않은 것 고르기 문제에 해석에 따라 참·거짓이 갈리는 애매한 표현이 없는가? 다른 유형도 문제 문장이 명확한가? (unambiguous)',
    '4) 해설이 정답과 모순되지 않는가? (explanation_consistent)',
  ],
  passage: [
    '1) original이 자료의 문장과 같은 내용인가? (answer_matches_source)',
    '2) changes의 각 wrong이 문맥상 실제로 틀린 의미가 되었는가(우연히 맞는 말이 되지 않았는가)? 각 correct가 original의 원래 단어와 정확히 같은가? changes 외에 modified와 original이 다른 곳이 없는가? (single_answer)',
    '3) 바뀐 단어가 자연스러워서 내용을 알아야 찾을 수 있는가? (unambiguous)',
    '4) reason 설명이 변경 내용과 모순되지 않는가? (explanation_consistent)',
  ],
  concept: [
    '1) answer와 clues가 sources에 적힌 쪽의 자료 내용과 일치하는가? (answer_matches_source)',
    '2) 단서들을 모두 보면 정답이 하나로 정해지고, 학습 범위의 다른 개념에도 똑같이 들어맞지는 않는가? (single_answer)',
    '3) 단서에 정답 이름이 드러나지 않고 표현이 명확한가? (unambiguous)',
    '4) explanation이 answer와 모순되지 않는가? (explanation_consistent)',
  ],
  lens: [
    '1) in_material이 true인 사건은 sources에 적힌 쪽에 실제로 나오는가? in_material이 false인 사건은 실제로 있었던 잘 알려진 국제 사건으로 서술이 사실과 맞는가? (answer_matches_source)',
    '2) theories의 각 이론이 학습 범위 자료에 나오고, core가 sources에 적힌 쪽의 내용과 맞는가? (single_answer)',
    '3) situation이 특정 이론의 결론을 미리 말하지 않고 중립적으로 서술되었는가? (unambiguous)',
    '4) 이 사건을 theories의 이론들로 의미 있게 해석할 수 있는가? (explanation_consistent)',
  ],
  history: [
    '1) 항목(사건·시기·이론·논쟁)이 sources에 적힌 쪽의 자료에 실제로 나오는가? (answer_matches_source)',
    '2) 사건/시기와 이론의 연결(link)이 자료에서 확인되는가(그 시기에 등장했거나 영향력이 커졌다고 자료가 말하는가)? year가 있으면 실제 연도와 맞는가? (single_answer)',
    '3) why와 description이 명확하고 다른 해석의 여지가 적은가? (unambiguous)',
    '4) why·description이 자료 내용과 모순되지 않는가? (explanation_consistent)',
  ],
  confuse: [
    '1) 각 개념의 definition·example이 sources에 적힌 쪽의 자료 내용과 맞는가? (answer_matches_source)',
    '2) 묶인 개념들이 실제로 서로 다른 개념이고, key_difference가 둘을 정확히 구분하는가? (single_answer)',
    '3) 정의와 차이 설명이 명확한가? (unambiguous)',
    '4) related_theories와 example이 정의와 모순되지 않는가? (explanation_consistent)',
  ],
  quote: [
    '1) 인용(또는 주장)이 sources에 적힌 쪽에 실제로 그 학자의 말/주장으로 나오는가? (answer_matches_source)',
    '2) 이 말을 한 사람이 speaker 한 명으로 정해지는가? (single_answer)',
    '3) 인용 문장에 정답 학자의 이름이 드러나지 않는가? (unambiguous)',
    '4) topic이 인용 내용과 맞는가? (explanation_consistent)',
  ],
};

// items: 검증할 객체 배열 → 같은 순서의 [{pass, problems}]
export async function verifyItems(kind, items, { signal } = {}) {
  if (!items.length) return [];
  const task = [
    '너는 출제 검토위원이다. 아래 문항들을 학습 자료와 대조해 하나씩 검증하라. 출제자를 믿지 말고 자료를 직접 확인한다.',
    '검증 항목:',
    ...CHECKS[kind],
    '네 항목 중 하나라도 false이면 pass는 false다. 문제가 있으면 problems에 구체적으로(한 문장씩) 적는다. index는 0부터.',
    JSON.stringify(items.map((it, index) => ({ index, ...strip(it) }))),
  ].join('\n');
  const { data } = await askJSON({ task, schema: SCHEMA, effort: 'low', signal });
  const byIndex = new Map((data.results || []).map((r) => [r.index, r]));
  return items.map((_, i) => {
    const r = byIndex.get(i);
    if (!r) return { pass: false, problems: ['검증 결과 없음'] };
    const pass = !!(r.pass && r.answer_matches_source && r.single_answer && r.unambiguous && r.explanation_consistent);
    return { pass, problems: r.problems || [] };
  });
}

// 검증에 필요 없는 내부 필드는 빼고 보낸다.
function strip(it) {
  const { id, difficulty, ...rest } = it;
  for (const k of Object.keys(rest)) {
    const v = rest[k];
    if (v === '' || v === -1 || (Array.isArray(v) && !v.length)) delete rest[k];
  }
  if (rest.table && !rest.table.rows?.length) delete rest.table;
  return rest;
}

// 생성 → 검증 → 실패한 칸만 한 번 더 생성 → 그래도 실패하면 건너뛴다.
// gen(n, round) 은 n개의 후보를, check(items) 는 [{pass, problems}] 를 돌려준다.
export async function generateVerified(n, gen, check) {
  const passed = [];
  let need = n;
  for (let round = 0; round < 2 && need > 0; round++) {
    let cands;
    try {
      cands = (await gen(need, round)) || [];
    } catch (e) {
      if (round === 0 || isCancel(e)) throw e;
      break;
    }
    const verdicts = cands.length ? await check(cands) : [];
    const ok = cands.filter((_, i) => verdicts[i]?.pass);
    passed.push(...ok);
    need = n - passed.length;
  }
  return { items: passed.slice(0, n), skipped: Math.max(0, n - passed.length) };
}
