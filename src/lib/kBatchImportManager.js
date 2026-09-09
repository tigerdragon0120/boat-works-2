// K過去結果の永続バックグラウンド一括取込マネージャー
// 選択したKファイル本体をIndexedDBへ保存し、進捗をlocalStorageへ保存する。
// これにより管理タブのアンマウント、アプリ内画面遷移、ページ再読込後でも残りから再開できる。
import { parseBoatraceFile } from "@/lib/boatraceFileParser";
import { saveBoatraceData } from "@/lib/dataManagementService";

const STATE_KEY = "boatworks2_k_batch_state_v2";
const DB_NAME = "boatworks2_k_batch_files";
const STORE_NAME = "files";
let workerPromise = null;
const listeners = new Set();

const emptyState = () => ({
  running: false,
  current: 0,
  nextIndex: 0,
  total: 0,
  file: "",
  queue: [],
  results: [],
  startedAt: null,
  finishedAt: null,
});

function loadState() {
  try {
    const raw = localStorage.getItem(STATE_KEY);
    return raw ? { ...emptyState(), ...JSON.parse(raw) } : emptyState();
  } catch {
    return emptyState();
  }
}

let state = typeof window !== "undefined" ? loadState() : emptyState();

function persist() {
  try { localStorage.setItem(STATE_KEY, JSON.stringify(state)); } catch {}
}

function emit() {
  persist();
  const snapshot = { ...state, queue: [...(state.queue || [])], results: [...(state.results || [])] };
  for (const fn of listeners) {
    try { fn(snapshot); } catch {}
  }
}

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME, { keyPath: "key" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error("IndexedDBを開けませんでした"));
  });
}

async function putFile(key, file) {
  const db = await openDb();
  try {
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      tx.objectStore(STORE_NAME).put({ key, name: file.name, type: file.type, lastModified: file.lastModified, blob: file });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error || new Error("Kファイル保存失敗"));
    });
  } finally { db.close(); }
}

async function getStoredFile(key) {
  const db = await openDb();
  try {
    const row = await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readonly");
      const req = tx.objectStore(STORE_NAME).get(key);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error || new Error("Kファイル読込失敗"));
    });
    if (!row?.blob) return null;
    return new File([row.blob], row.name, { type: row.type || "text/plain", lastModified: row.lastModified || Date.now() });
  } finally { db.close(); }
}

async function deleteStoredFile(key) {
  const db = await openDb();
  try {
    await new Promise((resolve) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      tx.objectStore(STORE_NAME).delete(key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
  } finally { db.close(); }
}

export function getKBatchImportState() {
  return { ...state, queue: [...(state.queue || [])], results: [...(state.results || [])] };
}

export function subscribeKBatchImport(fn) {
  listeners.add(fn);
  fn(getKBatchImportState());
  return () => listeners.delete(fn);
}

async function runQueue() {
  if (workerPromise) return workerPromise;
  workerPromise = (async () => {
    const rows = [...(state.results || [])];
    try {
      while (state.running && state.nextIndex < state.total) {
        const i = state.nextIndex;
        const item = state.queue[i];
        state = { ...state, current: i + 1, file: item?.name || "" };
        emit();

        try {
          const f = item ? await getStoredFile(item.key) : null;
          if (!f) throw new Error("保存済みKファイルを復元できませんでした");
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
          rows.push({ file: item?.name || `#${i + 1}`, ok: false, created: 0, updated: 0, skipped: 0, errors: 1, rejected_corrupt: 0, parsed_entries: 0, history_verified: 0, history_target: 0, message: e?.response?.data?.error || e?.message || "取込失敗" });
        }

        if (item?.key) await deleteStoredFile(item.key);
        state = { ...state, nextIndex: i + 1, results: [...rows] };
        emit();
        if (state.nextIndex < state.total) await new Promise((resolve) => setTimeout(resolve, 1500));
      }

      if (state.nextIndex >= state.total) {
        state = { ...state, running: false, file: "", current: state.total, results: [...rows], finishedAt: new Date().toISOString() };
        emit();
      }
    } finally {
      workerPromise = null;
    }
    return getKBatchImportState();
  })();
  return workerPromise;
}

export async function startKBatchImport(files) {
  const list = Array.from(files || []).filter((f) => /\.txt$/i.test(f?.name || ""));
  if (!list.length) throw new Error("Kファイルが選択されていません");
  if (state.running) return getKBatchImportState();

  const batchId = `${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const queue = [];
  for (let i = 0; i < list.length; i++) {
    const key = `${batchId}_${i}`;
    await putFile(key, list[i]);
    queue.push({ key, name: list[i].name });
  }

  state = { running: true, current: 0, nextIndex: 0, total: queue.length, file: "", queue, results: [], startedAt: new Date().toISOString(), finishedAt: null };
  emit();
  runQueue();
  return getKBatchImportState();
}

// Layoutなどアプリ常駐部分から呼ぶ。再読込後にrunning状態が残っていれば自動再開する。
export function resumeKBatchImport() {
  state = loadState();
  emit();
  if (state.running && state.nextIndex < state.total) runQueue();
  return getKBatchImportState();
}
