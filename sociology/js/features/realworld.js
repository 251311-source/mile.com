// 9. 현실 사례 연결
import { h, add, pageHead, loadingBox, errorBox, sourceChips, setCurrent, toast, field } from '../ui.js';
import { askJSON, T, SOURCES, seenInSearch } from '../ai.js';
import { S, uid, pushRecent, recordAttempt, addWrong } from '../store.js';
import { openChatAbout } from '../panels.js';

const CASE = T.obj({
  title: T.str, summary: T.str, url: T.str, publisher: T.str, published: T.str,
  prompt: T.str, theories: T.arr(T.str), concepts: T.arr(T.str), sociologists: T.arr(T.str),
});
const FEEDBACK = T.obj({
  score: T.num, appropriate: T.bool, application: T.str,
  strengths: T.arr(T.str), missed: T.arr(T.obj({ perspective: T.str, why: T.str, sources: SOURCES })),
  improve: T.str, sources: SOURCES,
});

export function render(root) {
  const area = h('div');
  const topic = h('input', { class: 'input', type: 'text', placeholder: '예: 청년 고용, 저출생, 플랫폼 노동 (비우면 자동)' });
  const go = h('button', { class: 'btn primary', onclick: () => run() }, '사례 찾기');
  add(root, 
    pageHead('현실 사례 연결', '최근 뉴스나 사회 현상을 웹에서 찾아 출처와 함께 보여 줍니다. 학습 범위의 이론으로 분석해 보세요.'),
    h('div', { class: 'card settings-card' }, h('div', { class: 'row wrap' }, field('관심 분야 (선택)', topic), h('div', { class: 'row end grow' }, go))),
    area);

  async function run() {
    go.disabled = true;
    area.replaceChildren(loadingBox('최근 사례를 검색하고 있습니다…'));
    try {
      const c = await findCase(topic.value.trim());
      area.replaceChildren(caseView(c, run));
    } catch (e) {
      area.replaceChildren(errorBox(e, run));
    } finally {
      go.disabled = false;
    }
  }
}

async function findCase(topic) {
  const recent = S().recent.realworld || [];
  const task = [
    '웹 검색으로 최근(가능하면 최근 1~2년) 뉴스 기사나 사회 현상 하나를 찾아, 학습 범위 자료의 이론으로 분석하는 과제를 만들어라.',
    '- 먼저 학습 범위 자료에 나오는 이론·개념을 확인하고, 그것으로 분석할 수 있는 사례를 고른다. 한국 사례를 우선하되 국제 사례도 괜찮다.',
    topic && `- 관심 분야: ${topic}`,
    recent.length && `- 다음 사례와는 다른 것을 고른다: ${recent.join(' / ')}`,
    '- title: 기사/사례 제목, summary: 사례 내용을 자신의 말로 4~6문장 요약(기사 문장을 길게 옮기지 않는다), url: 실제로 확인한 기사 URL, publisher: 언론사/기관, published: 게시일(YYYY-MM-DD, 모르면 빈 문자열).',
    '- prompt: 학습자에게 줄 분석 과제(어느 이론으로 분석하라고 지정하지 말고 "학습한 이론으로" 분석하라고 한다).',
    '- theories: 이 사례에 적용할 만한 학습 범위의 이론들(채점용, 학습자에게는 숨김). concepts, sociologists: 관련 개념·학자.',
    '- 최종 답은 아래 스키마의 JSON 객체 하나로만 출력한다.',
  ].filter(Boolean).join('\n');
  const { data, searchResults } = await askJSON({ task, schema: CASE, web: true });
  if (!data.title || !data.summary) throw new Error('사례를 찾지 못했습니다. 다시 시도해 주세요.');
  const verified = /^https?:\/\//.test(data.url) && seenInSearch(data.url, searchResults);
  pushRecent('realworld', data.title.slice(0, 40), 10);
  return { ...data, id: uid(), verified, results: searchResults.slice(0, 5) };
}

