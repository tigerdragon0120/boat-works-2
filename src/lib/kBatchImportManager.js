// K過去結果のバックグラウンド一括取込マネージャー
// Reactコンポーネントの外で処理を保持することで、管理画面内で別ページ/別タブへ移動しても
// 一括取込ループがアンマウントに巻き込まれて停止しないようにする。
import { parseBoatraceFile } from "@/lib/boatraceFileParser";
import { saveBoatraceData } from "@/lib/dataManagementService";

let state = {
  running: false,
  current: 0,
  total: 0,
  file: "",
  results: [],
  startedAt: null,
  finishedAt: null,
};

const listeners = new Set();

function emit() {
  const snapshot = { ...state, results: [...state.results] };
  for (const fn of listeners) {
    try { fn(snapshot); } catch {}
  }
}

export function getKBatchImportState() {
  return { ...state, results: [...state.results] };
}

export function subscribeKBatchImport(fn) {
  listeners.add(fn);
  fn(getKBatchImportState());
  return () => listeners.delete(fn);
}

export async function startKBatchImport(files) {
  const list = Array.from(files || []).filter((f) => /\.txt$/i.test(f?.name || ""));
  if (!list.length) throw new Error("Kファイルが選択されていません");
  if (state.running) return getKBatchImportState();

  state = {
    running: true,
    current: 0,
    total: list.length,
    file: "",
    results: [],
    startedAt: new Date().toISOString(),
    finishedAt: null,
  };
  emit();

  // 呼び出し元の画面がアンマウントされても、このモジュール内のPromiseチェーンは継続する。
  (async () => {
    const rows = [];
    for (let i = 0; i < list.length; i++) {
      const f = list[i];
      state = { ...state, current: i + 1, file: f.name, results: [...rows] };
      emit();
      try {
        const parsed = parseBoatraceFile(await f.arrayBuffer(), f.name);
        if (!parsed.ok) throw new Error(parsed.errors?.join(" / ") || "解析失敗");
        if (parsed.data.type !== "K") throw new Error(`Kファイルではありません (${parsed.data.type})`);
        const r = await saveBoatraceData("K", parsed.data, f.name);
        const d = r?.data || {};
        rows.push({
          file: f.name,
          ok: d.ok !== false && !d.errors,
          created: d.created || 0,
          updated: d.updated || 0,
          skipped: d.skipped || 0,
          errors: d.errors || 0,
          rejected_corrupt: d.rejected_corrupt || 0,
          parsed_entries: d.parsed_entries || 0,
          history_verified: d.history_verified || 0,
          history_target: d.history_target || 0,
          message: d.message || "完了",
        });
      } catch (e) {
        rows.push({
          file: f.name,
          ok: false,
          created: 0,
          updated: 0,
          skipped: 0,
          errors: 1,
          rejected_corrupt: 0,
          parsed_entries: 0,
          history_verified: 0,
          history_target: 0,
          message: e?.response?.data?.error || e?.message || "取込失敗",
        });
      }
      state = { ...state, results: [...rows] };
      emit();

      if (i < list.length - 1) {
        await new Promise((resolve) => setTimeout(resolve, 3000));
      }
    }

    state = {
      ...state,
      running: false,
      file: "",
      results: [...rows],
      finishedAt: new Date().toISOString(),
    };
    emit();
  })();

  return getKBatchImportState();
}
