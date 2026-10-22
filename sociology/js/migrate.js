// 로그인 이전 버전이 이 브라우저(localStorage·IndexedDB)에 남긴 기록을 계정으로 옮긴다.
import { h, modal, toast } from './ui.js';
import { S, save, settings, loadLegacy, clearLegacy } from './store.js';
import { legacyDocs, adoptLegacyDocs, docById } from './docs.js';
import { applyBackup, buildBackupOf, saveFile } from './backup.js';
import { subject, SUBJECTS } from './subjects.js';
import { saveApiKey, waitSaved, readOldData, stateFromOld, migrateOldData } from './cloud.js';

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
      await applyBackup({ app: 'socstudy', subjects: { [subject().id]: { data: legacy } } }, 'merge');
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

// ---------- 과목 구조로 옮기기 (사회학 기록 → users/{uid}/subjects/soc/...) ----------
const COL_NAMES = { wrong: '오답노트', qlog: '질문 기록', cards: '플래시카드', exams: '시험 결과', bank: '문제 은행', reports: '신고 기록', attempts: '채점 기록(날짜별)', quoteBank: '발화 모음', maps: '개념 지도', meta: '범위·설정', materials: '자료 분석 결과', pages: '자료 본문' };

// 시작할 때 한 번 실행된다. 백업 파일을 저장한 뒤 복사하고, 서버에서 다시 읽어 확인한 뒤에야 끝난다.
export function runSubjectMigration(uid, mount) {
  return new Promise((resolve) => {
    const step = async () => {
      mount(h('div', { class: 'empty-state' }, h('h1', null, '기록을 과목별로 정리하는 중…'), h('p', { class: 'muted' }, '기존 사회학 기록을 읽고 있어요.')));
      let old;
      try { old = await readOldData(uid); } catch (e) { return fail('기존 기록을 읽지 못했어요: ' + e.message); }
      const st = stateFromOld(old);
      const backup = buildBackupOf('soc', st);
      const counts = Object.entries(old).filter(([, v]) => v.length).map(([k, v]) => `${COL_NAMES[k] || k} ${v.length}`).join(' · ');
      mount(h('div', { class: 'empty-state migrate-box' },
        h('h1', null, '과목별 저장 구조로 옮기기'),
        h('p', null, '국제정치 과목이 추가되어, 지금까지의 기록을 [사회학] 과목으로 옮깁니다.'),
        h('p', { class: 'muted small' }, `옮길 기록: ${counts}`),
        h('p', { class: 'muted small' }, '옮기기 전에 백업 파일을 이 기기에 저장합니다. 기존 기록은 계정에서 지우지 않고 그대로 보관합니다.'),
        h('button', { class: 'btn primary', onclick: async (e) => {
          e.currentTarget.disabled = true;
          saveFile(backup, `사회학_이전전_백업_${new Date().toISOString().slice(0, 10)}.json`);
          mount(h('div', { class: 'empty-state' }, h('h1', null, '옮기는 중…'), h('p', { class: 'muted' }, '복사한 뒤 계정에서 다시 읽어 하나하나 비교합니다. 창을 닫지 마세요.')));
          let r;
          try { r = await migrateOldData(uid, old, 'soc'); } catch (err) { return fail('옮기지 못했어요: ' + err.message); }
          const table = h('table', { class: 'data-table' },
            h('thead', null, h('tr', null, h('th', null, '항목'), h('th', null, '기존'), h('th', null, '옮긴 뒤 확인'), h('th', null, ''))),
            h('tbody', null, r.report.filter((x) => x.before).map((x) => h('tr', null, h('td', null, COL_NAMES[x.col] || x.col), h('td', null, String(x.before)), h('td', null, String(x.after)), h('td', null, x.after === x.before ? '✔' : '✘')))));
          if (!r.ok) return fail('옮긴 기록을 확인해 보니 일부가 다릅니다. 기존 기록은 그대로 있으니 다시 시도해 주세요.', table);
          mount(h('div', { class: 'empty-state migrate-box' },
            h('h1', null, '✔ 옮기기 완료'),
            h('p', null, '모든 기록을 [사회학] 과목으로 옮겼고, 계정에서 다시 읽어 내용이 같은지 확인했습니다.'),
            h('div', { class: 'table-wrap' }, table),
            h('button', { class: 'btn primary', onclick: () => resolve('soc') }, '시작하기')));
        } }, '백업 파일 저장하고 옮기기')));
    };
    const fail = (msg, extra) => mount(h('div', { class: 'empty-state' }, h('h1', null, '옮기지 못했어요'), h('p', null, msg), extra || null, h('button', { class: 'btn primary', onclick: step }, '다시 시도')));
    step();
  });
}
