import React, { useState } from "react";
import { useCreditSavingRead } from "@/hooks/useCreditSavingRead";
import { getAutoUpdateStatus, runAutoUpdateStep } from "@/lib/dataManagementService";
import { RefreshCw, Calendar, CheckCircle2, AlertTriangle, Loader2, Clock, Zap, Download, Flag, BarChart3, CloudDownload } from "lucide-react";
import { cn } from "@/lib/utils";
import { VENUES } from "@/components/liveV8/v8Client";

async function readAutoUpdateStatus() {
  const response = await getAutoUpdateStatus();
  return response.data;
}

export default function AutoUpdateSection() {
  const [busy, setBusy] = useState(null);
  const [result, setResult] = useState(null);
  const { data: status, loading, error: statusError, refresh: load } = useCreditSavingRead({
    operation: 'getAutoUpdateStatusV2',
    read: readAutoUpdateStatus,
    interval: busy ? 30000 : 300000,
  });

  const handleStep = async (step) => {
    setBusy(step);
    setResult(null);
    try {
      const r = await runAutoUpdateStep(step);
      setResult(r.data);
      await load(); // Refresh after completion; supersede any pre-operation read.
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

  if (statusError) {
    return <div className="rounded-xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800">
      <p className="font-bold">自動処理の状態を確認できませんでした</p>
      <p className="mt-1">通信を確認して、状態を再読み込みしてください。</p>
      <button type="button" onClick={() => load()} className="mt-3 rounded-lg border border-rose-300 bg-white px-3 py-2 font-semibold">状態を再読込</button>
    </div>;
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
        <span className="px-2 py-0.5 rounded-full bg-sky-100 text-sky-700 text-[10px] font-bold">5分毎自動収集</span>
      </div>
      <p className="text-xs text-slate-500">展示・オッズ・番組・結果の取得と、V8の予想保存はそれぞれ5分ごとに独立して動きます。取得できたデータを先に保存し、未完了分は次の定期実行で再処理します。</p>

      {/* ステータスバー */}
      <div className={cn("rounded-xl border p-3 flex items-center justify-between", statusColor[currentStatus])}>
        <div className="flex items-center gap-2">
          {currentStatus === "success" ? <CheckCircle2 className="w-5 h-5" /> :
           currentStatus === "error" ? <AlertTriangle className="w-5 h-5" /> :
           <Clock className="w-5 h-5" />}
          <span className="font-bold text-sm">データ取得：{statusLabel[currentStatus] || currentStatus}</span>
          {s.current_step && <span className="text-xs opacity-70">({s.current_step})</span>}
        </div>
        <div className="text-xs text-right">
          <div>最終更新: {s.last_updated ? new Date(s.last_updated).toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "—"}</div>
          <div className="opacity-60">JST {s.jst_time || ""}</div>
        </div>
      </div>

      <ForecastGenerationStatus value={s.forecast_generation} />

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

function ForecastGenerationStatus({ value }) {
  const ready = value?.read_status === 'READY';
  const summary = ready ? value.job_summary : null;
  const failed = ready && (value.status === 'error' || summary?.result_status === 'FAILED');
  const partial = ready && (value.status === 'partial' || summary?.result_status === 'PARTIAL');
  const complete = ready && value.status === 'success' && summary?.worker_completed === true && summary?.result_status === 'COMPLETE';
  const at = value?.last_updated ? Date.parse(value.last_updated) : NaN;
  const hour = Number(new Intl.DateTimeFormat('en-GB', {timeZone:'Asia/Tokyo',hour:'2-digit',hourCycle:'h23'}).format(new Date()));
  const stale = ready && Number.isFinite(at) && Date.now() - at > 12 * 60000 && hour >= 6;
  const missing = value?.read_status === 'MISSING';
  const label = !ready ? (missing ? '実行記録待ち' : '状態の読込待ち') : failed ? 'エラーを確認' : stale ? '実行記録の更新を確認' : partial ? '一部を次回再処理' : complete ? '正常' : '実行状態を確認';
  const tone = failed ? 'border-rose-200 bg-rose-50 text-rose-800' : partial || stale ? 'border-amber-200 bg-amber-50 text-amber-900' : complete ? 'border-emerald-200 bg-emerald-50 text-emerald-800' : 'border-slate-200 bg-slate-50 text-slate-700';
  const count = key => summary && Number.isInteger(summary[key]) && summary[key] >= 0 ? summary[key] : '—';
  const pending = Array.isArray(summary?.pending) ? summary.pending : [];
  const raceLabel = key => {
    const match = /^(\d{4})-(\d{2})-(\d{2})_(\d{2})_(\d{2})$/.exec(String(key || ''));
    return match ? `${Number(match[2])}/${Number(match[3])} ${VENUES[Number(match[4])] || '会場未確認'} ${Number(match[5])}R` : '対象レースを確認中';
  };
  return <div className={cn('rounded-xl border p-4 space-y-3', tone)}>
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h3 className="text-sm font-bold">V8予想保存：{label}</h3>
      <span className="text-xs">最終更新 {Number.isFinite(at) ? new Date(at).toLocaleTimeString('ja-JP',{timeZone:'Asia/Tokyo',hour:'2-digit',minute:'2-digit',second:'2-digit'}) : '—'}</span>
    </div>
    <div className="grid grid-cols-3 gap-2 text-center text-xs">
      <div className="rounded-lg bg-white/70 p-2"><div className="text-lg font-bold">{count('created')}</div>今回保存</div>
      <div className="rounded-lg bg-white/70 p-2"><div className="text-lg font-bold">{count('retry_pending_count')}</div>再試行待ち</div>
      <div className="rounded-lg bg-white/70 p-2"><div className="text-lg font-bold">{count('pending_count')}</div>次回処理</div>
    </div>
    <p className="text-xs">{!ready ? (missing ? '独立した予想処理の実行後に表示します。' : '予想保存の状態を取得できていません。保存件数は未確認です。') : failed ? '予想保存でエラーが発生しました。保存済みデータを保持し、データ取得は別の定期処理で続けます。' : stale ? '最終更新から12分以上経過しています。予想保存の実行状況を確認してください。' : partial ? '保存できた予想を保持しています。未完了分は次の定期実行で再処理します。締切後の補完は事後検証として扱います。' : complete ? '保存済みデータから予想を作成しました。次回も不足・更新分を確認します。' : '処理完了を確認できていません。最終更新と実行状況を確認してください。'}</p>
    {pending.length > 0 && <details className="text-xs">
      <summary className="cursor-pointer font-semibold">次回処理するレース</summary>
      <ul className="mt-2 space-y-1">
        {pending.slice(0,10).map((item,index)=><li key={`${item.race_key}-${index}`}>{raceLabel(item.race_key)} ・ {item.stage === 'FINAL' ? '展示後予想' : item.stage === 'DAY_BEFORE' ? '前日予想' : '事前予想'} ・ {item.retryable ? '取得・保存を再試行' : '次回処理'}</li>)}
      </ul>
      {(pending.length > 10 || summary?.pending_truncated) && <p className="mt-1">このほかの未完了分も次回の処理対象です。</p>}
    </details>}
    {failed && Array.isArray(value.errors) && value.errors.length > 0 && <p className="text-xs">{value.errors[0]}</p>}
  </div>;
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
