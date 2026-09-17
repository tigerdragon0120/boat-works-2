import React, { useCallback, useEffect, useMemo, useState } from "react";
import { base44 } from "@/api/base44Client";
import { cn } from "@/lib/utils";
import { AlertTriangle, CheckCircle2, Scale, Target, XCircle } from "lucide-react";

const TARGET_HIT = 16;
const TARGET_RECOVERY = 110;
const MIN_SAMPLE = 100;
const PERIODS = [
  { key: "50", label: "直近50 V2 BUY" },
  { key: "100", label: "直近100 V2 BUY" },
  { key: "300", label: "直近300 V2 BUY" },
  { key: "all", label: "全期間" },
];

// V5 Balance Candidate
// V2の買い目は変えず、予想時点の艇スコアだけで弱いBUYをWATCHへ落とす。
// 結果・払戻は判定条件に使用しない（検証リーク防止）。
function evaluateV5(v) {
  const scores = Array.isArray(v.v2_boat_scores) ? v.v2_boat_scores : [];
  const ticketCount = Number(v.v2_ticket_count || 0);
  if (scores.length !== 6 || ticketCount < 6 || ticketCount > 8) {
    return { buy: false, reason: "必要データ不足" };
  }

  const ranked = [...scores]
    .filter(s => Number.isFinite(Number(s.final_score)))
    .sort((a, b) => Number(b.final_score) - Number(a.final_score));
  if (ranked.length < 2) return { buy: false, reason: "艇スコア不足" };

  const top = ranked[0];
  const second = ranked[1];
  const topScore = Number(top.final_score);
  const scoreGap = topScore - Number(second.final_score);
  const recent = Number(top.recent_score);
  const today = Number(top.today_score);
  const boat = Number(top.boat_number);

  const recentTop2 = [...scores]
    .sort((a, b) => Number(b.recent_score || 0) - Number(a.recent_score || 0))
    .slice(0, 2).some(s => Number(s.boat_number) === boat);
  const todayTop2 = [...scores]
    .sort((a, b) => Number(b.today_score || 0) - Number(a.today_score || 0))
    .slice(0, 2).some(s => Number(s.boat_number) === boat);

  const checks = [
    [topScore >= 52, "本命総合スコア52未満"],
    [scoreGap >= 5, "本命と2位の差5pt未満"],
    [recent >= 34, "直近評価34未満"],
    [today >= 52, "当日評価52未満"],
    [recentTop2 && todayTop2, "直近と当日の評価が不一致"],
    [boat < 5 || (scoreGap >= 9 && recent >= 38), "5・6号艇の根拠不足"],
  ];
  const failed = checks.find(([ok]) => !ok);
  return {
    buy: !failed,
    reason: failed ? failed[1] : "V2収益性＋スコア一貫性",
    metrics: { topScore, scoreGap, recent, today, boat },
  };
}

function aggregate(rows) {
  const count = rows.length;
  const hits = rows.filter(v => v.v2_recommended_hit === true).length;
  const investment = rows.reduce((s, v) => s + Number(v.v2_investment || 0), 0);
  const payout = rows.reduce((s, v) => s + Number(v.v2_payout || 0), 0);
  return {
    count, hits, investment, payout,
    hitRate: count ? hits / count * 100 : 0,
    recovery: investment ? payout / investment * 100 : 0,
  };
}

