import React, { useState, useEffect, useCallback } from "react";
import { getAutoUpdateStatus, runAutoUpdateStep } from "@/lib/dataManagementService";
import { RefreshCw, Calendar, CheckCircle2, AlertTriangle, Loader2, Clock, Zap, Download, Flag, BarChart3, CloudDownload } from "lucide-react";
import { cn } from "@/lib/utils";

export default function AutoUpdateSection() {
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(null);
  const [result, setResult] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await getAutoUpdateStatus();
      setStatus(r.data);
    } catch (e) {
      setStatus(null);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
    const interval = setInterval(load, 30000);
    return () => clearInterval(interval);
  }, [load]);

  const handleStep = async (step) => {
    setBusy(step);
    setResult(null);
    try {
      const r = await runAutoUpdateStep(step);
      setResult(r.data);
      setTimeout(load, 2000);
    } catch (e) {
      setResult({ ok: false, error: e?.response?.data?.error || e.message });
    }
    setBusy(null);
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="w-6 h-6 animate-spin text-sky-600" />
      </div>
    );
  }

  const s = status || {};
  const statusColor = {
    success: "text-emerald-600 bg-emerald-50 border-emerald-200",
    running: "text-sky-600 bg-sky-50 border-sky-200",
    partial: "text-amber-600 bg-amber-50 border-amber-200",
    error: "text-rose-600 bg-rose-50 border-rose-200",
    idle: "text-slate-600 bg-slate-50 border-slate-200",
    waiting: "text-sky-600 bg-sky-50 border-sky-200",
    retrying: "text-amber-600 bg-amber-50 border-amber-200",
  };
  const statusLabel = {
    success: "正常",
    running: "取得中",
    partial: "一部不足",
    error: "エラー",
    idle: "待機",
    waiting: "待機",
    retrying: "再試行中",
  };
  const currentStatus = s.status || "idle";

  return (
    <div className="space-y-4">
      {/* ヘッダー */}
      <div className="flex items-center gap-2">
        <RefreshCw className="w-5 h-5 text-sky-600" />
        <h2 className="text-lg font-bold text-slate-900">自動データ更新</h2>
        <span className="px-2 py-0.5 rounded-full bg-sky-100 text-sky-700 text-[10px] font-bold">30分毎自動実行</span>
      </div>
      <p className="text-xs text-slate-500">boatrace.jp公式サイトから毎日自動取得。番組表・結果・展示・PRE予想を自動処理。AI不使用・決定論的解析。</p>

      {/* ステータスバー */}
      <div className={cn("rounded-xl border p-3 flex items-center justify-between", statusColor[currentStatus])}>
        <div className="flex items-center gap-2">
          {currentStatus === "success" ? <CheckCircle2 className="w-5 h-5" /> :
           currentStatus === "error" ? <AlertTriangle className="w-5 h-5" /> :
           <Clock className="w-5 h-5" />}
          <span className="font-bold text-sm">{statusLabel[currentStatus] || currentStatus}</span>
          {s.current_step && <span className="text-xs opacity-70">({s.current_step})</span>}
        </div>
        <div className="text-xs text-right">
          <div>最終更新: {s.last_updated ? new Date(s.last_updated).toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "—"}</div>
          <div className="opacity-60">JST {s.jst_time || ""}</div>
        </div>
      </div>

      {/* 本日データ */}
      <div className="bg-white rounded-xl border border-slate-200 p-4 space-y-3">
        <div className="flex items-center gap-2">
          <Calendar className="w-4 h-4 text-sky-600" />
          <h3 className="text-sm font-bold text-slate-800">本日 {s.today || "—"}</h3>
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          <StatBox label="開催場" value={s.today_venues || 0} sub={`${(s.today_venue_codes || []).length}場`} color="sky" />
          <StatBox label="Race数" value={s.today_races || 0} sub={`${s.today_entries || 0}艇`} color="slate" />
          <StatBox label="結果取得" value={s.today_results || 0} sub={`/ ${s.today_races || 0}R`} color={s.today_results === s.today_races && s.today_races > 0 ? "emerald" : "amber"} />
          <StatBox label="PRE予想" value={s.today_pre || 0} sub={`/ ${s.today_races || 0}R`} color={s.today_pre === s.today_races && s.today_races > 0 ? "emerald" : "amber"} />
        </div>
        <div className="flex items-center gap-2 text-xs">
          <CloudDownload className="w-3.5 h-3.5 text-amber-500" />
          <span className="text-slate-600">展示データ取得済み: <span className="font-bold">{s.today_exhibition || 0}</span> / {s.today_races || 0}R</span>
        </div>
      </div>

      {/* 翌日データ */}
      <div className="bg-white rounded-xl border border-slate-200 p-4 space-y-3">
        <div className="flex items-center gap-2">
          <Calendar className="w-4 h-4 text-emerald-600" />
          <h3 className="text-sm font-bold text-slate-800">翌日 {s.tomorrow || "—"}</h3>
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          <StatBox label="開催場" value={s.tomorrow_venues || 0} sub={`${(s.tomorrow_venue_codes || []).length}場`} color="emerald" />
          <StatBox label="Race数" value={s.tomorrow_races || 0} sub={`${s.tomorrow_entries || 0}艇`} color="slate" />
          <StatBox label="PRE予想" value={s.tomorrow_pre || 0} sub={`/ ${s.tomorrow_races || 0}R`} color={s.tomorrow_pre === s.tomorrow_races && s.tomorrow_races > 0 ? "emerald" : "amber"} />
          <StatBox label="不足Race" value={s.tomorrow_incomplete || 0} sub={s.tomorrow_incomplete > 0 ? "要再取得" : "完璧"} color={s.tomorrow_incomplete > 0 ? "rose" : "emerald"} />
        </div>
      </div>

      {/* 手動復旧ボタン */}
      <div className="bg-white rounded-xl border border-slate-200 p-4 space-y-3">
        <div className="flex items-center gap-2">
          <Zap className="w-4 h-4 text-amber-500" />
          <h3 className="text-sm font-bold text-slate-800">手動復旧ボタン</h3>
        </div>
        <p className="text-[11px] text-slate-500">通常運用では不要。自動取得が失敗した場合のみ手動実行。</p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          <ActionButton icon={Download} label="今日の番組を再取得" step="today_card" busy={busy === "today_card"} onClick={handleStep} />
          <ActionButton icon={Flag} label="今日の不足結果だけ取得" step="today_results" busy={busy === "today_results"} onClick={handleStep} />
          <ActionButton icon={Download} label="明日の番組を再取得" step="tomorrow_card" busy={busy === "tomorrow_card"} onClick={handleStep} />
          <ActionButton icon={BarChart3} label="不足PREを生成" step="pre_predictions" busy={busy === "pre_predictions"} onClick={handleStep} />
          <ActionButton icon={CloudDownload} label="展示データ取得" step="exhibition" busy={busy === "exhibition"} onClick={handleStep} />
          <ActionButton icon={CheckCircle2} label="完全性チェック" step="completeness" busy={busy === "completeness"} onClick={handleStep} />
        </div>
      </div>

      {/* 実行結果 */}
      {result && (
        <div className={cn("rounded-xl border p-3 space-y-2", result.ok === false ? "bg-rose-50 border-rose-200" : "bg-emerald-50 border-emerald-200")}>
          <div className={cn("flex items-center gap-1.5 text-sm font-bold", result.ok === false ? "text-rose-700" : "text-emerald-700")}>
            {result.ok === false ? <AlertTriangle className="w-4 h-4" /> : <CheckCircle2 className="w-4 h-4" />}
            {result.ok === false ? "エラー" : "実行完了"}
          </div>
          {result.logs?.length > 0 && (
            <div className="max-h-40 overflow-y-auto bg-white rounded-lg p-2 space-y-0.5">
              {result.logs.slice(-15).map((log, i) => (
                <div key={i} className="text-[10px] text-slate-600 font-mono">{log}</div>
              ))}
            </div>
          )}
          {result.errors?.length > 0 && (
            <div className="max-h-32 overflow-y-auto space-y-0.5">
              {result.errors.slice(0, 10).map((e, i) => (
                <div key={i} className="text-[10px] text-rose-700">⚠ {e}</div>
              ))}
            </div>
          )}
          {result.error && <div className="text-xs text-rose-700">{result.error}</div>}
        </div>
      )}

      {/* エラー一覧 */}
      {s.errors?.length > 0 && !result && (
        <div className="bg-rose-50 border border-rose-200 rounded-xl p-3">
          <div className="text-xs font-bold text-rose-700 mb-1">直近エラー({s.errors.length}件)</div>
          <div className="max-h-24 overflow-y-auto space-y-0.5">
            {s.errors.slice(0, 10).map((e, i) => (
              <div key={i} className="text-[10px] text-rose-700">{e}</div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function StatBox({ label, value, sub, color }) {
  const colorMap = {
    sky: "bg-sky-50 text-sky-700 border-sky-200",
    emerald: "bg-emerald-50 text-emerald-700 border-emerald-200",
    amber: "bg-amber-50 text-amber-700 border-amber-200",
    rose: "bg-rose-50 text-rose-700 border-rose-200",
    slate: "bg-slate-50 text-slate-700 border-slate-200",
  };
  return (
    <div className={cn("rounded-lg border p-2 text-center", colorMap[color] || colorMap.slate)}>
      <div className="font-bold text-lg">{value}</div>
      <div className="text-[10px] opacity-80">{label}</div>
      {sub && <div className="text-[9px] opacity-60">{sub}</div>}
    </div>
  );
}

function ActionButton({ icon: Icon, label, step, busy, onClick }) {
  return (
    <button
      onClick={() => onClick(step)}
      disabled={busy}
      className="h-10 rounded-lg bg-slate-900 text-white text-xs font-semibold flex items-center justify-center gap-1.5 hover:bg-slate-800 disabled:opacity-40"
    >
      {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Icon className="w-3.5 h-3.5" />}
      {label}
    </button>
  );
}