function caseView(c, again) {
  const ta = h('textarea', { class: 'input', rows: 9, placeholder: '어떤 이론/개념으로 이 사례를 설명할 수 있는지, 근거와 함께 써 보세요.' });
  const submit = h('button', { class: 'btn primary', onclick: () => send() }, '피드백 받기');
  const result = h('div', { 'aria-live': 'polite' });
  const ctx = { kind: 'realworld', label: '현실 사례 분석', text: `[현실 사례] ${c.title}\n${c.summary}\n과제: ${c.prompt}` };
  setCurrent(ctx);

  async function send() {
    const answer = ta.value.trim();
    if (answer.length < 20) return toast('분석을 조금 더 자세히 써 주세요.', 'warn');
    submit.disabled = true;
    result.replaceChildren(loadingBox('분석을 검토하고 있습니다…'));
    try {
      const { data: f } = await askJSON({ schema: FEEDBACK, task: [
        '학습자가 현실 사례를 학습 범위의 이론으로 분석했다. 피드백하라.',
        '- score: 0~100. appropriate: 이론 적용이 대체로 적절한지.',
        '- application: 이론을 사례에 적절히 적용했는지에 대한 구체적 평가(3~5문장). 개념을 잘못 이해한 부분이 있으면 자료에 근거해 바로잡는다.',
        '- strengths: 잘한 점. missed: 놓친 관점(학습 범위의 이론/개념 중심, 각각 why와 sources). improve: 더 나은 분석을 위한 조언.',
        '- 평가의 근거는 학습 자료다. sources에 근거 위치를 적는다.',
        JSON.stringify({ case: { title: c.title, summary: c.summary, prompt: c.prompt }, candidate_theories: c.theories, answer }),
      ].join('\n') });
      const score = Math.max(0, Math.min(100, Number(f.score) || 0));
      const ok = score >= 60;
      recordAttempt({ feature: 'realworld', type: 'realworld', concepts: c.theories.concat(c.concepts || []).slice(0, 5), sociologists: c.sociologists, correct: ok, score: score / 100 });
      if (!ok) addWrong({ feature: 'realworld', userAnswer: answer, feedback: f.application, q: {
        id: c.id, type: 'case', stem: c.prompt, context: `${c.summary}\n(출처: ${c.publisher} ${c.published} ${c.url})`, options: [],
        answer_text: `적용할 만한 이론: ${c.theories.join(', ')}`, model_answer: `적용할 만한 이론: ${c.theories.join(', ')}. ${f.improve}`,
        rubric: [{ criterion: '적절한 이론 선택', points: 4, key_elements: c.theories }, { criterion: '사례와 개념의 연결', points: 4, key_elements: [] }, { criterion: '다른 관점 고려', points: 2, key_elements: (f.missed || []).map((m) => m.perspective) }],
        explanation: f.application, sources: f.sources, concepts: c.theories, sociologists: c.sociologists, accept: [],
      } });
      ctx.text += `\n학습자 분석: ${answer}\n피드백: ${f.application}`;
      ta.readOnly = true;
      submit.remove();
      result.replaceChildren(h('div', { class: 'result ' + (ok ? 'right' : 'wrong') },
        h('div', { class: 'result-head' }, h('strong', null, f.appropriate ? '✔ 이론 적용이 적절합니다' : '◐ 적용을 다듬어 볼까요'), h('span', { class: 'score' }, `${score}점`), !ok && h('span', { class: 'muted small' }, '오답노트에 저장됨')),
        h('div', { class: 'feedback' }, h('b', null, '이론 적용 평가 '), f.application),
        f.strengths?.length ? h('div', { class: 'feedback' }, h('b', null, '잘한 점'), h('ul', null, f.strengths.map((s) => h('li', null, s)))) : null,
        f.missed?.length ? h('div', { class: 'feedback' }, h('b', null, '놓친 관점'), h('ul', null, f.missed.map((m) => h('li', null, h('b', null, m.perspective), ' — ', m.why, ' ', sourceChips(m.sources))))) : null,
        f.improve && h('div', { class: 'feedback' }, h('b', null, '개선 방법 '), f.improve),
        sourceChips(f.sources, { label: '자료 근거' }),
        h('div', { class: 'row' }, h('button', { class: 'btn ghost', onclick: () => openChatAbout(ctx, '이 사례 분석에 대해 ') }, '💬 AI에게 질문'), h('button', { class: 'btn primary', onclick: again }, '다른 사례'))));
    } catch (e) {
      result.replaceChildren(errorBox(e));
      submit.disabled = false;
    }
  }

  return h('div', null,
    h('article', { class: 'card news' },
      h('div', { class: 'qmeta' }, h('span', { class: 'tag' }, '현실 사례'), h('span', { class: 'tag ' + (c.verified ? 'label-verified' : 'label-unverified') }, c.verified ? '웹 출처(검색 결과로 확인)' : '웹 출처(확인 안 됨)')),
      h('h2', null, c.title),
      h('p', { class: 'reading' }, c.summary),
      h('p', { class: 'cite' }, '출처: ', [c.publisher, c.published].filter(Boolean).join(', '), ' ',
        /^https?:\/\//.test(c.url) ? h('a', { href: c.url, target: '_blank', rel: 'noopener noreferrer' }, c.url) : '(링크 없음)'),
      h('p', { class: 'muted small' }, '사례 요약은 AI가 기사 내용을 정리한 것입니다. 원문 기사를 함께 확인하세요.')),
    h('div', { class: 'card' }, h('p', { class: 'qstem' }, c.prompt), ta, h('div', { class: 'row end' }, submit)),
    result);
}