export default function V2V5Comparison() {
  const [rows, setRows] = useState([]);
  const [period, setPeriod] = useState("100");
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await base44.entities.PredictionV2Verification.list("-verified_at", 500).catch(() => []);
      setRows((data || []).filter(v =>
        v.v2_final_judgment === "BUY" && v.v2_recommended_hit != null
      ));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const summary = useMemo(() => {
    const limit = period === "all" ? rows.length : Number(period);
    const sameWindow = rows.slice(0, limit);
    const evaluated = sameWindow.map(v => ({ row: v, result: evaluateV5(v) }));
    const v5Rows = evaluated.filter(x => x.result.buy).map(x => x.row);
    const reasonCounts = {};
    evaluated.filter(x => !x.result.buy).forEach(x => {
      reasonCounts[x.result.reason] = (reasonCounts[x.result.reason] || 0) + 1;
    });
    return {
      v2: aggregate(sameWindow),
      v5: aggregate(v5Rows),
      watch: sameWindow.length - v5Rows.length,
      reasons: Object.entries(reasonCounts).sort((a, b) => b[1] - a[1]),
    };
  }, [rows, period]);

  if (loading) return <div className="py-8 text-center text-sm text-slate-400">V5を集計中…</div>;
  if (!rows.length) return <div className="py-8 text-center text-sm text-slate-400">V5を検証できるV2 BUY結果がありません。</div>;

  const ready = summary.v5.count >= MIN_SAMPLE;
  const passed = ready && summary.v5.hitRate >= TARGET_HIT && summary.v5.recovery >= TARGET_RECOVERY;

  return (
    <div className="space-y-4">
      <div className="rounded-xl bg-gradient-to-r from-emerald-950 to-slate-900 p-4 text-white">
        <div className="flex items-center gap-2 font-black"><Scale className="h-5 w-5 text-emerald-400" />V5 BALANCE — 16 / 110</div>
        <p className="mt-1 text-xs text-emerald-100">V2の買い目を維持し、根拠が弱いBUYだけをWATCHへ。的中率16%以上・回収率110%以上を同時に狙います。</p>
      </div>

      <div className="flex flex-wrap gap-2">
        {PERIODS.map(p => (
          <button key={p.key} onClick={() => setPeriod(p.key)}
            className={cn("h-8 rounded-lg px-3 text-xs font-bold", period === p.key ? "bg-emerald-600 text-white" : "bg-slate-100 text-slate-600")}>
            {p.label}
          </button>
        ))}
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        <Card title="V2 基準" data={summary.v2} tone="slate" />
        <Card title="V5 収支バランス候補" data={summary.v5} tone="emerald" />
      </div>

      <div className="grid grid-cols-3 gap-2 rounded-xl border border-slate-200 bg-slate-50 p-3 text-center">
        <Metric label="V5 BUY" value={summary.v5.count + "R"} />
        <Metric label="WATCHへ変更" value={summary.watch + "R"} />
        <Metric label="必要サンプル" value={summary.v5.count + "/" + MIN_SAMPLE} />
      </div>

      <div className={cn("rounded-xl border p-3", passed ? "border-emerald-200 bg-emerald-50" : "border-amber-200 bg-amber-50")}>
        <div className="flex items-center gap-2 text-sm font-black">
          {passed ? <CheckCircle2 className="h-4 w-4 text-emerald-600" /> : <AlertTriangle className="h-4 w-4 text-amber-600" />}
          {passed ? "V5昇格条件を達成" : !ready ? "候補運転中：100BUYまで正式採用しない" : "V5昇格条件は未達"}
        </div>
        <div className="mt-1 text-xs text-slate-600">
          判定条件：100BUY以上・的中率{TARGET_HIT}%以上・回収率{TARGET_RECOVERY}%以上。結果を使った後付け判定はしていません。
        </div>
      </div>

      {summary.reasons.length > 0 && (
        <div className="rounded-xl border border-slate-200 p-3">
          <div className="mb-2 text-xs font-bold text-slate-700">V5がWATCHへ落とした主な理由</div>
          <div className="space-y-1.5">
            {summary.reasons.slice(0, 6).map(([reason, count]) => (
              <div key={reason} className="flex justify-between text-xs text-slate-600"><span>{reason}</span><b>{count}R</b></div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function Card({ title, data, tone }) {
  const hitOk = data.hitRate >= TARGET_HIT;
  const recoveryOk = data.recovery >= TARGET_RECOVERY;
  return (
    <div className={cn("rounded-xl border p-3", tone === "emerald" ? "border-emerald-200 bg-emerald-50" : "border-slate-200 bg-white")}>
      <div className="mb-3 text-sm font-black text-slate-900">{title}</div>
      <div className="grid grid-cols-2 gap-2">
        <Metric label="BUY数" value={data.count + "R"} />
        <Metric label="的中数" value={data.hits + "R"} />
        <Metric label="的中率" value={data.hitRate.toFixed(1) + "%"} good={hitOk} bad={!hitOk} />
        <Metric label="回収率" value={data.recovery.toFixed(1) + "%"} good={recoveryOk} bad={!recoveryOk} />
        <Metric label="投資" value={"¥" + data.investment.toLocaleString()} />
        <Metric label="払戻" value={"¥" + data.payout.toLocaleString()} />
      </div>
    </div>
  );
}

function Metric({ label, value, good, bad }) {
  return (
    <div className="rounded-lg bg-white p-2">
      <div className="text-[10px] text-slate-400">{label}</div>
      <div className={cn("font-bold text-slate-900", good && "text-emerald-600", bad && "text-rose-500")}>
        {value}
        {good && <CheckCircle2 className="ml-1 inline h-3 w-3" />}
        {bad && <XCircle className="ml-1 inline h-3 w-3" />}
      </div>
    </div>
  );
}
