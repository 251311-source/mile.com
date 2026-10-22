// 백그라운드 생성 작업: 다른 화면으로 가도 생성이 계속되고, 돌아오면 결과가 그대로 있다. 생성 취소 시 AI 요청도 멈춘다.
import { h, toast } from './ui.js';

const jobs = new Map();      // key → { key, label, page, status: running|done|error|cancelled, ctrl, error }
const areas = new Map();     // key → 화면을 떠나도 유지되는 결과 영역
const listeners = new Set();
const notify = () => listeners.forEach((fn) => fn());

export class CancelledError extends Error {
  constructor() { super('생성을 취소했어요.'); this.name = 'CancelledError'; }
}
export const isCancel = (e) => e?.name === 'CancelledError' || e?.name === 'AbortError';

// 화면을 다시 그려도 같은 요소를 돌려준다(진행 중인 생성 결과·풀던 문제가 유지됨)
export function persistentArea(key) {
  if (!areas.has(key)) areas.set(key, h('div', { class: 'job-area', 'data-job': key }));
  return areas.get(key);
}

export const getJob = (key) => jobs.get(key);
export const isRunning = (key) => jobs.get(key)?.status === 'running';

// fn(signal)을 백그라운드로 실행한다. 이미 실행 중이면 그 작업을 돌려준다.
export function runJob(key, { label, page }, fn) {
  if (isRunning(key)) return jobs.get(key);
  const ctrl = new AbortController();
  const job = { key, label, page, status: 'running', ctrl, error: null };
  jobs.set(key, job);
  notify();
  job.promise = Promise.resolve()
    .then(() => fn(ctrl.signal))
    .then(() => { job.status = ctrl.signal.aborted ? 'cancelled' : 'done'; })
    .catch((e) => { job.status = ctrl.signal.aborted || isCancel(e) ? 'cancelled' : 'error'; job.error = e; })
    .finally(() => {
      notify();
      // 다른 화면에 있으면 끝났다고 알려 준다
      if (job.status === 'done' && !document.querySelector(`[data-page="${page}"]`)) {
        toast(h('span', null, `✔ ${label} 준비됐어요. `, h('a', { href: `#/${page}`, class: 'toast-link' }, '보러 가기')), 'info', 8000);
      }
    });
  return job;
}

export function cancelJob(key) {
  const job = jobs.get(key);
  if (job?.status === 'running') job.ctrl.abort();
}

export function onJobs(fn) { listeners.add(fn); return () => listeners.delete(fn); }

// 작게 표시되는 [생성] [생성 취소] 버튼 묶음
export function jobControls(key, { start, label = '생성', running = '생성 중…', extra = [] }) {
  const status = h('span', { class: 'muted small job-status' });
  const go = h('button', { class: 'btn small primary', onclick: () => start() }, label);
  const more = extra.map((x) => h('button', { class: 'btn small', onclick: () => x.onclick() }, x.label));
  const stop = h('button', { class: 'btn small ghost', onclick: () => cancelJob(key) }, '생성 취소');
  const box = h('div', { class: 'job-controls' }, go, ...more, stop, status);
  const draw = () => {
    if (!box.isConnected && box.dataset.mounted) return off(); // 화면을 떠나면 구독 해제
    const j = getJob(key);
    const run = j?.status === 'running';
    go.disabled = run;
    more.forEach((b) => { b.disabled = run; });
    stop.disabled = !run;
    status.textContent = run ? running : j?.status === 'cancelled' ? '생성을 취소했어요.' : '';
  };
  const off = onJobs(() => { box.dataset.mounted = '1'; draw(); });
  draw();
  setTimeout(() => { box.dataset.mounted = '1'; }, 0);
  return box;
}

export const anyRunning = () => [...jobs.values()].some((j) => j.status === 'running');
