// 11. 개념 지도: 사회학자–이론–개념 관계 그래프
import { h, add, pageHead, loadingBox, errorBox, sourceChips, setCurrent } from '../ui.js';
import { askJSON, T, SOURCES } from '../ai.js';
import { scopeKey } from '../docs.js';
import { S, save } from '../store.js';
import { openChatAbout } from '../panels.js';

const SCHEMA = T.obj({
  nodes: T.arr(T.obj({ id: T.str, label: T.str, kind: T.oneOf('sociologist', 'theory', 'concept'), description: T.str, sources: SOURCES })),
  edges: T.arr(T.obj({ source: T.str, target: T.str, label: T.str })),
});
const KIND = { sociologist: '사회학자', theory: '이론', concept: '개념' };
const SVGNS = 'http://www.w3.org/2000/svg';
const svg = (tag, attrs = {}) => { const el = document.createElementNS(SVGNS, tag); for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v); return el; };

export function render(root) {
  const area = h('div');
  const regen = h('button', { class: 'btn', onclick: () => build(true) }, '다시 만들기');
  add(root, pageHead('개념 지도', '학습 범위의 사회학자·이론·개념 사이의 관계를 그래프로 보여 줍니다. 노드를 누르면 설명과 출처 쪽수가 나옵니다. 끌어서 옮기고, 휠/버튼으로 확대할 수 있습니다.', h('div', { class: 'row' }, regen)), area);

  async function build(force = false) {
    const key = scopeKey();
    let graph = S().maps[key];
    if (!graph || force) {
      regen.disabled = true;
      area.replaceChildren(loadingBox('자료에서 관계를 정리하고 있습니다…'));
      try {
        const { data } = await askJSON({ schema: SCHEMA, task: [
          '학습 범위 자료에 나오는 사회학자, 이론, 핵심 개념을 노드로, 그 관계를 엣지로 하는 개념 지도를 만들어라.',
          '- 노드 15~40개. id는 짧은 영문/숫자. label은 자료에 쓰인 이름. kind: sociologist/theory/concept.',
          '- description: 자료에 근거한 2~3문장 설명. sources: 근거 위치.',
          '- edges: 자료에서 확인되는 관계만(예: "제시", "구성 개념", "비판", "대비", "발전"). label은 2~6글자.',
          '- 자료에 없는 학자나 개념은 넣지 않는다.',
        ].join('\n') });
        const ids = new Set((data.nodes || []).map((n) => n.id));
        graph = { nodes: data.nodes || [], edges: (data.edges || []).filter((e) => ids.has(e.source) && ids.has(e.target) && e.source !== e.target) };
        if (!graph.nodes.length) throw new Error('개념 지도를 만들지 못했습니다.');
        S().maps[key] = graph;
        save();
      } catch (e) {
        area.replaceChildren(errorBox(e, () => build(true)));
        return;
      } finally {
        regen.disabled = false;
      }
    }
    area.replaceChildren(graphView(graph));
  }
  build();
}

function layout(nodes, edges, W, H) {
  const pos = new Map();
  const kinds = ['sociologist', 'theory', 'concept'];
  nodes.forEach((n, i) => {
    const ring = kinds.indexOf(n.kind) + 1;
    const a = (i / nodes.length) * Math.PI * 2;
    pos.set(n.id, { x: W / 2 + Math.cos(a) * ring * 90, y: H / 2 + Math.sin(a) * ring * 70, vx: 0, vy: 0 });
  });
  const k = Math.sqrt((W * H) / Math.max(nodes.length, 1)) * 0.75;
  for (let it = 0; it < 400; it++) {
    const t = 1 - it / 400;
    for (const a of nodes) {
      const p = pos.get(a.id);
      let fx = (W / 2 - p.x) * 0.01, fy = (H / 2 - p.y) * 0.01;
      for (const b of nodes) {
        if (a === b) continue;
        const q = pos.get(b.id);
        let dx = p.x - q.x, dy = p.y - q.y;
        const d2 = dx * dx + dy * dy || 0.01;
        const f = (k * k) / d2;
        fx += dx * f * 0.05; fy += dy * f * 0.05;
      }
      p.vx = (p.vx + fx) * 0.85; p.vy = (p.vy + fy) * 0.85;
    }
    for (const e of edges) {
      const p = pos.get(e.source), q = pos.get(e.target);
      const dx = q.x - p.x, dy = q.y - p.y;
      const d = Math.sqrt(dx * dx + dy * dy) || 1;
      const f = (d - k) * 0.02;
      p.vx += (dx / d) * f; p.vy += (dy / d) * f;
      q.vx -= (dx / d) * f; q.vy -= (dy / d) * f;
    }
    for (const n of nodes) {
      const p = pos.get(n.id);
      const sp = Math.sqrt(p.vx * p.vx + p.vy * p.vy);
      const lim = 20 * t + 1;
      if (sp > lim) { p.vx *= lim / sp; p.vy *= lim / sp; }
      p.x += p.vx; p.y += p.vy;
    }
  }
  return pos;
}

