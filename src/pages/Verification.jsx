import React, { useState, useEffect } from "react";
import { getVerificationSummary } from "@/lib/predictionService";
import {
  BarChart3, Target, Coins, TrendingUp, CheckCircle2, XCircle,
  ArrowRight, BrainCircuit, Database, TicketCheck, RefreshCw, AlertTriangle
} from "lucide-react";
import { cn } from "@/lib/utils";
import V1V2Comparison from "@/components/verification/V1V2Comparison";

export default function Verification() {
  const [summary, setSummary] = useState(null);
  const [loading, setLoading] = useState(true);

  const load = async () => {
    setLoading(true);
    try {
      setSummary(await getVerificationSummary());
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  if (loading) return <div className="text-center py-20 text-slate-400 text-sm">読み込み中…</div>;

  if (!summary || summary.total === 0) {
    return (
      <div>
        <Header onReload={load} />
        <div className="text-center py-20 text-slate-400 text-sm bg-white rounded-2xl border border-dashed border-slate-200">
          まだ検証できる確定結果がありません。<br />結果が入ると、BUY予想の的中・回収・学習反映を自動集計します。
        </div>
      </div>
    );
  }

  const misses = summary.miss_breakdown || {};
  const missTotal = (misses.first || 0) + (misses.second || 0) + (misses.third || 0) + (misses.other || 0);
  const maxMiss = Math.max(1, misses.first || 0, misses.second || 0, misses.third || 0, misses.other || 0);

  return (
    <div className="space-y-5">
      <Header onReload={load} />

      <section className="rounded-2xl border border-sky-100 bg-gradient-to-r from-sky-50 via-white to-indigo-50 p-4">
        <div className="flex flex-wrap items-center gap-2 text-xs font-bold text-slate-700">
          <Flow icon={Target} label="FINALでBUY判定" />
          <ArrowRight className="w-4 h-4 text-slate-400" />
          <Flow icon={TicketCheck} label="6〜8点を実際の結果と照合" />
          <ArrowRight className="w-4 h-4 text-slate-400" />
          <Flow icon={BarChart3} label="的中・外れ方・回収率を検証" />
          <ArrowRight className="w-4 h-4 text-slate-400" />
          <Flow icon={Database} label="学習サンプルへ結果保存" />
          <ArrowRight className="w-4 h-4 text-slate-400" />
          <Flow icon={BrainCircuit} label="次回ロジック改善材料" strong />
        </div>
        <p className="mt-3 text-[11px] leading-relaxed text-slate-500">
          このページの目的は「予想1位が当たったか」ではなく、<b className="text-slate-700">実際にBUYと判定した6〜8点が当たったか</b>を検証し、外れ方を次の予想改善に繋げることです。
        </p>
      </section>

      <section>
        <div className="flex items-end justify-between gap-3 mb-2">
          <div>
            <div className="text-[11px] font-bold text-sky-600">BUY PERFORMANCE</div>
            <h2 className="font-display font-black text-slate-900 text-lg">BUY予想の成績</h2>
          </div>
          <div className="text-[10px] text-slate-400">確定結果 {summary.total}Rのうち BUY {summary.buy_count}R</div>
        </div>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <Stat icon={Target} label="BUYレース" value={summary.buy_count} unit="R" tone="text-slate-900" />
          <Stat icon={CheckCircle2} label="BUY的中" value={summary.buy_hits} unit="R" tone="text-emerald-600" sub={`${summary.buy_hit_rate}%`} />
          <Stat icon={XCircle} label="BUY不的中" value={summary.buy_misses} unit="R" tone="text-rose-500" />
          <Stat icon={Coins} label="BUY回収率" value={summary.buy_recovery_rate} unit="%" tone={summary.buy_recovery_rate >= 100 ? "text-emerald-600" : "text-rose-500"} sub={`投資 ¥${fmt(summary.buy_investment)} → 払戻 ¥${fmt(summary.buy_return)}`} />
        </div>
      </section>

      <V1V2Comparison />

      <section className="bg-white rounded-2xl border border-slate-200 p-4">
        <div className="flex flex-wrap items-start justify-between gap-3 mb-4">
          <div>
            <div className="text-[10px] font-bold text-slate-400">DATA FOUNDATION</div>
            <h3 className="font-bold text-slate-900">予想に使う「過去 × 直近 × 当日」データ</h3>
            <p className="text-[11px] text-slate-500 mt-1">長期の地力だけでも、直近だけでも判断せず、時間軸を分けて6艇を評価します。</p>
          </div>
          <Database className="w-5 h-5 text-indigo-500" />
        </div>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-2 mb-4">
          <DataCard label="選手プロファイル" value={summary.data_coverage?.performance_profiles || 0} sub="3年・全期間・コース・場別" />
          <DataCard label="ローリング統計" value={summary.data_coverage?.rolling_stats || 0} sub="6か月・1年・トレンド" />
          <DataCard label="学習サンプル" value={summary.data_coverage?.learning_samples || 0} sub="予想時点→確定結果" />
          <DataCard label="要因分析" value={summary.data_coverage?.factor_samples || 0} sub="長期/直近/展示/オッズ" />
        </div>
        <div className="grid sm:grid-cols-3 gap-2">
          <LayerCard title="長期 25%" text="3年＋全期間。選手本来の地力を安定軸にする" />
          <LayerCard title="中期 35%" text="6か月＋1年。今期の実力変化を反映する" />
          <LayerCard title="直近 40%" text="5走・10走・20走＋ST/級別トレンドを最重視" strong />
        </div>
      </section>

      <section className="bg-white rounded-2xl border border-slate-200 p-4">
        <div className="flex flex-wrap items-start justify-between gap-3 mb-4">
          <div>
            <div className="text-[10px] font-bold text-slate-400">FACTOR LEARNING</div>
            <h3 className="font-bold text-slate-900">何がBUY的中に効いたか</h3>
            <p className="text-[11px] text-slate-500 mt-1">的中レースと不的中レースで各要因の平均値を比較。サンプルが貯まるほど、重み調整の根拠になります。</p>
          </div>
          <div className="text-right text-[10px] text-slate-400">確定要因データ {summary.factor_coverage?.resolved || 0}R</div>
        </div>
        {(summary.factor_impact || []).every(x => !x.samples) ? (
          <div className="rounded-xl bg-slate-50 border border-dashed border-slate-200 py-8 text-center text-xs text-slate-400">新しいFINAL予想から要因データを蓄積します。結果確定後ここに比較が出ます。</div>
        ) : (
          <div className="space-y-3">
            {(summary.factor_impact || []).map((f) => <FactorRow key={f.key} data={f} />)}
          </div>
        )}
      </section>

      <section className="grid lg:grid-cols-2 gap-4">
        <div className="bg-white rounded-2xl border border-slate-200 p-4">
          <div className="flex items-center justify-between mb-3">
            <div>
              <div className="text-[10px] font-bold text-slate-400">TICKET COUNT</div>
              <h3 className="font-bold text-slate-900">6点・7点・8点 どれが機能しているか</h3>
            </div>
            <TicketCheck className="w-5 h-5 text-sky-500" />
          </div>
          <div className="grid grid-cols-3 gap-2">
            <TicketCard n={6} data={summary.tickets_6} />
            <TicketCard n={7} data={summary.tickets_7} />
            <TicketCard n={8} data={summary.tickets_8} />
          </div>
        </div>

        <div className="bg-white rounded-2xl border border-slate-200 p-4">
          <div className="flex items-center justify-between mb-3">
            <div>
              <div className="text-[10px] font-bold text-slate-400">MISS ANALYSIS</div>
              <h3 className="font-bold text-slate-900">BUYを外した原因</h3>
            </div>
            <AlertTriangle className="w-5 h-5 text-amber-500" />
          </div>
          {missTotal === 0 ? (
            <div className="py-8 text-center text-sm text-emerald-600 font-bold">現在、BUYの外れデータはありません</div>
          ) : (
            <div className="space-y-3">
              <MissBar label="1着予想のズレ" value={misses.first || 0} max={maxMiss} />
              <MissBar label="2着予想のズレ" value={misses.second || 0} max={maxMiss} />
              <MissBar label="3着予想のズレ" value={misses.third || 0} max={maxMiss} />
              <MissBar label="その他" value={misses.other || 0} max={maxMiss} />
            </div>
          )}
        </div>
      </section>

      <section className="bg-white rounded-2xl border border-slate-200 p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="text-[10px] font-bold text-slate-400">LEARNING LOOP</div>
            <h3 className="font-bold text-slate-900">次の予想ロジックへの接続状況</h3>
            <p className="text-[11px] text-slate-500 mt-1">予想時点の6艇スコア・展示・オッズ・天候・節間データと、確定結果を同じ学習サンプルに紐づけます。</p>
          </div>
          <div className="text-right">
            <div className="text-3xl font-black text-indigo-600">{summary.learning_link_rate}<span className="text-sm ml-0.5">%</span></div>
            <div className="text-[10px] text-slate-400">BUY結果の学習接続率 {summary.learning_linked}/{summary.buy_count}</div>
          </div>
        </div>
        <div className="mt-4 grid md:grid-cols-4 gap-2">
          <LearningBox n="1" title="予想時点を保存" text="FINALの艇別評価・買い目・展示・オッズを固定" />
          <LearningBox n="2" title="確定結果を付与" text="3連単結果と払戻を同じサンプルへ追加" />
          <LearningBox n="3" title="外れ方を分類" text="1着・2着・3着のどこでズレたかを集計" />
          <LearningBox n="4" title="改善材料にする" text="次回の重み・買い目構成・BUY条件の見直しに使う" />
        </div>
      </section>

      <section>
        <div className="flex items-end justify-between gap-2 mb-2">
          <div>
            <div className="text-[10px] font-bold text-slate-400">BUY HISTORY</div>
            <h2 className="font-display font-black text-slate-900 text-lg">BUYレース別の検証</h2>
          </div>
          <div className="text-[10px] text-slate-400">最新500件まで</div>
        </div>
        <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
          {summary.records.length === 0 ? (
            <div className="py-12 text-center text-slate-400 text-sm">まだBUY判定の確定レースがありません</div>
          ) : summary.records.map((v) => (
            <div key={v.id} className={cn("px-3 sm:px-4 py-3 border-b border-slate-100 last:border-0", v.recommended_hit ? "bg-emerald-50/35" : "bg-white")}>
              <div className="flex flex-wrap items-center gap-2 justify-between">
                <div className="flex items-center gap-2 min-w-0">
                  <span className={cn("px-2 h-6 rounded-md text-[10px] font-black flex items-center", v.recommended_hit ? "bg-emerald-100 text-emerald-700" : "bg-rose-100 text-rose-600")}>
                    {v.recommended_hit ? "的中" : "不的中"}
                  </span>
                  <span className="font-mono font-black text-slate-900">結果 {v.actual_result || "—"}</span>
                  <span className="text-[10px] text-slate-400">{v.ticket_count || "—"}点</span>
                </div>
                <div className="text-right text-[11px]">
                  <span className="text-slate-400">払戻 </span><span className="font-bold text-slate-900">{v.payout != null ? `¥${fmt(v.payout)}` : "—"}</span>
                  <span className="text-slate-300 mx-1.5">·</span>
                  <span className={cn("font-bold", v.recovery_rate >= 100 ? "text-emerald-600" : "text-slate-500")}>回収率 {v.recovery_rate || 0}%</span>
                </div>
              </div>
              <div className="mt-2 text-[11px] text-slate-500 flex flex-wrap gap-x-3 gap-y-1">
                <span>買い目: {(v.selected_trifectas || []).join(" / ") || "—"}</span>
                {!v.recommended_hit && v.miss_reason && <span className="text-rose-500 font-medium">原因: {v.miss_reason}</span>}
              </div>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

function Header({ onReload }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <div className="flex items-center gap-2">
        <BarChart3 className="w-5 h-5 text-sky-600" />
        <div>
          <h1 className="text-xl font-display font-black text-slate-900">BUY検証・学習</h1>
          <p className="text-[10px] text-slate-400">BUYが当たったかを検証し、次の予想ロジック改善へ繋げる</p>
        </div>
      </div>
      <button onClick={onReload} className="h-9 px-3 rounded-lg border border-slate-200 bg-white text-slate-600 text-xs font-bold flex items-center gap-1.5 hover:bg-slate-50"><RefreshCw className="w-3.5 h-3.5" />更新</button>
    </div>
  );
}

function Flow({ icon: Icon, label, strong }) {
  return <div className={cn("flex items-center gap-1.5 px-2.5 py-2 rounded-lg border", strong ? "bg-indigo-600 border-indigo-600 text-white" : "bg-white border-slate-200")}><Icon className="w-3.5 h-3.5" />{label}</div>;
}

function Stat({ icon: Icon, label, value, unit, tone, sub }) {
  return (
    <div className="bg-white rounded-2xl border border-slate-200 p-3.5">
      <div className="flex items-center gap-1.5 text-[11px] text-slate-400"><Icon className="w-3.5 h-3.5" /> {label}</div>
      <div className={cn("font-display font-black text-2xl mt-1", tone)}>{value}<span className="text-sm font-normal text-slate-400 ml-0.5">{unit}</span></div>
      {sub && <div className="text-[10px] text-slate-400 mt-1">{sub}</div>}
    </div>
  );
}

function TicketCard({ n, data = {} }) {
  const good = (data.recovery_rate || 0) >= 100;
  return (
    <div className="rounded-xl border border-slate-200 bg-slate-50 p-3 text-center">
      <div className="text-xs font-black text-slate-700">{n}点BUY</div>
      <div className="text-2xl font-black text-slate-900 mt-1">{data.hit_rate || 0}<span className="text-xs text-slate-400">%</span></div>
      <div className="text-[9px] text-slate-400">的中 {data.hits || 0}/{data.count || 0}</div>
      <div className={cn("mt-2 text-xs font-bold", good ? "text-emerald-600" : "text-slate-500")}>回収 {data.recovery_rate || 0}%</div>
    </div>
  );
}

function MissBar({ label, value, max }) {
  const pct = Math.max(3, Math.round((value / max) * 100));
  return (
    <div>
      <div className="flex items-center justify-between text-[11px] mb-1"><span className="text-slate-600">{label}</span><span className="font-bold text-slate-800">{value}件</span></div>
      <div className="h-2 rounded-full bg-slate-100 overflow-hidden"><div className="h-full rounded-full bg-rose-400" style={{ width: `${value ? pct : 0}%` }} /></div>
    </div>
  );
}

function LearningBox({ n, title, text }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
      <div className="w-6 h-6 rounded-full bg-indigo-100 text-indigo-700 flex items-center justify-center text-[10px] font-black mb-2">{n}</div>
      <div className="text-xs font-bold text-slate-800">{title}</div>
      <div className="text-[10px] text-slate-500 mt-1 leading-relaxed">{text}</div>
    </div>
  );
}

function DataCard({ label, value, sub }) {
  return <div className="rounded-xl border border-slate-200 bg-slate-50 p-3"><div className="text-2xl font-black text-slate-900">{fmt(value)}</div><div className="text-[11px] font-bold text-slate-700">{label}</div><div className="text-[9px] text-slate-400 mt-1">{sub}</div></div>;
}

function LayerCard({ title, text, strong }) {
  return <div className={cn("rounded-xl border p-3", strong ? "border-indigo-200 bg-indigo-50" : "border-slate-200 bg-slate-50")}><div className={cn("text-xs font-black", strong ? "text-indigo-700" : "text-slate-800")}>{title}</div><div className="text-[10px] text-slate-500 mt-1 leading-relaxed">{text}</div></div>;
}

const FACTOR_LABELS = {
  long_term: "長期地力（3年・全期間）",
  mid_term: "中期成績（6か月・1年）",
  recent: "直近フォーム（5/10/20走）",
  course_venue: "コース・場適性",
  section: "今節・節間状態",
  exhibition: "展示・直前気配",
  odds: "直前オッズ",
  confidence: "データ信頼度",
};

function FactorRow({ data }) {
  const hit = data.hit_avg;
  const miss = data.miss_avg;
  const gap = data.gap;
  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] mb-1.5">
        <span className="font-bold text-slate-700">{FACTOR_LABELS[data.key] || data.key}</span>
        <span className="text-slate-400">的中 <b className="text-emerald-600">{hit ?? '—'}</b> / 外れ <b className="text-rose-500">{miss ?? '—'}</b>{gap != null && <span className={cn("ml-2 font-bold", gap >= 0 ? "text-emerald-600" : "text-rose-500")}>差 {gap > 0 ? '+' : ''}{gap}</span>}</span>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <div className="h-2 rounded-full bg-slate-100 overflow-hidden"><div className="h-full bg-emerald-400 rounded-full" style={{width:`${Math.max(0, Math.min(100, hit || 0))}%`}} /></div>
        <div className="h-2 rounded-full bg-slate-100 overflow-hidden"><div className="h-full bg-rose-300 rounded-full" style={{width:`${Math.max(0, Math.min(100, miss || 0))}%`}} /></div>
      </div>
    </div>
  );
}

function fmt(v) { return Number(v || 0).toLocaleString("ja-JP"); }