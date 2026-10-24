// 4. 개념 맞히기 (단계별 힌트, 혼동 모드)
import { h, add, pageHead, loadingBox, errorBox, sourceChips, setCurrent, field, select, toast } from '../ui.js';
import { askJSON, T, SOURCES } from '../ai.js';
import { S, uid, recordAttempt, addWrong, masteredNames, pushRecent } from '../store.js';
import { openChatAbout } from '../panels.js';
import { persistentArea, runJob, jobControls, isCancel } from '../jobs.js';
import { segBtn } from './quiz.js';
import { verifyItems, generateVerified } from '../verify.js';
import { saveToBank, pageUse } from '../bank.js';
import { reportButton } from '../report.js';
import { learnedButton } from '../questions.js';
import { pickRegions, regionLine } from '../docs.js';
import { subject } from '../subjects.js';

const ITEM = T.obj({ answer: T.str, aliases: T.arr(T.str), category: T.str, sociologist: T.str, clues: T.arr(T.str), explanation: T.str, sources: SOURCES });
const NORMAL = T.obj({ items: T.arr(ITEM) });
const PAIRS = T.obj({ pairs: T.arr(T.obj({ a: ITEM, b: ITEM, distinction: T.str, sources: SOURCES })) });
const JUDGE = T.obj({ results: T.arr(T.obj({ key: T.str, correct: T.bool, comment: T.str })) });

const opts = { mode: 'normal', count: 5 };
// 이미 낸 개념(계정에 저장되어 새로 고쳐도 유지) + 문제 은행에 있는 개념 맞히기 정답 → 다시 내지 않는다
const usedList = () => {
  const fromBank = S().bank.filter((e) => e.kind === 'concept' && e.status !== 'excluded').map((e) => e.q?.answer_text).filter(Boolean);
  return [...new Set([...(S().recent.concept || []), ...fromBank])].slice(-80);
};
const remember = (names) => names.forEach((n) => pushRecent('concept', n, 120));

