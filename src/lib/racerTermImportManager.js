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
    const active = ["queued", "preparing", "running"].includes(job.status);
    state = {
      ...state,
      running: active,
      uploading: job.status === "preparing",
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

  // 新規開始判定はブラウザの古いstateではなく、必ずサーバー側の最新ジョブを基準にする。
  try {
    const latestJobs = await base44.entities.RacerTermImportJob.filter({}, "-created_date", 1);
    const latest = latestJobs?.[0];
    const active = latest && ["queued", "preparing", "running"].includes(latest.status);
    if (active) {
      state = {
        ...state,
        running: true,
        uploading: latest.status === "preparing",
        batchId: latest.batch_id || "",
        current: Number(latest.current_index || 0),
        total: Number(latest.total_files || 0),
        file: latest.current_file || state.file || "",
      };
      emit();
      throw new Error(`すでに期別成績の取込が実行中です${state.file ? `: ${state.file}` : ""}`);
    }

    // 最新ジョブがcompletedなら、localStorageに残った古いrunning/uploadingを強制クリアする。
    state = {
      ...state,
      running: false,
      uploading: false,
      batchId: "",
      current: 0,
      total: 0,
      file: "",
    };
    emit();
  } catch (e) {
    // 「実行中」エラーはそのまま返す。通信失敗だけは既存batchを再確認して安全側に倒す。
    if (String(e?.message || e).includes("すでに期別成績の取込が実行中です")) throw e;
    if (state.batchId) await refreshJob();
    if (state.running || state.uploading) {
      throw new Error(`すでに期別成績の取込が実行中です${state.file ? `: ${state.file}` : ""}`);
    }
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

    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const uploadErrors = [];

    for (let i = 0; i < items.length; i++) {
      const p = items[i];
      state = { ...state, uploadCurrent: i + 1, file: p.file.name };
      emit();

      const detected = detectTermFromFilename(p.file.name);
      const termOverride = detected ? { term_year: detected.term_year, term_half: detected.term_half } : null;
      const payload = { records: p.data.records, term_override: termOverride };
      const payloadFile = new File([JSON.stringify(payload)], `${p.file.name}.parsed.json`, { type: "application/json" });

      let attached = false;
      let lastError = null;
      for (let attempt = 1; attempt <= 5 && !attached; attempt++) {
        try {
          const up = await base44.integrations.Core.UploadFile({ file: payloadFile });
          if (!up?.file_url) throw new Error("サーバーへの一時保存に失敗しました");

          const attachResp = await base44.functions.invoke("attachRacerTermBatchPayload", {
            batch_id: shell.batch_id,
            file_name: p.file.name,
            payload_url: up.file_url,
          });
          if (attachResp?.data?.ok === false) throw new Error(attachResp?.data?.error || "ジョブ登録に失敗しました");
          attached = true;
        } catch (e) {
          lastError = e;
          if (attempt < 5) await sleep(Math.min(8000, 800 * (2 ** (attempt - 1))));
        }
      }

      if (!attached) {
        const msg = lastError?.message || String(lastError || "アップロード失敗");
        uploadErrors.push(`${p.file.name}: ${msg}`);
        try {
          await base44.functions.invoke("failRacerTermBatchUpload", {
            batch_id: shell.batch_id,
            file_name: p.file.name,
            message: msg,
          });
        } catch {}
      }

      // アップロード成功済みのファイルは順次処理。1ファイル失敗しても残りは止めない。
      runServerSteps();
    }

    if (uploadErrors.length) {
      state = {
        ...state,
        results: [
          ...(state.results || []),
          ...uploadErrors.map(error => ({ file: "アップロード", ok: false, error })),
        ],
      };
    }

    state = { ...state, uploading: false };
    emit();
    runServerSteps();
    return snapshot();
  } catch (e) {
    // ジョブ作成前の致命的エラーだけ停止扱いにする。
    // ジョブ作成後の個別ファイル障害は上でfailed化して残りを継続する。
    state = { ...state, uploading: false, running: !!state.batchId, file: state.file || "" };
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
