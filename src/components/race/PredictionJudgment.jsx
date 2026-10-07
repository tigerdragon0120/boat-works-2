import React from "react";
import { cn } from "@/lib/utils";
import { Calculator, Ticket } from "lucide-react";
import { buildSelectedTickets } from "@/lib/predictionService";

const judgmentConfig = {
  BUY: { label: "BUY", cls: "bg-rose-500/20 text-rose-300 border-rose-400/50" },
  WATCH: { label: "WATCH", cls: "bg-amber-500/20 text-amber-300 border-amber-400/50" },
  SKIP: { label: "SKIP", cls: "bg-slate-700/40 text-slate-600 border-slate-600" },
  PENDING: { label: "—", cls: "bg-slate-700/40 text-slate-500 border-slate-600" },
};

const groupStyle = {
  A: "text-rose-300 bg-rose-500/10 border-rose-400/30",
  B: "text-amber-300 bg-amber-500/10 border-amber-400/30",
  C: "text-slate-600 bg-slate-700/30 border-slate-600",
};

const STAGE_LABEL = { PRE: "事前予想", FINAL: "直前予想" };

// 予想判定(判定・買い目・セット分析)は、事前予想/直前予想タブより上に常時表示する。
export default function PredictionJudgment({ stage, pred, allTri, race }) {
  const judgment = pred?.final_judgment || "PENDING";
  const jcfg = judgmentConfig[judgment] || judgmentConfig.PENDING;
  // selected_trifectasを第一ソース、trifectas.filter(is_selected)をフォールバック
  const selectedRaw = buildSelectedTickets(pred, allTri);
  // 欠場艇を含む買い目をフィルタ(エンジンで除外済みだが二重チェック)
  const scratchedBoats = race?.scratched_boats || [];
  const selected = scratchedBoats.length > 0
    ? selectedRaw.filter((t) => !t.combination.split("-").map(Number).some((b) => scratchedBoats.includes(b)))
    : selectedRaw;
  // ticket_countはselected_trifectas.lengthを正とする
  const displayTicketCount = pred?.selected_trifectas?.length || pred?.ticket_count || selected.length || "—";

  return (
    <div className="flex flex-col gap-3">
      {/* === 1. 予想判定 BUY/WATCH/SKIP === */}
      <div className={cn("rounded-xl border-2 p-3 flex items-center gap-3", jcfg.cls)}>
        <div className="text-center shrink-0">
          <div className="text-[10px] text-slate-600 mb-0.5">{STAGE_LABEL[stage] || "予想"}の判定</div>
          <div className={cn("w-16 h-16 rounded-xl border-2 flex items-center justify-center text-2xl font-black", jcfg.cls)}>
            {jcfg.label}
          </div>
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <span className="text-[10px] text-slate-600">買い目</span>
            <span className="px-2 py-0.5 rounded bg-slate-100 text-slate-900 text-xs font-bold">{displayTicketCount}点</span>
            {pred?.ticket_strategy && <span className="text-[10px] text-slate-500 truncate">{pred.ticket_strategy}</span>}
          </div>
          <div className="text-[11px] text-slate-700 leading-relaxed">{pred?.judgment_reason || "—"}</div>
          {pred?.expand_reason && <div className="text-[10px] text-amber-400/80 mt-1">拡張: {pred.expand_reason}</div>}
        </div>
      </div>

      {/* === 2. 買い目一覧 6-8点 === */}
      <div className="rounded-lg border border-slate-200 bg-white p-3">
        <div className="flex items-center gap-1.5 mb-2">
          <Ticket className="w-3.5 h-3.5 text-[#f9c836]" />
          <span className="text-[11px] font-bold text-slate-600">買い目 {selected.length}点</span>
        </div>
        {selected.length > 0 ? (
          <div className="space-y-1">
            {selected.map((t) => <TicketRow key={t.combination} t={t} />)}
          </div>
        ) : (
          <div className="text-xs text-slate-500 py-2 text-center">買い目データがありません</div>
        )}
      </div>

      {/* === 3. セット期待値・合成オッズ === */}
      {pred?.set_probability != null && (
        <div className="rounded-lg border border-slate-200 bg-white p-3">
          <div className="flex items-center gap-1.5 mb-2">
            <Calculator className="w-3.5 h-3.5 text-blue-400" />
            <span className="text-[11px] font-bold text-slate-600">セット分析</span>
          </div>
          <div className="grid grid-cols-2 gap-2 text-center">
            <Metric label="セット的中率" v={pred.set_probability != null ? `${pred.set_probability}%` : "—"} />
            <Metric label="合成オッズ" v={pred.synthetic_odds != null ? `${pred.synthetic_odds}倍` : "—"} />
            <Metric label="期待回収率" v={pred.set_expected_recovery != null ? `${pred.set_expected_recovery}%` : "—"} highlight={pred.set_expected_recovery >= 120} />
            <Metric label="平均払戻" v={pred.avg_payout != null ? `${pred.avg_payout}円` : "—"} />
            <Metric label="最低払戻" v={pred.min_payout != null ? `${pred.min_payout}円` : "—"} />
            <Metric label="最高払戻" v={pred.max_payout != null ? `${pred.max_payout}円` : "—"} />
          </div>
          {pred.best_ev_ticket && (
            <div className="mt-2 pt-2 border-t border-slate-200 text-[10px] text-slate-500 flex justify-between">
              <span>最高EV: <span className="font-mono font-bold text-emerald-400">{pred.best_ev_ticket}</span></span>
              {pred.worst_efficiency_ticket && <span>低効率: <span className="font-mono text-slate-600">{pred.worst_efficiency_ticket}</span></span>}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function TicketRow({ t }) {
  const odds = t.actual_odds ?? t.current_odds ?? null;
  const ev = t.expected_value;
  return (
    <div className="flex items-center gap-2 rounded-md bg-white px-2 py-1.5">
      <span className={cn("w-5 h-5 rounded text-[10px] font-bold flex items-center justify-center shrink-0", t.ticket_rank <= 3 ? "bg-[#f9c836] text-slate-950" : "bg-slate-100 text-slate-600")}>{t.ticket_rank || "—"}</span>
      <span className="font-mono font-black text-slate-900 text-base tracking-wider w-20">{t.combination}</span>
      {t.set_group && (
        <span className={cn("px-1 h-5 rounded text-[9px] font-bold border flex items-center", groupStyle[t.set_group])}>{t.set_group}</span>
      )}
      <div className="flex-1 grid grid-cols-3 gap-1 text-center text-[10px]">
        <div><div className="text-slate-500">確率</div><div className="font-bold text-slate-900">{t.probability}%</div></div>
        <div><div className="text-slate-500">オッズ</div><div className="font-bold text-slate-900">{odds ?? "—"}</div></div>
        <div><div className="text-slate-500">期待値</div><div className={cn("font-bold", ev != null && ev >= 120 ? "text-emerald-400" : ev != null && ev >= 90 ? "text-amber-400" : "text-slate-600")}>{ev != null ? `${ev}%` : "—"}</div></div>
      </div>
    </div>
  );
}

function Metric({ label, v, highlight = false }) {
  return (
    <div className={cn("rounded-md py-1.5", highlight ? "bg-emerald-500/10" : "bg-white")}>
      <div className={cn("font-bold text-sm", highlight ? "text-emerald-500" : "text-slate-900")}>{v}</div>
      <div className="text-[9px] text-slate-500">{label}</div>
    </div>
  );
}