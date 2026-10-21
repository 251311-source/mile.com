// 공통 설정: 자료 업로드와 학습 범위 선택
import { h, add, clear, pageHead, toast, confirmBox } from '../ui.js';
import { allDocs, addFile, removeDoc, unitName, parseRanges, formatRanges, scopeSummary, buildMaterial } from '../docs.js';
import { S, save, settings } from '../store.js';

export function render(root) {
  const fileInput = h('input', { type: 'file', accept: '.pdf,.pptx,.ppt,application/pdf,application/vnd.openxmlformats-officedocument.presentationml.presentation', multiple: true, hidden: true, onchange: (e) => upload([...e.target.files]) });
  const progress = h('div', { class: 'upload-progress' });
  const drop = h('div', { class: 'dropzone', tabindex: 0, role: 'button', 'aria-label': '파일 선택',
    onclick: () => fileInput.click(),
    onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); } },
    ondragover: (e) => { e.preventDefault(); drop.classList.add('over'); },
    ondragleave: () => drop.classList.remove('over'),
    ondrop: (e) => { e.preventDefault(); drop.classList.remove('over'); upload([...e.dataTransfer.files]); },
  },
  h('div', { class: 'drop-ico', 'aria-hidden': 'true' }, '⬆'),
  h('strong', null, 'PDF·PPTX 파일을 끌어 놓거나 눌러서 선택'),
  h('span', { class: 'muted small' }, '여러 파일을 한 번에 올릴 수 있습니다. 자료는 이 브라우저 안에만 저장됩니다.'),
  fileInput);

  const summary = h('div', { class: 'scope-summary' });
  const list = h('div', { class: 'doc-list' });
  add(root, 
    pageHead('자료·범위', '공부할 자료를 올리고 학습 범위를 고르세요. 모든 기능은 선택한 범위 안에서만 문제와 설명을 만듭니다.'),
    drop, progress, summary, list);

  const drawSummary = () => {
    const s = scopeSummary();
    const m = buildMaterial();
    clear(summary);
    add(summary, 
      h('div', { class: 'stat-row' },
        stat('선택한 파일', s.files + '개'),
        stat('선택한 쪽/슬라이드', s.units + '개'),
        stat('글자 수', s.chars.toLocaleString() + '자')),
      m.truncated && h('div', { class: 'notice warn' }, `선택 범위가 ${Number(settings().maxChars).toLocaleString()}자를 넘어 뒷부분은 AI에 전달되지 않습니다. 범위를 줄이거나 [설정]에서 최대 길이를 늘려 주세요.`),
      s.units > 0 && h('div', { class: 'row' }, h('a', { class: 'btn primary', href: '#/quiz' }, '✏️ 이 범위로 퀴즈 풀기'), h('a', { class: 'btn', href: '#/cards' }, '🃏 플래시카드')));
  };

  const drawList = () => {
    clear(list);
    const docs = allDocs();
    if (!docs.length) list.appendChild(h('p', { class: 'muted empty' }, '아직 올린 자료가 없습니다.'));
    docs.forEach((d) => list.appendChild(docCard(d, () => { drawSummary(); }, async () => {
      if (await confirmBox(`'${d.name}'을(를) 삭제할까요? 학습 기록은 유지됩니다.`)) {
        await removeDoc(d.id);
        drawList(); drawSummary();
      }
    })));
  };

  async function upload(files) {
    for (const f of files) {
      const bar = h('div', { class: 'bar' }, h('i'));
      const row = h('div', { class: 'up-row' }, h('span', null, f.name), bar);
      progress.appendChild(row);
      try {
        const doc = await addFile(f, (p) => { bar.firstChild.style.width = Math.round(p * 100) + '%'; });
        const empty = doc.units.filter((u) => !u.text.trim()).length;
        toast(`${f.name}: ${doc.units.length}${unitName(doc)} 읽음`);
        if (empty) toast(`${f.name}: 글자가 없는 ${unitName(doc)} ${empty}개는 범위에서 제외했습니다(스캔 이미지일 수 있음).`, 'warn');
      } catch (e) {
        console.error(e);
        toast(e.message || `${f.name}을(를) 읽지 못했습니다.`, 'error');
      }
      row.remove();
    }
    fileInput.value = '';
    drawList(); drawSummary();
  }

  drawList();
  drawSummary();
}

