// 3. 발화자 맞히기
import { h, add, clear, pageHead, loadingBox, errorBox, sourceChips, shuffle, setCurrent, toast, CIRC, busy } from '../ui.js';
import { askJSON, T, SOURCES } from '../ai.js';
import { scopeKey } from '../docs.js';
import { S, save, uid, recordAttempt, addWrong } from '../store.js';
import { openChatAbout } from '../panels.js';

const EXTRACT = T.obj({
  quotes: T.arr(T.obj({ quote_ko: T.str, original: T.str, original_lang: T.str, speaker: T.str, topic: T.str, kind: T.oneOf('direct', 'claim'), sources: SOURCES })),
  sociologists: T.arr(T.str),
  topics: T.arr(T.str),
});

const LABEL = { material: '자료 출처', verified: '웹 출처(검증됨)', unverified: '웹 출처(미검증)' };
let showOriginal = false;

const norm = (s) => String(s || '').replace(/\s|·|\./g, '').toLowerCase();
function sameName(a, b) {
  const x = norm(a), y = norm(b);
  return !!x && !!y && (x === y || x.includes(y) || y.includes(x));
}
function bank() { return S().quoteBank[scopeKey()]; }

export async function render(root) {
  const area = h('div');
  const toolbar = h('div', { class: 'row wrap' });
  add(root, pageHead('발화자 맞히기', '자료 속 사회학자의 말을 무작위 순서로 보여 줍니다. 누가 한 말인지 맞혀 보세요.'), toolbar, area);

  const drawToolbar = () => {
    clear(toolbar);
    const b = bank();
    const counts = { material: 0, verified: 0, unverified: 0 };
    (b?.quotes || []).forEach((q) => counts[q.origin]++);
    const addBtn = h('button', { class: 'btn', onclick: () => busy(addBtn, async () => { await addFromWeb(); drawToolbar(); start(); }) }, '➕ 추가 (웹 검색)');
    add(toolbar, 
      h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: showOriginal, onchange: (e) => { showOriginal = e.target.checked; area.querySelectorAll('.q-original').forEach((x) => { x.hidden = !showOriginal; }); } }), h('span', null, '원문 함께 보기')),
      h('span', { class: 'grow' }),
      b && h('span', { class: 'muted small' }, `자료 ${counts.material} · 웹 검증 ${counts.verified} · 웹 미검증 ${counts.unverified}`),
      h('button', { class: 'btn', onclick: () => start() }, '🔀 다시 섞기'),
      addBtn,
      h('button', { class: 'btn ghost', onclick: async () => { delete S().quoteBank[scopeKey()]; save(); await load(); } }, '자료에서 다시 추출'));
  };

  async function load() {
    if (!bank()) {
      area.replaceChildren(loadingBox('자료에서 사회학자의 말을 찾고 있습니다…'));
      try {
        await extract();
      } catch (e) {
        area.replaceChildren(errorBox(e, load));
        return;
      }
    }
    drawToolbar();
    start();
  }

  function start() {
    const b = bank();
    if (!b?.quotes.length) {
      area.replaceChildren(h('div', { class: 'notice' }, '학습 범위에서 학자의 말을 찾지 못했습니다. 범위를 넓히거나 [추가] 버튼으로 웹에서 찾아보세요.'));
      return;
    }
    const order = shuffle(b.quotes);
    let i = 0, right = 0;
    const next = () => {
      if (i >= order.length) {
        area.replaceChildren(h('div', { class: 'card center' }, h('h2', null, `끝! ${order.length}문제 중 ${right}개 정답`), h('button', { class: 'btn primary', onclick: start }, '다시 섞어서 풀기')));
        return;
      }
      const q = order[i++];
      area.replaceChildren(h('div', { class: 'score-bar' }, `${i}/${order.length} · 정답 ${right}`), quoteCard(q, b, (ok) => { if (ok) right++; }, next));
    };
    next();
  }

  await load();
}

