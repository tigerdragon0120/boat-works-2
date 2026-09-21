import React, { useState, useEffect } from "react";
import { getV6VerificationSummary } from "@/lib/predictionService";
import { Target, Coins, CheckCircle2, RefreshCw, AlertTriangle, DollarSign, PlayCircle } from "lucide-react";
import { cn } from "@/lib/utils";

export default function V4V6Comparison() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      setData(await getV6VerificationSummary());
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const runBacktest = async () => {
    setRunning(true);
    try {
      const { base44 } = await import("@/api/base44Client");
      await base44.functions.invoke("backtestV6Predictions", { limit: 1000, target_buy_count: 100 });
      await load();
    } catch (e) {
      console.error("backtest failed", e);
    } finally {
      setRunning(false);
    }
  };

  if (loading) return <div className="text-center py-8 text-slate-400 text-sm">V6集計中…</div>;

  const storedSummary = data?.backtest_summary;
  const bs = storedSummary && data ? {
    ...storedSummary,
    buy_count: data.buy_count,
    watch_count: data.watch_count,
    skip_count: data.skip_count,
    classified_count: data.buy_count + data.watch_count + data.skip_count,
    hit_count: data.hit_count,
    hit_rate: data.hit_rate,
    recovery_rate: data.recovery_rate,
    total_investment: data.total_investment,
    total_return: data.total_return,
    profit: data.total_return - data.total_investment,
    avg_ticket_count: data.avg_ticket_count,
    tickets_6: data.tickets_6,
    tickets_7: data.tickets_7,
    tickets_8: data.tickets_8,
    outcome: { ...(storedSummary.outcome || {}), ...(data.outcome || {}) },
  } : null;

  if (!bs) {
    return (
      <div className="text-center py-8 space-y-3">
        <div className="text-slate-400 text-sm border border-dashed border-slate-200 rounded-xl p-6">
          まだV6バックテストが実行されていません。
          <br />過去の確定済みレースでV6判定を再現し、的中率・回収率を検証します。
        </div>
        <button
          onClick={runBacktest}
          disabled={running}
          className="h-10 px-6 rounded-xl bg-violet-600 text-white text-sm font-bold flex items-center gap-2 mx-auto hover:bg-violet-700 disabled:opacity-50"
        >
          {running ? <><RefreshCw className="w-4 h-4 animate-spin" />バックテスト実行中…</> : <><PlayCircle className="w-4 h-4" />バックテスト実行</>}
        </button>
      </div>
    );
  }

  const outcome = bs.outcome || {};
  const profit = bs.profit || 0;
  const profitPositive = profit > 0;
  const recoveryOk = bs.recovery_rate >= 110;

  return (
    <div className="space-y-4">
      {/* ヘッダー */}
      <div className="flex items-center justify-between">
        <div className="text-[11px] text-slate-400">
          重複除外後 {data.total}R・判定{bs.classified_count}R
          {bs.insufficient_data != null && <span>・前回データ不足{bs.insufficient_data}R</span>}
          {bs.policy_version && <span className="ml-2 font-bold text-violet-500">{bs.policy_version}</span>}
          <span className="ml-2 text-slate-300">|</span>
          <span className="ml-2">{bs.backtested_at ? new Date(bs.backtested_at).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" }) : ""}</span>
        </div>
        <button
          onClick={runBacktest}
          disabled={running}
          className="h-8 px-3 rounded-lg bg-violet-600 text-white text-[11px] font-bold flex items-center gap-1.5 hover:bg-violet-700 disabled:opacity-50"
        >
          {running ? <><RefreshCw className="w-3 h-3 animate-spin" />実行中</> : <><PlayCircle className="w-3 h-3" />再実行</>}
        </button>
      </div>

      {/* 集計漏れ */}
      {(bs.unclassified_count || 0) > 0 && (
        <div className="rounded-xl border border-rose-200 bg-rose-50 p-3 flex items-center gap-2">
          <AlertTriangle className="w-4 h-4 text-rose-500 flex-shrink-0" />
          <div className="text-[11px] text-rose-700 font-medium">
            生成済みのうち{bs.unclassified_count}Rが未分類です。集計処理を確認してください。
          </div>
        </div>
      )}

      {/* 100BUY到達状況 */}
      {bs.buy_count < 100 && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 flex items-center gap-2">
          <AlertTriangle className="w-4 h-4 text-amber-500 flex-shrink-0" />
          <div className="text-[11px] text-amber-700 font-medium">
            利用可能な過去データでは{bs.buy_count}BUYまでしか正しく検証できません（目標100BUY）
          </div>
        </div>
      )}

      {/* 基本成績 */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <StatCard icon={Target} label="BUY数" value={bs.buy_count} unit="R" tone="text-violet-600" />
        <StatCard icon={CheckCircle2} label="的中数" value={bs.hit_count} unit="R" tone="text-emerald-600" sub={`的中率 ${bs.hit_rate}%`} />
        <StatCard icon={Coins} label="回収率" value={bs.recovery_rate} unit="%" tone={recoveryOk ? "text-emerald-600" : "text-rose-500"} sub={`投資¥${fmt(bs.total_investment)}→払戻¥${fmt(bs.total_return)}`} />
        <StatCard icon={DollarSign} label="利益額" value={fmt(profit)} unit="円" tone={profitPositive ? "text-emerald-600" : "text-rose-500"} />
      </div>

      {/* 判定別 */}
      <div className="grid grid-cols-3 gap-2">
        <CountCard label="BUY" value={bs.buy_count} tone="bg-violet-50 text-violet-700 border-violet-200" />
        <CountCard label="WATCH" value={bs.watch_count} tone="bg-amber-50 text-amber-700 border-amber-200" />
        <CountCard label="SKIP" value={bs.skip_count} tone="bg-slate-50 text-slate-600 border-slate-200" />
      </div>

      {/* チケット数別 */}
      <div>
        <div className="text-[11px] font-bold text-slate-500 mb-2">チケット数別BUY内訳</div>
        <div className="grid grid-cols-3 gap-2">
          <TicketCard n={6} count={bs.tickets_6} />
          <TicketCard n={7} count={bs.tickets_7} />
          <TicketCard n={8} count={bs.tickets_8} />
        </div>
        <div className="text-center text-[11px] text-slate-400 mt-2">平均買い目数: {bs.avg_ticket_count}点</div>
      </div>

      {/* outcome分類 */}
      <div>
        <div className="text-[11px] font-bold text-slate-500 mb-2">的中・不的中分類</div>
        <div className="grid grid-cols-2 lg:grid-cols-3 gap-2">
          <OutcomeCard label="HIT_PROFIT" value={outcome.HIT_PROFIT || 0} tone="bg-emerald-100 text-emerald-700 border-emerald-300" desc="的中+利益" />
          <OutcomeCard label="HIT_LOW_VALUE" value={outcome.HIT_LOW_VALUE || 0} tone="bg-sky-100 text-sky-700 border-sky-300" desc="的中+低配当" />
          <OutcomeCard label="MISS_FIRST" value={outcome.MISS_FIRST || 0} tone="bg-rose-100 text-rose-700 border-rose-300" desc="1着外れ" />
          <OutcomeCard label="MISS_SECOND" value={outcome.MISS_SECOND || 0} tone="bg-orange-100 text-orange-700 border-orange-300" desc="2着外れ" />
          <OutcomeCard label="MISS_THIRD" value={outcome.MISS_THIRD || 0} tone="bg-amber-100 text-amber-700 border-amber-300" desc="3着外れ" />
          <OutcomeCard label="INSUFFICIENT" value={outcome.BACKTEST_INSUFFICIENT_DATA || 0} tone="bg-slate-100 text-slate-600 border-slate-300" desc="データ不足除外" />
        </div>
      </div>

      {/* データリーク確認 */}
      <div className="rounded-xl border border-slate-200 bg-slate-50 p-3 text-[11px] text-slate-500">
        <span className="font-bold text-slate-600">データリーク:</span> V6エンジンは予想時点データ(出走表・展示・オッズ・選手プロファイル)のみ使用。結果は採点専用。
        <br />
        <span className="font-bold text-slate-600">データ不足除外基準:</span> exhibition_ready=false / 展示データ4艇未満 / FINALオッズ20組未満 → BACKTEST_INSUFFICIENT_DATA
      </div>
    </div>
  );
}

