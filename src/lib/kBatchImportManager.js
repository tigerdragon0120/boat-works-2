// K過去結果 一括取込マネージャー
// 取込本体はサーバー側ジョブで1ファイルずつ処理する。
// ブラウザ側は、解析済みKデータをアップロードしてジョブ開始→進捗監視だけを担当する。
import { base44 } from "@/api/base44Client";
import { parseBoatraceFile } from "@/lib/boatraceFileParser";

const STATE_KEY = "boatworks2_k_server_batch_v1";
const listeners = new Set();
let runnerPromise = null;
let pollTimer = null;

const emptyState = () => ({
  running: false,
  batchId: "",
  current: 0,
  total: 0,
  file: "",
  results: [],
  uploading: false,
  uploadCurrent: 0,
  uploadTotal: 0,
  startedAt: null,
  finishedAt: null,
});

function loadState() {
  try {
    const raw = localStorage.getItem(STATE_KEY);
    return raw ? { ...emptyState(), ...JSON.parse(raw) } : emptyState();
  } catch { return emptyState(); }
}

let state = typeof window !== "undefined" ? loadState() : emptyState();

function persist() {
  try { localStorage.setItem(STATE_KEY, JSON.stringify(state)); } catch {}
}
function emit() {
  persist();
  const snap = { ...state, results: [...(state.results || [])] };
  for (const fn of listeners) { try { fn(snap); } catch {} }
}

export function getKBatchImportState() {
  return { ...state, results: [...(state.results || [])] };
}
export function subscribeKBatchImport(fn) {
  listeners.add(fn); fn(getKBatchImportState());
  return () => listeners.delete(fn);
}

async function refreshJob() {
  if (!state.batchId) return;
  try {
    const [jobs, items] = await Promise.all([
      base44.entities.KBatchImportJob.filter({ batch_id: state.batchId }, "-created_date", 5),
      base44.entities.KBatchImportItem.filter({ batch_id: state.batchId }, "order_index", 500),
    ]);
    const job = jobs?.[0];
    if (!job) return;
    const ordered = [...(items || [])].sort((a,b) => Number(a.order_index || 0) - Number(b.order_index || 0));
    const rows = ordered.filter(x => ["success","failed"].includes(x.status)).map(x => ({
      file: x.file_name,
      ok: x.status === "success",
      created: x.created_count || 0,
      updated: x.updated_count || 0,
      skipped: x.skipped_count || 0,
      errors: x.error_count || 0,
      rejected_corrupt: x.rejected_corrupt || 0,
      history_verified: x.history_verified || 0,
      history_target: x.history_target || 0,
      message: x.message || "",
    }));
    state = {
      ...state,
      running: job.status !== "completed",
      current: Number(job.current_index || 0),
      total: Number(job.total_files || ordered.length || state.total || 0),
      file: job.current_file || "",
      results: rows,
      finishedAt: job.finished_at || null,
    };
    emit();
  } catch {}
}

async function runServerSteps() {
  if (runnerPromise || !state.batchId || !state.running) return runnerPromise;
  runnerPromise = (async () => {
    try {
      while (state.batchId && state.running) {
        try {
          await base44.functions.invoke("processKBatchJobStep", { batch_id: state.batchId });
        } catch {
          // 画面遷移などでレスポンスが切れても、サーバー側処理が完了している場合がある。
          // 状態を再読込して次のステップへ進む。
        }
        await refreshJob();
        if (!state.running) break;
        await new Promise(r => setTimeout(r, 1200));
      }
    } finally {
      runnerPromise = null;
    }
  })();
  return runnerPromise;
}

export async function startKBatchImport(files) {
  const list = Array.from(files || []).filter(f => /\.txt$/i.test(f?.name || ""));
  if (!list.length) throw new Error("Kファイルが選択されていません");
  if (state.running || state.uploading) return getKBatchImportState();

  state = {
    ...emptyState(),
    uploading: true,
    uploadCurrent: 0,
    uploadTotal: list.length,
    total: list.length,
    startedAt: new Date().toISOString(),
  };
  emit();

  const uploaded = [];
  try {
    for (let i = 0; i < list.length; i++) {
      const f = list[i];
      state = { ...state, uploadCurrent: i + 1, file: f.name };
      emit();
      const parsed = parseBoatraceFile(await f.arrayBuffer(), f.name);
      if (!parsed.ok) throw new Error(`${f.name}: ${parsed.errors?.join(" / ") || "解析失敗"}`);
      if (parsed.data.type !== "K") throw new Error(`${f.name}: Kファイルではありません`);

      const payloadFile = new File(
        [JSON.stringify(parsed.data)],
        `${f.name}.parsed.json`,
        { type: "application/json" }
      );
      const up = await base44.integrations.Core.UploadFile({ file: payloadFile });
      if (!up?.file_url) throw new Error(`${f.name}: サーバーへの一時保存に失敗しました`);
      uploaded.push({ file_name: f.name, payload_url: up.file_url });
    }

    const startResp = await base44.functions.invoke("startKBatchJob", { items: uploaded });
    const d = startResp?.data || {};
    if (!d.ok || !d.batch_id) throw new Error(d.error || "K一括取込ジョブを開始できませんでした");

    state = {
      ...state,
      uploading: false,
      running: true,
      batchId: d.batch_id,
      current: 0,
      total: d.total_files || list.length,
      file: "",
      results: [],
    };
    emit();
    runServerSteps();
    return getKBatchImportState();
  } catch (e) {
    state = { ...state, uploading: false, running: false, file: "" };
    emit();
    throw e;
  }
}

export function resumeKBatchImport() {
  state = loadState();
  emit();
  if (pollTimer) clearTimeout(pollTimer);
  const resume = async () => {
    if (state.batchId) await refreshJob();
    if (state.running) runServerSteps();
  };
  resume();
  return getKBatchImportState();
}