export function render(root) {
  const area = persistentArea('concept'); // 화면을 떠나도 생성·풀이가 유지된다
  const go = jobControls('concept', { start: () => run(), label: '시작', running: '생성 중… 다른 화면에 다녀와도 계속 만들어요.' });
  const ir = subject().id === 'ir';
  if (ir) opts.mode = 'normal'; // 국제정치의 헷갈리는 개념은 [헷갈리는 개념] 메뉴에서 다룬다
  add(root, 
    ir ? pageHead('이론 맞히기', '이론·학파의 특징(핵심 가정, 대표 학자, 핵심 개념, 협력에 대한 관점, 역사적 배경)을 하나씩 공개합니다. 적은 힌트로 맞힐수록 점수가 높습니다.')
      : pageHead('개념 맞히기', '이론·개념의 특징을 하나씩 공개합니다. 적은 힌트로 맞힐수록 점수가 높습니다. 혼동 모드는 헷갈리기 쉬운 짝을 나란히 보여 줍니다.'),
    h('div', { class: 'card settings-card' }, h('div', { class: 'grid-3' },
      !ir && field('모드', h('div', { class: 'seg' }, segBtn('normal', '일반', () => opts.mode, (v) => { opts.mode = v; }), segBtn('confusion', '혼동 모드', () => opts.mode, (v) => { opts.mode = v; }))),
      field(ir ? '문항 수' : '문항 수(혼동 모드는 쌍의 수)', select([[3, '3'], [5, '5'], [8, '8']], opts.count, (v) => { opts.count = +v; })),
      h('div', { class: 'row end' }, go))),
    area);

  function run() {
    runJob('concept', { label: ir ? '이론 맞히기 문제' : '개념 맞히기 문제', page: 'concept' }, async (signal) => {
    area.replaceChildren(loadingBox('특징 카드를 만들고 있습니다…'));
    try {
      let skipped = 0;
      if (opts.mode === 'normal') {
        // 생성 → 자체 검증 → 실패분만 다시 생성 → 또 실패하면 건너뜀
        const r = await generateVerified(opts.count, async (n) => {
          const { data } = await askJSON({ signal, schema: NORMAL, task: (ir ? [
            `학습 범위에서 국제정치 이론 또는 학파 ${n}개를 골라 "특징만 보고 맞히기" 문제를 만들어라. 자료에 하위 학파(예: 고전적 현실주의, 신현실주의, 방어적/공격적 현실주의, 신자유제도주의, 구성주의 등)가 나오면 그 수준까지 구분해 낸다. 자료에 없는 이론·학파는 내지 않는다.`,
            '- answer: 자료에 쓰인 이름. aliases: 같은 것을 가리키는 다른 표기(원어 포함).',
            '- clues: 특징 5개를 막연한 것부터 구체적인 것 순서로. 핵심 가정, 핵심 개념, 협력·국제제도에 대한 관점, 등장한 역사적 배경, 대표 학자를 고루 쓰되 대표 학자 이름은 마지막 단서에만 쓴다. 단서 안에 answer나 aliases를 쓰지 않는다. 모두 자료에 근거한다.',
            '- category: "이론" 또는 "학파". sociologist: 대표 학자(없으면 빈 문자열). explanation: 2~3문장 설명. sources: 자료 위치.',
          ] : [
            `학습 범위에서 이론 또는 개념 ${n}개를 골라 "특징만 보고 맞히기" 문제를 만들어라.`,
            '- answer: 자료에 쓰인 이름. aliases: 같은 것을 가리키는 다른 표기(원어 포함).',
            '- clues: 특징 5개를 막연한 것부터 구체적인 것 순서로. 단서 안에 answer나 aliases를 쓰지 않는다. 모두 자료에 근거한다.',
            '- category: "이론" 또는 "개념". sociologist: 관련 학자(없으면 빈 문자열). explanation: 2~3문장 설명. sources: 자료 위치.',
          ]).concat([
            usedList().length && `- 다음은 이미 나왔으니 제외(범위에 다른 것이 남아 있으면 반드시 다른 것을 고른다): ${usedList().join(', ')}`,
            regionLine(pickRegions(1, pageUse('concept'))[0]),
            masteredNames().length && `- 학습자가 학습 완료한 것이니 제외: ${masteredNames().slice(-60).join(', ')}`,
          ]).filter(Boolean).join('\n') });
          const items = (data.items || []).map(clean).filter(Boolean);
          remember(items.map((x) => x.answer));
          return items;
        }, (items) => verifyItems('concept', items.map(forCheck), { signal }));
        if (!r.items.length) throw new Error('검증을 통과한 문제를 만들지 못했습니다. 다시 시도해 주세요.');
        skipped = r.skipped;
        r.items.forEach((x) => saveToBank(conceptQ(x), { feature: 'concept', kind: 'concept' }));
        sequence(area, r.items.map((x) => ({ kind: 'single', item: x })));
      } else {
        const r = await generateVerified(opts.count, async (n) => {
          const { data } = await askJSON({ signal, schema: PAIRS, task: [
            `학습 범위에서 서로 헷갈리기 쉬운 이론/개념 짝 ${n}쌍을 골라라(예: 계급과 지위집단, 기계적 연대와 유기적 연대처럼 자료에 함께 나오는 것).`,
            '- 각 a, b에 대해 answer, aliases, category, sociologist, clues(특징 5개, 막연한→구체적, 정답 이름 금지), explanation, sources.',
            '- 두 항목의 같은 순번 단서는 같은 관점(예: 1번은 사회 유형, 2번은 결속 근거)을 다뤄 비교가 되게 한다.',
            '- distinction: 둘을 구분하는 핵심 차이 2~3문장. sources: 근거 위치.',
            '- 학습 범위에 짝이 될 만한 것이 부족하면 있는 만큼만 만든다.',
            usedList().length && `- 다음 개념이 든 짝은 이미 나왔으니 제외: ${usedList().join(', ')}`,
          ].filter(Boolean).join('\n') });
          const pairs = (data.pairs || []).map((p) => ({ a: clean(p.a), b: clean(p.b), distinction: p.distinction, sources: p.sources })).filter((p) => p.a && p.b);
          remember(pairs.flatMap((p) => [p.a.answer, p.b.answer]));
          return pairs;
        }, async (pairs) => {
          const v = await verifyItems('concept', pairs.flatMap((p) => [forCheck(p.a), forCheck(p.b)]), { signal });
          return pairs.map((_, i) => ({ pass: v[2 * i].pass && v[2 * i + 1].pass }));
        });
        if (!r.items.length) throw new Error('학습 범위에서 검증을 통과한 혼동 쌍을 찾지 못했습니다. 범위를 넓혀 보세요.');
        skipped = r.skipped;
        r.items.forEach((p) => { saveToBank(conceptQ(p.a), { feature: 'concept', kind: 'concept' }); saveToBank(conceptQ(p.b), { feature: 'concept', kind: 'concept' }); });
        sequence(area, r.items.map((p) => ({ kind: 'pair', pair: p })));
      }
      if (skipped) area.prepend(h('div', { class: 'notice' }, `검증을 두 번 통과하지 못한 ${skipped}개는 건너뛰었습니다.`));
    } catch (e) {
      area.replaceChildren(isCancel(e) ? h('div', { class: 'notice' }, '생성을 취소했어요.') : errorBox(e, run));
      throw e;
    }
    });
  }
}

