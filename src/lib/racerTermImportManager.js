// 選手期別成績 一括取込マネージャー
// 解析済みデータをサーバーへ預け、サーバー側ジョブで100件ずつ処理する。
// 画面遷移・コンポーネント破棄・再読込後もジョブ状態から再開できる。
import { base44 } from "@/api/base44Client";
import { detectTermFromFilename } from "@/lib/racerTermParser";

const STATE_KEY = "boatworks2_racer_term_server_batch_v2";
const listeners = new Set();
let runnerPromise = null;

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
function snapshot() {
  return { ...state, results: [...(state.results || [])] };
}
function emit() {
  persist();
  const s = snapshot();
  for (const fn of listeners) { try { fn(s); } catch {} }
}

export function getRacerTermImportState() { return snapshot(); }
export function subscribeRacerTermImport(fn) {
  listeners.add(fn); fn(snapshot());
  return () => listeners.delete(fn);
}

async function refreshJob() {
  if (!state.batchId) return;
  try {
    const [jobs, items] = await Promise.all([
      base44.entities.RacerTermImportJob.filter({ batch_id: state.batchId }, "-created_date", 5),
      base44.entities.RacerTermImportItem.filter({ batch_id: state.batchId }, "order_index", 500),
    ]);
    const job = jobs?.[0];
    if (!job) return;
    const ordered = [...(items || [])].sort((a,b) => Number(a.order_index || 0) - Number(b.order_index || 0));
    const rows = ordered.filter(x => ["success","failed"].includes(x.status)).map(x => ({
      file: x.file_name,
      ok: x.status === "success",
      created: Number(x.created_count || 0),
      updated: Number(x.updated_count || 0),
      errors: Number(x.error_count || 0),
      total: Number(x.total_records || 0),
      error: x.status === "failed" ? (x.message || "取込失敗") : undefined,
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
          await base44.functions.invoke("processRacerTermBatchJobStep", { batch_id: state.batchId });
        } catch {
          // 画面遷移や504でレスポンスが切れても、サーバー側の状態を再取得して続行する。
        }
        await refreshJob();
        if (!state.running) break;
        await new Promise(r => setTimeout(r, 800));
      }
    } finally {
      runnerPromise = null;
    }
  })();
  return runnerPromise;
}

export async function startRacerTermImport(previews) {
  const items = Array.from(previews || []).filter(p => p?.data?.records?.length && p?.file?.name);
  if (!items.length) throw new Error("取込対象の期別成績ファイルがありません");

  // localStorageに古いrunning状態が残っていて新規開始を邪魔しないよう、
  // 既存batchがあれば先にサーバー状態を再確認する。
  if (state.batchId) {
    await refreshJob();
  }
  if (state.running || state.uploading) {
    throw new Error(`すでに期別成績の取込が実行中です${state.file ? `: ${state.file}` : ""}`);
  }

  // 登録ボタンを押した瞬間から全画面バナーを表示する。
  state = {
    ...emptyState(),
    running: true,
    uploading: true,
    uploadCurrent: 0,
    uploadTotal: items.length,
    total: items.length,
    file: items[0]?.file?.name || "",
    startedAt: new Date().toISOString(),
  };
  emit();

  try {
    // 先にサーバージョブを作る。これによりアップロード中でも全画面に進捗を出せる。
    const shellResp = await base44.functions.invoke("startRacerTermBatchJob", {
      items: items.map((p) => ({
        file_name: p.file.name,
        payload_url: "",
        total_records: p.data.records.length,
      })),
    });
    const shell = shellResp?.data || {};
    if (!shell.ok || !shell.batch_id) throw new Error(shell.error || "期別成績ジョブを開始できませんでした");

    state = {
      ...state,
      batchId: shell.batch_id,
      running: true,
      uploading: true,
      current: 0,
      total: shell.total_files || items.length,
      file: items[0]?.file?.name || "",
      results: [],
    };
    emit();

    for (let i = 0; i < items.length; i++) {
      const p = items[i];
      state = { ...state, uploadCurrent: i + 1, file: p.file.name };
      emit();
      const detected = detectTermFromFilename(p.file.name);
      const termOverride = detected ? { term_year: detected.term_year, term_half: detected.term_half } : null;
      const payload = {
        records: p.data.records,
        term_override: termOverride,
      };
      const payloadFile = new File([JSON.stringify(payload)], `${p.file.name}.parsed.json`, { type: "application/json" });
      const up = await base44.integrations.Core.UploadFile({ file: payloadFile });
      if (!up?.file_url) throw new Error(`${p.file.name}: サーバーへの一時保存に失敗しました`);

      const attachResp = await base44.functions.invoke("attachRacerTermBatchPayload", {
        batch_id: shell.batch_id,
        file_name: p.file.name,
        payload_url: up.file_url,
      });
      if (attachResp?.data?.ok === false) throw new Error(attachResp?.data?.error || `${p.file.name}: ジョブ登録に失敗しました`);

      // 1件目がアップロードできた時点で取込処理を開始。残りのアップロードと並行して進める。
      runServerSteps();
    }

    state = { ...state, uploading: false };
    emit();
    runServerSteps();
    return snapshot();
  } catch (e) {
    state = { ...state, uploading: false, running: false, file: "" };
    emit();
    throw e;
  }
}

export function resumeRacerTermImport() {
  state = loadState();
  emit();
  (async () => {
    if (state.batchId) await refreshJob();
    if (state.running) runServerSteps();
  })();
  return snapshot();
}