function graphView(graph) {
  const W = 1000, H = 700;
  const pos = layout(graph.nodes, graph.edges, W, H);
  const xs = [...pos.values()].map((p) => p.x), ys = [...pos.values()].map((p) => p.y);
  const pad = 80;
  let vb = { x: Math.min(...xs) - pad, y: Math.min(...ys) - pad, w: Math.max(...xs) - Math.min(...xs) + pad * 2, h: Math.max(...ys) - Math.min(...ys) + pad * 2 };
  const home = { ...vb };
  const s = svg('svg', { class: 'map-svg', role: 'img', 'aria-label': '개념 지도' });
  const setVB = () => s.setAttribute('viewBox', `${vb.x} ${vb.y} ${vb.w} ${vb.h}`);
  setVB();
  const gEdges = svg('g', { class: 'edges' }), gNodes = svg('g', { class: 'nodes' });
  add(s, gEdges, gNodes);

  const detail = h('div', { class: 'card map-detail' }, h('p', { class: 'muted' }, '노드를 누르면 설명이 여기에 나옵니다.'));
  const edgeEls = graph.edges.map((e) => {
    const line = svg('line', { class: 'edge' });
    const text = svg('text', { class: 'edge-label' });
    text.textContent = e.label;
    add(gEdges, line, text);
    return { e, line, text };
  });
  const nodeEls = new Map();
  const drawEdges = () => edgeEls.forEach(({ e, line, text }) => {
    const p = pos.get(e.source), q = pos.get(e.target);
    line.setAttribute('x1', p.x); line.setAttribute('y1', p.y); line.setAttribute('x2', q.x); line.setAttribute('y2', q.y);
    text.setAttribute('x', (p.x + q.x) / 2); text.setAttribute('y', (p.y + q.y) / 2 - 4);
  });

  const select = (n) => {
    const linked = new Set([n.id]);
    graph.edges.forEach((e) => { if (e.source === n.id) linked.add(e.target); if (e.target === n.id) linked.add(e.source); });
    nodeEls.forEach((g, id) => g.classList.toggle('dim', !linked.has(id)));
    nodeEls.forEach((g, id) => g.classList.toggle('sel', id === n.id));
    edgeEls.forEach(({ e, line, text }) => { const on = e.source === n.id || e.target === n.id; line.classList.toggle('on', on); text.classList.toggle('on', on); });
    const rel = graph.edges.filter((e) => e.source === n.id || e.target === n.id).map((e) => {
      const other = graph.nodes.find((x) => x.id === (e.source === n.id ? e.target : e.source));
      return `${e.source === n.id ? '→' : '←'} ${other?.label} (${e.label})`;
    });
    const ctx = { kind: 'map', label: `개념 지도: ${n.label}`, text: `[개념 지도] ${n.label}(${KIND[n.kind]}): ${n.description}` };
    setCurrent(ctx);
    detail.replaceChildren(
      h('div', { class: 'qmeta' }, h('span', { class: 'tag kind-' + n.kind }, KIND[n.kind])),
      h('h2', null, n.label),
      h('p', null, n.description),
      rel.length ? h('div', null, h('div', { class: 'field-label' }, '연결'), h('ul', { class: 'rel-list' }, rel.map((r) => h('li', null, r)))) : null,
      sourceChips(n.sources),
      h('div', { class: 'row' },
        h('a', { class: 'btn small', href: `#/quiz?focus=${encodeURIComponent(n.label)}` }, '✏️ 이 주제로 퀴즈'),
        h('button', { class: 'btn ghost small', onclick: () => openChatAbout(ctx, `${n.label}에 대해 `) }, '💬 AI에게 질문')));
  };

  graph.nodes.forEach((n) => {
    const p = pos.get(n.id);
    const g = svg('g', { class: 'node kind-' + n.kind, tabindex: 0, role: 'button', 'aria-label': `${KIND[n.kind]} ${n.label}` });
    const shape = n.kind === 'theory'
      ? svg('rect', { x: -13, y: -13, width: 26, height: 26, rx: 5 })
      : n.kind === 'sociologist' ? svg('circle', { r: 15 }) : svg('polygon', { points: '0,-13 13,0 0,13 -13,0' });
    const label = svg('text', { y: 30, 'text-anchor': 'middle' });
    label.textContent = n.label.length > 14 ? n.label.slice(0, 13) + '…' : n.label;
    const title = svg('title'); title.textContent = `${n.label} (${KIND[n.kind]})`;
    add(g, shape, label, title);
    g.setAttribute('transform', `translate(${p.x},${p.y})`);
    gNodes.appendChild(g);
    nodeEls.set(n.id, g);
    g.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); select(n); } });

    let drag = null;
    g.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      g.setPointerCapture(e.pointerId);
      drag = { sx: e.clientX, sy: e.clientY, moved: false };
    });
    g.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const scale = vb.w / s.clientWidth;
      const dx = (e.clientX - drag.sx) * scale, dy = (e.clientY - drag.sy) * scale;
      if (Math.abs(dx) + Math.abs(dy) > 2) drag.moved = true;
      p.x += dx; p.y += dy;
      drag.sx = e.clientX; drag.sy = e.clientY;
      g.setAttribute('transform', `translate(${p.x},${p.y})`);
      drawEdges();
    });
    g.addEventListener('pointerup', () => { if (drag && !drag.moved) select(n); drag = null; });
  });
  drawEdges();

  // 배경 끌기 = 이동, 휠 = 확대/축소
  let pan = null;
  s.addEventListener('pointerdown', (e) => { pan = { x: e.clientX, y: e.clientY }; s.setPointerCapture(e.pointerId); });
  s.addEventListener('pointermove', (e) => {
    if (!pan) return;
    const scale = vb.w / s.clientWidth;
    vb.x -= (e.clientX - pan.x) * scale; vb.y -= (e.clientY - pan.y) * scale;
    pan = { x: e.clientX, y: e.clientY };
    setVB();
  });
  s.addEventListener('pointerup', () => { pan = null; });
  const zoom = (f) => {
    const cx = vb.x + vb.w / 2, cy = vb.y + vb.h / 2;
    vb.w *= f; vb.h *= f; vb.x = cx - vb.w / 2; vb.y = cy - vb.h / 2;
    setVB();
  };
  s.addEventListener('wheel', (e) => { e.preventDefault(); zoom(e.deltaY > 0 ? 1.12 : 0.89); }, { passive: false });

  const legend = h('div', { class: 'map-legend' },
    Object.entries(KIND).map(([k, l]) => h('span', { class: 'lg kind-' + k }, h('i', { 'aria-hidden': 'true' }), l)),
    h('span', { class: 'grow' }),
    h('button', { class: 'icon-btn', 'aria-label': '확대', onclick: () => zoom(0.8) }, '＋'),
    h('button', { class: 'icon-btn', 'aria-label': '축소', onclick: () => zoom(1.25) }, '－'),
    h('button', { class: 'btn small ghost', onclick: () => { vb = { ...home }; setVB(); } }, '원래 크기'));

  const listView = h('details', { class: 'map-list' }, h('summary', null, '목록으로 보기'),
    h('ul', null, graph.nodes.map((n) => h('li', null, h('button', { class: 'linklike', onclick: () => select(n) }, `${n.label}`), h('span', { class: 'muted small' }, ` · ${KIND[n.kind]}`)))));

  return h('div', { class: 'map-layout' }, h('div', { class: 'card map-card' }, legend, s, listView), detail);
}