const forCheck = (x) => ({ answer: x.answer, aliases: x.aliases, clues: x.clues, explanation: x.explanation, sources: x.sources });
function conceptQ(item) {
  return {
    id: item.id, type: 'short', stem: '다음 특징이 설명하는 ' + (item.category || '개념') + '은(는)?\n' + item.clues.map((c) => '· ' + c).join('\n'),
    answer_text: item.answer, accept: item.aliases, explanation: item.explanation, sources: item.sources, concepts: [item.answer], sociologists: [item.sociologist].filter(Boolean), options: [], context: '', verified: true,
  };
}

function clean(x) {
  if (!x || !x.answer || !Array.isArray(x.clues) || x.clues.length < 2) return null;
  const names = [x.answer, ...(x.aliases || [])].filter((s) => s && s.length > 1);
  const mask = (s) => names.reduce((acc, n) => acc.split(n).join('○○'), String(s));
  return { ...x, id: uid(), aliases: x.aliases || [], clues: x.clues.slice(0, 6).map(mask) };
}

function sequence(area, list) {
  let i = 0, total = 0, max = 0;
  const next = () => {
    if (i >= list.length) {
      area.replaceChildren(h('div', { class: 'card center' }, h('h2', null, `총점 ${total} / ${max}`), h('p', { class: 'muted' }, '힌트를 적게 볼수록 점수가 높습니다.')));
      return;
    }
    const cur = list[i++];
    const bar = h('div', { class: 'score-bar' }, `${i}/${list.length} · 누적 ${total}점`);
    const onScore = (pts, mx) => { total += pts; max += mx; bar.textContent = `${i}/${list.length} · 누적 ${total}점`; };
    area.replaceChildren(bar, cur.kind === 'single' ? singleCard(cur.item, onScore, next) : pairCard(cur.pair, onScore, next));
  };
  next();
}

