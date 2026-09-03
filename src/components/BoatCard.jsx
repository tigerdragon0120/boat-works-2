import React from "react";
import { cn } from "@/lib/utils";
import { Crown, Shield, Sparkles, X } from "lucide-react";

export default function BoatCard({ entry, score, role }) {
  const roleInfo = {
    honmei: { label: "本命", icon: Crown, cls: "bg-amber-400 text-white" },
    taiko: { label: "対抗", icon: Shield, cls: "bg-sky-500 text-white" },
    ana: { label: "穴", icon: Sparkles, cls: "bg-rose-500 text-white" },
    keshi: { label: "消し", icon: X, cls: "bg-slate-300 text-slate-600" },
  };
  const ri = role ? roleInfo[role] : null;
  const RoleIcon = ri?.icon;

  return (
    <div className={cn("bg-white rounded-2xl border shadow-sm overflow-hidden", role === "honmei" ? "border-amber-200 ring-1 ring-amber-100" : role === "ana" ? "border-rose-100" : "border-slate-100")}>
      <div className="flex items-start gap-3 p-3">
        <div className="relative shrink-0">
          <div className="w-14 h-14 rounded-xl bg-gradient-to-br from-sky-100 to-blue-200 flex items-center justify-center font-display font-bold text-xl text-blue-700">
            {entry?.boat_number}
          </div>
          {ri && (
            <div className={cn("absolute -top-1.5 -left-1.5 w-6 h-6 rounded-full flex items-center justify-center shadow", ri.cls)}>
              <RoleIcon className="w-3.5 h-3.5" />
            </div>
          )}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-semibold text-slate-900 text-sm truncate">{entry?.player_name || `#${entry?.boat_number}`}</span>
            {entry?.player_class && <span className="text-[10px] px-1 rounded bg-slate-100 text-slate-500 font-medium">{entry.player_class}</span>}
          </div>
          <div className="text-[11px] text-slate-400">{entry?.register_number ? `登録${entry.register_number}` : ""}</div>
          {ri && <div className={cn("inline-block mt-1 px-1.5 h-5 rounded text-[10px] font-bold leading-5", ri.cls)}>{ri.label}</div>}
        </div>
        <div className="text-right shrink-0">
          <div className="text-[10px] text-slate-400">総合力</div>
          <div className="font-display font-bold text-2xl text-slate-900 leading-none">{score?.total_power?.toFixed(0) ?? "—"}</div>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-px bg-slate-100 text-center">
        <Power label="1着力" v={score?.first_power} tone="text-sky-600" />
        <Power label="2着力" v={score?.second_power} tone="text-blue-500" />
        <Power label="3着力" v={score?.third_power} tone="text-indigo-500" />
      </div>
      <div className="grid grid-cols-3 gap-px bg-slate-100 text-center border-t border-slate-100">
        <Mini label="ST力" v={score?.start_power} />
        <Mini label="モーター" v={score?.motor_power} />
        <Mini label="展示力" v={score?.exhibition_power} />
        <Mini label="当地適性" v={score?.local_fit} />
        <Mini label="節間調子" v={score?.section_form} />
        <Mini label="穴期待" v={score?.ana_potential} />
      </div>

      {score?.reasons?.length > 0 && (
        <div className="p-3 border-t border-slate-100">
          <div className="text-[10px] font-bold text-sky-600 mb-1">理由</div>
          <ul className="space-y-0.5">
            {score.reasons.map((r, i) => (
              <li key={i} className="text-[11px] text-slate-600 flex gap-1"><span className="text-sky-400">・</span>{r}</li>
            ))}
          </ul>
          {score?.notes?.length > 0 && (
            <>
              <div className="text-[10px] font-bold text-amber-600 mt-2 mb-1">注意</div>
              <ul className="space-y-0.5">
                {score.notes.map((n, i) => (
                  <li key={i} className="text-[11px] text-slate-500 flex gap-1"><span className="text-amber-400">・</span>{n}</li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function Power({ label, v, tone }) {
  return (
    <div className="bg-white py-2">
      <div className="text-[10px] text-slate-400">{label}</div>
      <div className={cn("font-display font-bold text-lg leading-none", tone)}>{v != null ? v : "—"}</div>
    </div>
  );
}

function Mini({ label, v }) {
  return (
    <div className="bg-white py-1.5">
      <div className="text-[10px] text-slate-400">{label}</div>
      <div className="font-semibold text-sm text-slate-700">{v != null ? v : "—"}</div>
    </div>
  );
}