function stat(label, value) {
  return h('div', { class: 'stat' }, h('span', { class: 'stat-v' }, value), h('span', { class: 'stat-l' }, label));
}

function docCard(d, onChange, onDelete) {
  const card = h('article', { class: 'doc-card' });
  const sel = () => new Set(S().scope[d.id] || []);
  const set = (nums) => { S().scope[d.id] = [...nums].sort((a, b) => a - b); save(); draw(); onChange(); };
  const total = d.units.length;
  const textual = d.units.filter((u) => u.text.trim()).map((u) => u.n);

  let detailsOpen = total <= 60;
  const rangeInput = h('input', { class: 'input', type: 'text', placeholder: `예: 1-10, 15, 20-24`, 'aria-label': '범위 직접 입력' });

  function draw() {
    const s = sel();
    clear(card);
    add(card, 
      h('div', { class: 'doc-head' },
        h('span', { class: 'doc-kind ' + d.kind }, d.kind === 'pptx' ? 'PPT' : 'PDF'),
        h('div', { class: 'doc-title' }, h('strong', null, d.name), h('span', { class: 'muted small' }, `${d.tag} · 전체 ${total}${unitName(d)} · 선택 ${s.size}${unitName(d)}`)),
        h('button', { class: 'icon-btn', 'aria-label': '자료 삭제', title: '삭제', onclick: onDelete }, '🗑')),
      h('div', { class: 'row wrap' },
        h('button', { class: 'btn small', onclick: () => set(textual) }, '전체 선택'),
        h('button', { class: 'btn small', onclick: () => set([]) }, '전체 해제'),
        h('span', { class: 'grow' }),
        rangeInput,
        h('button', { class: 'btn small', onclick: () => {
          const nums = parseRanges(rangeInput.value, total).filter((n) => textual.includes(n));
          if (!nums.length) return toast('올바른 범위를 입력해 주세요. 예: 3-12, 15', 'warn');
          set(nums);
        } }, '범위 적용')),
      d.chapters?.length ? h('div', { class: 'chapters' },
        h('span', { class: 'field-label' }, '단원(목차)'),
        h('div', { class: 'chip-row' }, d.chapters.map((c) => {
          const nums = textual.filter((n) => n >= c.start && n <= c.end);
          const on = nums.length && nums.every((n) => s.has(n));
          const some = nums.some((n) => s.has(n));
          return h('button', { class: 'chip toggle' + (on ? ' on' : some ? ' some' : ''), 'aria-pressed': String(!!on), onclick: () => {
            const next = sel();
            if (on) nums.forEach((n) => next.delete(n)); else nums.forEach((n) => next.add(n));
            set(next);
          } }, `${c.title.trim()} (${c.start}–${c.end})`);
        }))) : h('p', { class: 'muted small' }, `이 파일에는 목차 정보가 없어 ${unitName(d)} 단위로 선택합니다.`),
      h('details', { class: 'unit-details', open: detailsOpen, ontoggle: (e) => { detailsOpen = e.target.open; } },
        h('summary', null, `${unitName(d)}별 선택 (${formatRanges([...s]) || '없음'})`),
        h('div', { class: 'unit-grid' }, d.units.map((u) => {
          const empty = !u.text.trim();
          return h('button', {
            class: 'unit' + (s.has(u.n) ? ' on' : '') + (empty ? ' empty' : ''),
            disabled: empty,
            title: empty ? '글자가 없습니다(스캔 이미지일 수 있음)' : `${u.n}: ${u.title}`,
            'aria-pressed': String(s.has(u.n)),
            onclick: () => { const next = sel(); next.has(u.n) ? next.delete(u.n) : next.add(u.n); set(next); },
          }, String(u.n));
        }))));
  }
  draw();
  return card;
}