const nrm = (s) => String(s || '').toLowerCase().replace(/[\s.,·()\-'"]/g, '');
function localMatch(user, item) {
  const u = nrm(user);
  return !!u && [item.answer, ...item.aliases].some((a) => nrm(a) === u || nrm(String(a).replace(/\(.*?\)/g, '')) === u);
}
async function judgeAll(entries) {
  // entries: [{key, user, item}]
  const out = {};
  const pending = [];
  for (const e of entries) {
    if (!e.user) out[e.key] = { correct: false, comment: '' };
    else if (localMatch(e.user, e.item)) out[e.key] = { correct: true, comment: '' };
    else pending.push(e);
  }
  if (pending.length) {
    const { data } = await askJSON({ material: false, effort: 'low', schema: JUDGE, task:
      '사용자의 답이 정답 개념/이론과 같은 것을 가리키는지 의미로 판단하라(표기·띄어쓰기·원어 차이는 인정, 다른 개념이면 오답). comment는 한 문장.\n' +
      JSON.stringify(pending.map((e) => ({ key: e.key, answer: e.item.answer, aliases: e.item.aliases, user: e.user }))) });
    for (const r of data.results || []) out[r.key] = r;
    for (const e of pending) out[e.key] ||= { correct: false, comment: '' };
  }
  return out;
}

function points(item, shown, ok) { return ok ? Math.round((100 * (item.clues.length - shown + 1)) / item.clues.length) : 0; }

function record(item, ok, pts, user) {
  recordAttempt({ qid: item.id, feature: 'concept', type: 'concept', concepts: [item.answer], sociologists: [item.sociologist], correct: ok, score: pts / 100 });
  if (!ok) addWrong({ feature: 'concept', userAnswer: user, q: conceptQ(item) });
}

function clueList(item, shown) {
  return h('ol', { class: 'clues' }, item.clues.map((c, k) => h('li', { class: k < shown ? 'shown' : 'hidden' }, k < shown ? c : '???')));
}

function singleCard(item, onScore, next) {
  let shown = 1, done = false;
  const ctx = { kind: 'concept', label: '개념 맞히기 문제', text: '' };
  const listBox = h('div');
  const inp = h('input', { class: 'input', type: 'text', placeholder: '개념/이론 이름', onkeydown: (e) => { if (e.key === 'Enter') submit(); } });
  const hintBtn = h('button', { class: 'btn', onclick: () => { if (shown < item.clues.length) { shown++; draw(); } } });
  const subBtn = h('button', { class: 'btn primary', onclick: () => submit() }, '제출');
  const giveUp = h('button', { class: 'btn ghost', onclick: () => submit(true) }, '모르겠어요');
  const result = h('div', { 'aria-live': 'polite' });
  const draw = () => {
    listBox.replaceChildren(clueList(item, done ? item.clues.length : shown));
    hintBtn.textContent = `힌트 더 보기 (${shown}/${item.clues.length})`;
    hintBtn.disabled = done || shown >= item.clues.length;
    ctx.text = `[개념 맞히기] 공개된 특징: ${item.clues.slice(0, shown).join(' / ')}` + (done ? `\n정답: ${item.answer}` : '\n(제출 전이므로 정답을 직접 말하지 말 것)');
    setCurrent(ctx);
  };
  async function submit(gaveUp = false) {
    if (done) return;
    const user = gaveUp ? '' : inp.value.trim();
    if (!gaveUp && !user) return toast('답을 입력해 주세요.', 'warn');
    subBtn.disabled = giveUp.disabled = true;
    try {
      const r = (await judgeAll([{ key: 'x', user, item }])).x;
      done = true;
      const pts = points(item, shown, r.correct);
      onScore(pts, 100);
      record(item, r.correct, pts, user);
      inp.disabled = true;
      draw();
      result.replaceChildren(answerBox(item, r, pts, ctx, next));
    } catch (e) {
      result.replaceChildren(errorBox(e));
      subBtn.disabled = giveUp.disabled = false;
    }
  }
  draw();
  return h('article', { class: 'qcard' },
    h('div', { class: 'qmeta' }, h('span', { class: 'tag' }, item.category || '개념')),
    h('p', { class: 'qstem' }, '다음 특징이 가리키는 것은?'),
    listBox,
    h('div', { class: 'row wrap' }, inp, hintBtn, subBtn, giveUp),
    result);
}

function answerBox(item, r, pts, ctx, next) {
  return h('div', { class: 'result ' + (r.correct ? 'right' : 'wrong') },
    h('div', { class: 'result-head' }, h('strong', null, r.correct ? '✔ 정답' : '✘ 오답'), h('span', null, `정답: ${item.answer}`), h('span', { class: 'score' }, `${pts}점`), !r.correct && h('span', { class: 'muted small' }, '오답노트에 저장됨')),
    r.comment && h('p', null, r.comment),
    h('div', { class: 'explain' }, item.explanation),
    sourceChips(item.sources),
    h('div', { class: 'row' },
      next && h('button', { class: 'btn ghost', onclick: () => openChatAbout(ctx, '이 개념을 더 설명해 주세요. ') }, '💬 AI에게 질문'),
      reportButton(conceptQ(item), { feature: 'concept' }),
      learnedButton(conceptQ(item)),
      next && h('button', { class: 'btn primary', onclick: next }, '다음')));
}

function pairCard(pair, onScore, next) {
  let shown = 1, done = false;
  const ctx = { kind: 'concept', label: '혼동 모드 문제', text: '' };
  const cols = h('div', { class: 'pair-grid' });
  const inA = h('input', { class: 'input', type: 'text', placeholder: 'A는?' });
  const inB = h('input', { class: 'input', type: 'text', placeholder: 'B는?' });
  const maxClues = Math.max(pair.a.clues.length, pair.b.clues.length);
  const hintBtn = h('button', { class: 'btn', onclick: () => { if (shown < maxClues) { shown++; draw(); } } });
  const subBtn = h('button', { class: 'btn primary', onclick: () => submit() }, '제출');
  const result = h('div', { 'aria-live': 'polite' });
  const draw = () => {
    const n = done ? maxClues : shown;
    cols.replaceChildren(
      h('div', { class: 'pair-col' }, h('h3', null, 'A'), clueList(pair.a, n), inA),
      h('div', { class: 'pair-col' }, h('h3', null, 'B'), clueList(pair.b, n), inB));
    hintBtn.textContent = `힌트 더 보기 (${shown}/${maxClues})`;
    hintBtn.disabled = done || shown >= maxClues;
    ctx.text = `[혼동 모드] A 특징: ${pair.a.clues.slice(0, shown).join(' / ')}\nB 특징: ${pair.b.clues.slice(0, shown).join(' / ')}` + (done ? `\n정답: A=${pair.a.answer}, B=${pair.b.answer}` : '\n(제출 전이므로 정답을 직접 말하지 말 것)');
    setCurrent(ctx);
  };
  async function submit() {
    if (done) return;
    subBtn.disabled = true;
    try {
      const r = await judgeAll([{ key: 'a', user: inA.value.trim(), item: pair.a }, { key: 'b', user: inB.value.trim(), item: pair.b }]);
      done = true;
      const pa = points(pair.a, shown, r.a.correct), pb = points(pair.b, shown, r.b.correct);
      onScore(pa + pb, 200);
      record(pair.a, r.a.correct, pa, inA.value);
      record(pair.b, r.b.correct, pb, inB.value);
      inA.disabled = inB.disabled = true;
      draw();
      result.replaceChildren(
        h('div', { class: 'pair-grid' }, answerBox(pair.a, r.a, pa, ctx), answerBox(pair.b, r.b, pb, ctx)),
        h('div', { class: 'card distinction' }, h('b', null, '핵심 차이 '), pair.distinction, sourceChips(pair.sources)),
        h('div', { class: 'row' }, h('button', { class: 'btn ghost', onclick: () => openChatAbout(ctx, '두 개념의 차이를 예시로 설명해 주세요. ') }, '💬 AI에게 질문'), h('button', { class: 'btn primary', onclick: next }, '다음')));
    } catch (e) {
      result.replaceChildren(errorBox(e));
      subBtn.disabled = false;
    }
  }
  draw();
  return h('article', { class: 'qcard' },
    h('div', { class: 'qmeta' }, h('span', { class: 'tag' }, '혼동 모드')),
    h('p', { class: 'qstem' }, '헷갈리기 쉬운 두 개념입니다. A와 B는 각각 무엇일까요?'),
    cols, h('div', { class: 'row wrap' }, hintBtn, subBtn), result);
}
