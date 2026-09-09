// 選手期別成績 一括取込マネージャー
// Reactコンポーネントの外で処理を持ち、管理画面から別ページへ移動しても取込を継続する。
import { saveRacerTermStats } from "@/lib/dataManagementService";
import { detectTermFromFilename } from "@/lib/racerTermParser";

const listeners = new Set();
let runnerPromise = null;
let queue = [];
let state = {
  running: false,
  current: 0,
  total: 0,
  file: "",
  results: [],
  startedAt: null,
  finishedAt: null,
};

function snapshot() {
  return { ...state, results: [...state.results] };
}
function emit() {
  const s = snapshot();
  for (const fn of listeners) {
    try { fn(s); } catch {}
  }
}

export function getRacerTermImportState() {
  return snapshot();
}

export function subscribeRacerTermImport(fn) {
  listeners.add(fn);
  fn(snapshot());
  return () => listeners.delete(fn);
}

export async function startRacerTermImport(previews) {
  if (state.running) return snapshot();
  const items = Array.from(previews || []).filter((p) => p?.data?.records?.length && p?.file?.name);
  if (!items.length) throw new Error("取込対象の期別成績ファイルがありません");

  queue = items.map((p) => ({ fileName: p.file.name, data: p.data }));
  state = {
    running: true,
    current: 0,
    total: queue.length,
    file: queue[0]?.fileName || "",
    results: [],
    startedAt: new Date().toISOString(),
    finishedAt: null,
  };
  emit();

  if (!runnerPromise) {
    runnerPromise = (async () => {
      try {
        for (let i = 0; i < queue.length; i++) {
          const item = queue[i];
          state = { ...state, current: i + 1, file: item.fileName };
          emit();

          const detected = detectTermFromFilename(item.fileName);
          const termOverride = detected ? { term_year: detected.term_year, term_half: detected.term_half } : null;
          try {
            const r = await saveRacerTermStats(item.data, item.fileName, termOverride);
            state = { ...state, results: [...state.results, { file: item.fileName, ...r }] };
          } catch (e) {
            state = { ...state, results: [...state.results, { file: item.fileName, ok: false, error: e?.message || String(e) }] };
          }
          emit();
        }
      } finally {
        state = {
          ...state,
          running: false,
          file: "",
          finishedAt: new Date().toISOString(),
        };
        queue = [];
        emit();
        runnerPromise = null;
      }
    })();
  }
  return snapshot();
}