function StatCard({ icon: Icon, label, value, unit, tone, sub }) {
  return (
    <div className="bg-white rounded-xl border border-slate-200 p-3">
      <div className="flex items-center gap-1.5 text-[11px] text-slate-400"><Icon className="w-3.5 h-3.5" /> {label}</div>
      <div className={cn("font-display font-black text-2xl mt-1", tone)}>{value}<span className="text-sm font-normal text-slate-400 ml-0.5">{unit}</span></div>
      {sub && <div className="text-[10px] text-slate-400 mt-1">{sub}</div>}
    </div>
  );
}

function CountCard({ label, value, tone }) {
  return (
    <div className={cn("rounded-xl border p-3 text-center", tone)}>
      <div className="text-[10px] font-bold">{label}</div>
      <div className="text-2xl font-black mt-1">{value}</div>
    </div>
  );
}

function TicketCard({ n, count }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-slate-50 p-3 text-center">
      <div className="text-xs font-black text-slate-700">{n}点BUY</div>
      <div className="text-2xl font-black text-slate-900 mt-1">{count}</div>
      <div className="text-[9px] text-slate-400">R</div>
    </div>
  );
}

function OutcomeCard({ label, value, tone, desc }) {
  return (
    <div className={cn("rounded-xl border p-2.5 text-center", tone)}>
      <div className="text-[9px] font-bold leading-tight">{label.replace(/_/g, ' ')}</div>
      <div className="text-xl font-black mt-1">{value}</div>
      <div className="text-[9px] opacity-70 mt-0.5">{desc}</div>
    </div>
  );
}

function fmt(v) { return Number(v || 0).toLocaleString("ja-JP"); }