async function extract() {
  const task = [
    '학습 범위 자료에서 사회학자가 한 말을 찾아라. 직접 인용문(kind: "direct")을 우선하고, 직접 인용이 적으면 자료에 특정 학자의 주장으로 명시된 대표 문장(kind: "claim")도 포함한다. 최대 20개.',
    '- quote_ko: 한국어 문장. 문장 안에 학자 이름을 넣지 않는다(정답이 드러나지 않게 "나는", "그는" 등으로 바꾸거나 생략).',
    '- original: 자료에 원어 문장이 실려 있을 때만 그 원어 문장을 적는다. 자료에 없으면 빈 문자열(원문을 지어내지 않는다). original_lang에 언어 이름(예: 영어, 독일어, 프랑스어) 또는 빈 문자열.',
    '- speaker: 자료에 쓰인 학자 이름. topic: 관련 주제/개념. sources: 자료 위치.',
    '- sociologists: 학습 범위에 등장하는 모든 사회학자 이름. topics: 학습 범위의 주요 주제·이론 목록.',
  ].join('\n');
  const { data } = await askJSON({ task, schema: EXTRACT });
  const quotes = (data.quotes || []).filter((q) => q.quote_ko && q.speaker).map((q) => ({
    id: uid(), text: q.quote_ko, original: q.original || '', lang: q.original_lang || '', speaker: q.speaker, topic: q.topic, kind: q.kind,
    origin: 'material', sources: q.sources || [],
  }));
  const sociologists = [...new Set([...(data.sociologists || []), ...quotes.map((q) => q.speaker)])];
  S().quoteBank[scopeKey()] = { quotes, sociologists, topics: data.topics || [] };
  save();
}

