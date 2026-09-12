import React, { useState, useEffect, useCallback } from "react";
import { getDashboardData, generateMissingPrePredictions, getCleanupMonitorStatus } from "@/lib/dataManagementService";
import { RefreshCw, Database, Clock, TrendingUp, AlertTriangle, CheckCircle2, Zap, ShieldCheck } from "lucide-react";
import { cn } from "@/lib/utils";

export default function DataDashboard() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [preRunning, setPreRunning] = useState(false);
  const [preProgress, setPreProgress] = useState(null);
  const [preMessage, setPreMessage] = useState("");
  const [monitor, setMonitor] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [d, m] = await Promise.all([
        getDashboardData(),
        getCleanupMonitorStatus().catch(() => null),
      ]);
      setData(d);
      setMonitor(m?.data || m || null);
    } catch {}
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const runMissingPre = async () => {
    if (!data || preRunning) return;
    setPreRunning(true);
    setPreProgress(null);
    setPreMessage("");
    try {
      const r = await generateMissingPrePredictions(data.date, setPreProgress);
      setPreMessage(r.errors > 0
        ? `PRE生成: ${r.generated}件 / エラー${r.errors}件`
        : `PRE生成完了: ${r.generated}件`);
      await load();
    } catch (e) {
      setPreMessage(`PRE生成失敗: ${e.message}`);
    }
    setPreRunning(false);
  };

  if (loading && !data) return <div className="text-center py-6 text-slate-400 text-sm">読み込み中…</div>;
  if (!data) return <div className="text-center py-6 text-slate-400 text-sm">データがありません</div>;

  const stats = [
    { label: "開催場", v: data.venues, tone: "text-sky-600", bg: "bg-sky-50" },
    { label: "Race", v: data.totalRaces, tone: "text-slate-900", bg: "bg-slate-50" },
    { label: "RaceEntry", v: `${data.totalEntries}/${data.expectedEntries}`, tone: data.totalEntries === data.expectedEntries ? "text-emerald-600" : "text-amber-600", bg: "bg-slate-50" },
    { label: "展示取得済", v: `${data.exhibitionReady}/${data.totalRaces}`, tone: data.exhibitionReady > 0 ? "text-amber-600" : "text-slate-400", bg: "bg-amber-50" },
    { label: "オッズ取得済", v: `${data.oddsReady}/${data.totalRaces}`, tone: data.oddsReady > 0 ? "text-purple-600" : "text-slate-400", bg: "bg-purple-50" },
    { label: "結果確定", v: `${data.finished}/${data.totalRaces}`, tone: data.finished > 0 ? "text-emerald-600" : "text-slate-400", bg: "bg-emerald-50" },
    { label: "予想生成済", v: `${data.hasPre}/${data.totalRaces}`, tone: data.hasPre > 0 ? "text-sky-600" : "text-slate-400", bg: "bg-sky-50" },
    { label: "BUY", v: data.buyCount, tone: data.buyCount > 0 ? "text-emerald-600" : "text-slate-400", bg: "bg-emerald-50" },
    { label: "WATCH", v: data.watchCount, tone: data.watchCount > 0 ? "text-amber-600" : "text-slate-400", bg: "bg-amber-50" },
    { label: "SKIP", v: data.skipCount, tone: "text-slate-500", bg: "bg-slate-50" },
    { label: "エラー", v: data.fetchErrors, tone: data.fetchErrors > 0 ? "text-rose-600" : "text-slate-400", bg: data.fetchErrors > 0 ? "bg-rose-50" : "bg-slate-50" },
  ];

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Database className="w-4 h-4 text-sky-600" />
          <h3 className="font-bold text-sm text-slate-900">今日の状態 ({data.date})</h3>
        </div>
        <div className="flex items-center gap-2">
          {data.hasPre < data.totalRaces && (
            <button
              onClick={runMissingPre}
              disabled={preRunning}
              className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-sky-600 text-white text-[11px] font-bold disabled:opacity-50"
            >
              <Zap className={cn("w-3.5 h-3.5", preRunning && "animate-pulse")} />
              {preRunning ? "不足PRE生成中" : "不足PREを生成"}
            </button>
          )}
          <button onClick={load} className="p-1.5 rounded-lg hover:bg-slate-100">
            <RefreshCw className={cn("w-4 h-4 text-slate-500", loading && "animate-spin")} />
          </button>
        </div>
      </div>

      {(preRunning || preMessage) && (
        <div className={cn(
          "rounded-lg px-3 py-2 text-[11px] font-medium",
          preMessage.includes("失敗") || preMessage.includes("エラー") ? "bg-rose-50 text-rose-700" : "bg-sky-50 text-sky-700"
        )}>
          {preRunning && preProgress
            ? `PRE予想生成中: ${preProgress.completed}/${preProgress.total}（残り${preProgress.remaining}）`
            : preMessage}
        </div>
      )}

      {/* ステータスグリッド */}
      <div className="grid grid-cols-3 sm:grid-cols-4 lg:grid-cols-6 gap-2">
        {stats.map((s) => (
          <div key={s.label} className={cn("rounded-xl p-2.5 text-center", s.bg)}>
            <div className={cn("font-display font-bold text-xl leading-none", s.tone)}>{s.v}</div>
            <div className="text-[10px] text-slate-500 mt-1">{s.label}</div>
          </div>
        ))}
      </div>

      {/* 最近の取込履歴 */}
      <div className="grid sm:grid-cols-2 gap-3">
        <div className="bg-white rounded-xl border border-slate-100 p-3">
          <div className="flex items-center gap-1.5 mb-2">
            <TrendingUp className="w-3.5 h-3.5 text-sky-600" />
            <span className="text-xs font-bold text-slate-700">最近のファイル取込</span>
          </div>
          {data.recentImports.length === 0 ? (
            <div className="text-[11px] text-slate-400 py-2">取込履歴なし</div>
          ) : (
            <div className="space-y-1">
              {data.recentImports.map((log) => (
                <div key={log.id} className="flex items-center gap-2 text-[11px]">
                  <span className={cn("px-1.5 h-5 rounded text-[9px] font-bold flex items-center",
                    log.status === "success" ? "bg-emerald-100 text-emerald-700" :
                    log.status === "partial" ? "bg-amber-100 text-amber-700" :
                    log.status === "failed" ? "bg-rose-100 text-rose-700" : "bg-slate-100 text-slate-500"
                  )}>{log.status === "success" ? <CheckCircle2 className="w-3 h-3" /> : log.status === "failed" ? <AlertTriangle className="w-3 h-3" /> : null}{log.import_type}</span>
                  <span className="text-slate-600 truncate flex-1">{log.file_name}</span>
                  <span className="text-slate-400 shrink-0">新{log.created_count} / 更{log.updated_count}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="bg-white rounded-xl border border-slate-100 p-3">
          <div className="flex items-center gap-1.5 mb-2">
            <Clock className="w-3.5 h-3.5 text-sky-600" />
            <span className="text-xs font-bold text-slate-700">最近のオンライン取得</span>
          </div>
          {data.recentFetchLogs.length === 0 ? (
            <div className="text-[11px] text-slate-400 py-2">取得履歴なし</div>
          ) : (
            <div className="space-y-1 max-h-32 overflow-y-auto">
              {data.recentFetchLogs.map((log) => (
                <div key={log.id} className="flex items-center gap-2 text-[11px]">
                  <span className={cn("px-1.5 h-5 rounded text-[9px] font-bold flex items-center",
                    log.status === "success" ? "bg-emerald-100 text-emerald-700" :
                    log.status === "failed" ? "bg-rose-100 text-rose-700" :
                    log.status === "skipped" ? "bg-slate-100 text-slate-500" : "bg-amber-100 text-amber-700"
                  )}>{log.fetch_type}</span>
                  <span className="text-slate-600">{log.venue_code} {log.race_number}R</span>
                  <span className={cn("text-[10px]", log.status === "success" ? "text-emerald-600" : log.status === "failed" ? "text-rose-500" : "text-slate-400")}>{log.status}</span>
                  <span className="text-slate-400 ml-auto">{log.fetched_at ? new Date(log.fetched_at).toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" }) : ""}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* クリーンアップ監視パネル(第6段階) */}
      {monitor && (
        <CleanupMonitorPanel monitor={monitor} />
      )}
    </div>
  );
}

// ============================================================
// クリーンアップ監視パネル
// Race/RaceEntry/FINAL/RESULT重複・CONFLICT・MISSING逆戻りを監視
// ============================================================
function CleanupMonitorPanel({ monitor }) {
  const m = monitor || {};
  const anomalies = m.anomalies || {};
  const allZero = m.all_zero;
  const anomalyItems = [
    { label: "Race重複", v: anomalies.race_duplicates ?? 0 },
    { label: "Entry重複", v: anomalies.entry_duplicates ?? 0 },
    { label: "FINAL重複", v: anomalies.final_duplicates ?? 0 },
    { label: "RESULT重複", v: anomalies.result_duplicates ?? 0 },
    { label: "CONFLICT", v: anomalies.result_conflicts ?? 0 },
    { label: "MISSING逆戻り", v: anomalies.missing_finals ?? 0 },
  ];
  const resultSources = m.result_sources || {};
  const oddsSources = m.odds_sources || {};
  const fetchStats = m.fetch_stats || {};

  return (
    <div className={cn(
      "rounded-xl border p-3 space-y-2",
      allZero ? "bg-emerald-50 border-emerald-200" : "bg-rose-50 border-rose-200"
    )}>
      <div className="flex items-center gap-1.5">
        <ShieldCheck className={cn("w-3.5 h-3.5", allZero ? "text-emerald-600" : "text-rose-600")} />
        <span className="text-xs font-bold text-slate-700">クリーンアップ監視(第6段階)</span>
        <span className={cn(
          "ml-auto px-2 h-5 rounded text-[10px] font-bold flex items-center gap-1",
          allZero ? "bg-emerald-100 text-emerald-700" : "bg-rose-100 text-rose-700"
        )}>
          {allZero ? <CheckCircle2 className="w-3 h-3" /> : <AlertTriangle className="w-3 h-3" />}
          {allZero ? "異常0件" : "異常あり"}
        </span>
      </div>

      {/* 異常0件目標グリッド */}
      <div className="grid grid-cols-3 sm:grid-cols-6 gap-1.5">
        {anomalyItems.map((a) => (
          <div key={a.label} className={cn(
            "rounded-lg px-2 py-1.5 text-center",
            a.v === 0 ? "bg-white/60" : "bg-rose-100"
          )}>
            <div className={cn("font-bold text-sm leading-none", a.v === 0 ? "text-emerald-600" : "text-rose-700")}>{a.v}</div>
            <div className="text-[9px] text-slate-500 mt-0.5">{a.label}</div>
          </div>
        ))}
      </div>

      {/* データソース別取得元 */}
      <div className="grid sm:grid-cols-3 gap-2 text-[10px]">
        <div className="bg-white/60 rounded-lg p-2">
          <div className="font-bold text-slate-600 mb-1">結果取得元</div>
          <div className="flex gap-2">
            <span className="text-sky-700">BCAST:{resultSources.BOATCAST || 0}</span>
            <span className="text-slate-500">LOCAL:{resultSources.LOCAL || 0}</span>
            <span className="text-slate-400">TXT:{resultSources.TXT || 0}</span>
          </div>
        </div>
        <div className="bg-white/60 rounded-lg p-2">
          <div className="font-bold text-slate-600 mb-1">オッズ取得元</div>
          <div className="flex gap-2">
            <span className="text-sky-700">BCAST:{oddsSources.BOATCAST || 0}</span>
            <span className="text-slate-500">LOCAL:{oddsSources.LOCAL || 0}</span>
          </div>
        </div>
        <div className="bg-white/60 rounded-lg p-2">
          <div className="font-bold text-slate-600 mb-1">取得ログ(直近100)</div>
          <div className="flex gap-2 flex-wrap">
            <span className="text-emerald-600">OK:{fetchStats.success || 0}</span>
            <span className="text-rose-600">FAIL:{fetchStats.failed || 0}</span>
            <span className="text-amber-600">NODATA:{fetchStats.no_data || 0}</span>
            <span className="text-slate-500">SKIP:{fetchStats.skipped || 0}</span>
          </div>
        </div>
      </div>
    </div>
  );
}