import React from "react";
import { cn } from "@/lib/utils";

// エンジン別の表示スタイル。PredictionPanelのタブ色と揃えている。
const STYLES = {
  "v6.1": { label: "合成(V6.1)", badge: "bg-fuchsia-600" },
  "v6.2": { label: "V6.2", badge: "bg-teal-500" },
};

const SCENARIO_LABEL = {
  "1_ESCAPE": "1号艇逃げ",
  "2_SASHI": "2号艇差し",
  "2_MAKURI": "2号艇まくり",
  "3_MAKURI": "3号艇まくり",
  "3_MAKURIZASHI": "3号艇まくり差し",
  "4_MAKURI": "4号艇まくり",
  "4_MAKURIZASHI": "4号艇まくり差し",
  "5_6_ATTACK": "5・6号艇攻め",
};

export default function EngineAlertBlock({ version, pred, stage }) {
  const style = STYLES[version] || { label: version, badge: "bg-slate-600" };
  const tickets = pred?.selected_trifectas || [];
  const isFinal = stage === "FINAL";

  return (
    <div className="rounded-lg border border-slate-200 bg-white p-2.5">
      <div className="flex items-center gap-2 flex-wrap">
        <span className={cn("px-2 py-0.5 rounded text-[10px] font-black text-white", style.badge)}>{style.label}</span>
        <span className={cn("px-1.5 py-0.5 rounded text-[10px] font-black", isFinal ? "bg-emerald-50 text-emerald-700 border border-emerald-200" : "bg-amber-50 text-amber-700 border border-amber-200")}>
          {isFinal ? "直前予想・確定" : "事前予想・暫定"}
        </span>
        {pred?.final_judgment && (
          <span className={cn(
            "px-1.5 py-0.5 rounded text-[10px] font-black border",
            pred.final_judgment === "BUY" ? "bg-[#fff1f6] text-[#d92d72] border-[#f6b6d0]" : "bg-slate-100 text-slate-600 border-slate-200",
          )}>
            {pred.final_judgment}
          </span>
        )}
        {pred?.ticket_count != null && <span className="text-[10px] text-slate-500">{pred.ticket_count}点買い</span>}
        {pred?.set_probability != null && (
          <span className="text-[10px] text-slate-600">セット的中率 <b className="text-slate-900">{pred.set_probability}%</b></span>
        )}
        {pred?.set_expected_recovery != null && (
          <span className="text-[10px] text-slate-600">
            期待回収 <b className={pred.set_expected_recovery >= 100 ? "text-emerald-600" : "text-slate-900"}>{pred.set_expected_recovery}%</b>
          </span>
        )}
      </div>

      {tickets.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {tickets.map((combo, idx) => (
            <span key={combo} className="px-2 py-1 rounded-md bg-slate-100 border border-slate-200 text-[11px] font-black text-slate-800">
              {idx + 1}. {combo}
            </span>
          ))}
        </div>
      )}

      {pred?.judgment_reason && (
        <div className="mt-2 text-[10px] leading-relaxed text-slate-600">{pred.judgment_reason}</div>
      )}

      <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5 text-[10px] text-slate-500">
        {pred?.honmei_boat != null && <span>本命 {pred.honmei_boat}号艇</span>}
        {pred?.taiko_boat != null && <span>対抗 {pred.taiko_boat}号艇</span>}
        {pred?.escape_probability != null && <span>1号艇逃げ {pred.escape_probability}</span>}
        {pred?.winning_scenario && <span>本線 {SCENARIO_LABEL[pred.winning_scenario] || pred.winning_scenario}</span>}
      </div>
    </div>
  );
}