async function addFromWeb() {
  const b = bank();
  if (!b) return;
  if (!b.sociologists.length) return toast('학습 범위에서 사회학자를 찾지 못해 검색할 수 없습니다.', 'warn');
  const task = [
    '웹 검색으로 사회학자의 실제 발언/저술 인용문을 찾아라. 반드시 아래 조건을 모두 지킨다.',
    `- 학자는 다음 목록에 있는 사람만: ${b.sociologists.join(', ')}`,
    `- 주제는 다음 학습 범위 주제와 관련된 것만: ${b.topics.join(', ') || '(학습 범위의 주제)'}`,
    `- 이미 있는 인용과 겹치지 않게: ${b.quotes.slice(0, 30).map((q) => q.text.slice(0, 30)).join(' / ')}`,
    '- 신뢰할 수 있는 출처(원전, 학술 자료, 대학·출판사, Wikiquote의 출처 표기된 항목 등)에서 확인한 인용만 verification: "verified". 출처는 찾았지만 원전 확인이 불분명하면 "unverified". 잘못된 귀속이나 출처를 확인할 수 없는 가짜 인용으로 의심되면 "misattributed"로 표시한다(프로그램이 걸러낸다).',
    '- original: 원어 인용문, original_lang: 언어 이름, quote_ko: 한국어 번역(학자 이름은 넣지 않음), speaker, topic, source_url: 실제로 확인한 페이지 URL, source_title: 페이지 제목, note: 원전(책 제목·연도 등) 정보.',
    '- 5~8개를 찾는다. 최종 답은 아래 스키마의 JSON 객체 하나로만 출력한다.',
  ].join('\n');
  const schema = T.obj({ quotes: T.arr(T.obj({ original: T.str, original_lang: T.str, quote_ko: T.str, speaker: T.str, topic: T.str, source_url: T.str, source_title: T.str, verification: T.oneOf('verified', 'unverified', 'misattributed'), note: T.str })) });
  const { data, searchResults } = await askJSON({ task, schema, web: true });
  const seenUrls = new Set(searchResults.map((r) => r.url.replace(/[#?].*$/, '').replace(/\/$/, '')));
  let added = 0, filtered = 0;
  for (const q of data.quotes || []) {
    const inScope = b.sociologists.some((s) => sameName(s, q.speaker));
    const url = String(q.source_url || '');
    const urlSeen = seenUrls.has(url.replace(/[#?].*$/, '').replace(/\/$/, ''));
    const dup = b.quotes.some((x) => norm(x.text) === norm(q.quote_ko) || (q.original && norm(x.original) === norm(q.original)));
    if (!inScope || q.verification === 'misattributed' || !q.quote_ko || !/^https?:\/\//.test(url) || dup) { filtered++; continue; }
    b.quotes.push({
      id: uid(), text: q.quote_ko, original: q.original, lang: q.original_lang, speaker: q.speaker, topic: q.topic,
      origin: q.verification === 'verified' && urlSeen ? 'verified' : 'unverified',
      url, urlTitle: q.source_title, note: q.note, sources: [],
    });
    added++;
  }
  save();
  toast(`웹에서 인용 ${added}개를 추가했습니다.${filtered ? ` (범위 밖·출처 불명·중복 ${filtered}개 제외)` : ''}`, added ? 'info' : 'warn');
}

function quoteCard(q, b, onAnswered, next) {
  const pool = [...new Set([...b.sociologists, ...b.quotes.map((x) => x.speaker)])].filter((s) => !sameName(s, q.speaker));
  const choices = shuffle([q.speaker, ...shuffle(pool).slice(0, 4)]);
  const ctx = { kind: 'quote', label: '발화자 맞히기 문제', text: `[발화자 맞히기] 인용: "${q.text}"` };
  setCurrent(ctx);
  const result = h('div', { 'aria-live': 'polite' });
  let answered = false;
  const answer = (choice, btn) => {
    if (answered) return;
    answered = true;
    const ok = sameName(choice, q.speaker);
    onAnswered(ok);
    recordAttempt({ feature: 'speaker', type: 'speaker', concepts: [q.topic], sociologists: [q.speaker], correct: ok, score: ok ? 1 : 0 });
    if (!ok) {
      addWrong({ feature: 'speaker', userAnswer: choices.indexOf(choice), q: {
        id: q.id, type: 'mc', stem: `다음 말을 한 사회학자는? “${q.text}”`, context: '', options: choices, answer_index: choices.indexOf(q.speaker),
        explanation: `${q.speaker}의 말입니다.${q.note ? ' (' + q.note + ')' : ''}${q.url ? ' 출처: ' + q.url : ''}`, sources: q.sources, concepts: [q.topic], sociologists: [q.speaker], accept: [],
      } });
    }
    card.querySelectorAll('.choice').forEach((c) => {
      c.disabled = true;
      if (sameName(c.dataset.name, q.speaker)) c.classList.add('right');
      else if (c === btn) c.classList.add('wrong');
    });
    ctx.text += `\n정답: ${q.speaker} / 사용자 선택: ${choice}`;
    result.replaceChildren(h('div', { class: 'result ' + (ok ? 'right' : 'wrong') },
      h('div', { class: 'result-head' }, h('strong', null, ok ? '✔ 정답' : '✘ 오답'), h('span', null, `정답: ${q.speaker}`), !ok && h('span', { class: 'muted small' }, '오답노트에 저장됨')),
      q.topic && h('p', null, h('b', null, '주제 '), q.topic),
      originView(q),
      h('div', { class: 'row' }, h('button', { class: 'btn ghost', onclick: () => openChatAbout(ctx, '이 말의 의미를 설명해 주세요. ') }, '💬 AI에게 질문'), h('button', { class: 'btn primary', onclick: next }, '다음'))));
  };
  const card = h('article', { class: 'qcard quote-card' },
    h('div', { class: 'qmeta' }, h('span', { class: 'tag label-' + q.origin }, LABEL[q.origin]), q.kind === 'claim' && h('span', { class: 'tag soft' }, '자료 속 주장'), q.lang && h('span', { class: 'tag ghost' }, q.lang)),
    h('blockquote', { class: 'quote' }, `“${q.text}”`),
    q.original && h('blockquote', { class: 'quote q-original', hidden: !showOriginal }, h('span', { class: 'muted small' }, `원문(${q.lang || '원어'}) `), q.original),
    q.original && h('p', { class: 'muted small q-original', hidden: !showOriginal }, '위 한국어 문장은 원문의 번역입니다.'),
    h('p', { class: 'qstem' }, '누가 한 말일까요?'),
    h('div', { class: 'choices' }, choices.map((c, i) => {
      const btn = h('button', { class: 'choice', 'data-name': c, onclick: () => answer(c, btn) }, h('span', { class: 'circ' }, CIRC[i]), c);
      return btn;
    })),
    result);
  return card;
}

function originView(q) {
  if (q.origin === 'material') return sourceChips(q.sources);
  return h('div', { class: 'sources' },
    h('span', { class: 'src-label' }, LABEL[q.origin]),
    h('a', { class: 'chip src', href: q.url, target: '_blank', rel: 'noopener noreferrer' }, '🔗 ' + (q.urlTitle || q.url)),
    q.note && h('span', { class: 'muted small' }, q.note));
}
