// 로그인 이전 버전이 이 브라우저(localStorage·IndexedDB)에 남긴 기록을 계정으로 옮긴다.
import { h, modal, toast } from './ui.js';
import { S, save, settings, loadLegacy, clearLegacy } from './store.js';
import { legacyDocs, adoptLegacyDocs, docById } from './docs.js';
import { applyBackup } from './backup.js';
import { saveApiKey, waitSaved } from './cloud.js';

const ARRAYS = ['wrong', 'qlog', 'attempts', 'cards', 'exams', 'bank', 'reports'];
const flagKey = (uid) => `socstudy:migration:${uid}`;

export async function legacySummary() {
  const legacy = loadLegacy();
  const docs = await legacyDocs();
  const n = (k) => (legacy?.[k] || []).length;
  const has = docs.length || (legacy && ARRAYS.some((k) => n(k)));
  if (!has) return null;
  return { legacy, docs, text: `오답 ${n('wrong')}개 · 질문 기록 ${n('qlog')}개 · 채점 기록 ${n('attempts')}개 · 플래시카드 ${n('cards')}장 · 문제 은행 ${n('bank')}개 · 자료 ${docs.length}개` };
}

export async function maybeAskMigration(uid) {
  try { if (localStorage.getItem(flagKey(uid))) return; } catch { return; }
  const sum = await legacySummary();
  if (!sum) return;
  askMigration(uid, sum);
}

export function askMigration(uid, sum) {
  modal('기존 기록 옮기기', h('div', null,
    h('p', null, h('b', null, '이 브라우저에 저장된 기존 기록을 계정으로 옮길까요?')),
    h('p', { class: 'muted small' }, sum.text),
    h('p', { class: 'muted small' }, '계정에 이미 있는 기록과 합칩니다. 같은 항목은 더 최근 것을 남기고 중복은 지웁니다.')), [
    { label: '옮기지 않기', onclick: () => { try { localStorage.setItem(flagKey(uid), 'declined'); } catch {} toast('옮기지 않았어요. [설정]에서 나중에 옮길 수 있어요.'); } },
    { label: '옮기기', primary: true, onclick: () => { migrate(uid, sum); } },
  ]);
}

async function migrate(uid, { legacy, docs }) {
  toast('기존 기록을 계정으로 옮기는 중이에요…');
  try {
    await adoptLegacyDocs(docs); // 자료 ID를 그대로 써서 학습 범위·출처가 이어진다
    if (legacy) {
      applyBackup({ app: 'socstudy', data: legacy }, 'merge');
      for (const [id, pages] of Object.entries(legacy.scope || {})) {
        if (docById(id) && !(S().scope[id] || []).length) S().scope[id] = pages;
      }
      save();
      if (!settings().apiKey && legacy.settings?.apiKey) await saveApiKey(legacy.settings.apiKey);
    }
    const saved = await waitSaved(10000);
    clearLegacy();
    try { localStorage.setItem(flagKey(uid), 'done'); } catch {}
    toast(saved ? '기존 기록을 계정으로 옮겼어요. ✔' : '기존 기록을 옮겼어요. 오프라인이라 인터넷에 연결되면 계정에 저장돼요.');
    setTimeout(() => location.reload(), 1200);
  } catch (e) {
    console.error(e);
    toast('기록을 옮기지 못했어요: ' + e.message + ' (기존 기록은 이 브라우저에 그대로 있어요)', 'error');
  }
}
