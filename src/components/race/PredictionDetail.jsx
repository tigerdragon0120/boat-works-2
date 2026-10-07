import React from "react";
import { cn } from "@/lib/utils";
import { Activity, Crown, Gauge, RefreshCw, Shield, Sparkles, TrendingUp } from "lucide-react";
import PlayerPhoto from "@/components/race/PlayerPhoto";
import { formatRacerDisplayName } from "@/lib/racerIdentity";

const gradeStyle = {
  S: "border-fuchsia-400 text-fuchsia-300 bg-fuchsia-500/10",
  A: "border-amber-400 text-amber-300 bg-amber-400/10",
  B: "border-emerald-500 text-emerald-300 bg-emerald-500/10",
  C: "border-slate-600 text-slate-600 bg-slate-700/20",
};

const boatColors = {
  1: "bg-white text-black",
  2: "bg-slate-500 text-slate-900",
  3: "bg-rose-600 text-slate-900",
  4: "bg-blue-600 text-slate-900",
  5: "bg-amber-400 text-black",
  6: "bg-emerald-600 text-slate-900",
};

const STAGE_LABEL = { PRE: "事前予想", FINAL: "直前予想" };

// 判定の下に表示する各予想の中身(展開・6艇評価・役割・根拠)。
export default function PredictionDetail({ race, stage, pred, boats = [], entries = [], compareData = [], busy, run, predictionVersion = "v61" }) {
  const roles = resolveRoleBoats(pred, boats);
  const entryOf = (n) => entries.find((e) => e.boat_number === n);
  const compareTitle = predictionVersion === "v61" ? "事前予想 → 直前予想 変化" : "PRE → FINAL 変化";
  if (!pred) return null;

  return (
    <div className="flex flex-col gap-3">
      {/* 既存エンジンの展開ラベル */}
      <div className="flex items-center gap-3">
        <div className={cn("w-12 h-12 border-2 rounded-xl flex items-center justify-center text-xl font-black", gradeStyle[pred?.prediction_grade || "C"])}>
          {pred?.prediction_grade || "C"}
        </div>
        <div className="flex-1">
          <div className="text-[10px] text-slate-500 mb-0.5">既存エンジンの展開判定</div>
          <div className="font-black text-sm text-[#f9c836]">{pred?.race_scenario?.primary || "—"}</div>
          {pred?.race_scenario?.secondary && pred.race_scenario.secondary !== "—" && (
            <div className="text-[10px] text-slate-600 mt-0.5">{pred.race_scenario.secondary}</div>
          )}
        </div>
        <div className="text-right">
          <div className="text-[10px] text-slate-500">信頼度</div>
          <div className="font-black text-lg text-slate-200">{pred?.data_confidence ?? "—"}</div>
        </div>
      </div>

      {/* 本命/対抗/穴 */}
      <div className="grid grid-cols-3 gap-2">
        <RoleBox label="本命" n={roles.honmei} icon={Crown} cls="border-amber-400/40" entry={entryOf(roles.honmei)} />
        <RoleBox label="対抗" n={roles.taiko} icon={Shield} cls="border-blue-400/40" entry={entryOf(roles.taiko)} />
        <RoleBox label="穴" n={roles.ana} icon={Sparkles} cls="border-rose-400/40" entry={entryOf(roles.ana)} />
      </div>

      {/* PRE→FINAL比較 */}
      {compareData.length > 0 && (
        <div className="rounded-lg border border-slate-200 bg-white p-3">
          <div className="flex items-center gap-1.5 mb-2">
            <TrendingUp className="w-3.5 h-3.5 text-blue-400" />
            <span className="text-[11px] font-bold text-slate-600">{compareTitle}</span>
          </div>
          <div className="grid grid-cols-6 gap-1">
            {compareData.map((c) => (
              <div key={c.n} className="text-center">
                <div className={cn("w-6 h-6 mx-auto rounded flex items-center justify-center text-[10px] font-bold mb-0.5", boatColors[c.n])}>{c.n}</div>
                <div className={cn("text-xs font-bold", c.delta > 0 ? "text-emerald-400" : c.delta < 0 ? "text-rose-400" : "text-slate-500")}>
                  {c.delta > 0 ? "+" : ""}{c.delta}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 6艇スコアバー */}
      {boats.length > 0 && (
        <div className="rounded-lg border border-slate-200 bg-white p-3">
          <div className="flex items-center gap-1.5 mb-2">
            <Gauge className="w-3.5 h-3.5 text-blue-400" />
            <span className="text-[11px] font-bold text-slate-600">{STAGE_LABEL[stage] || ""} 6艇 総合力</span>
          </div>
          <div className="space-y-1.5">
            {boats.map((bp) => {
              const entry = entryOf(bp.boat_number);
              const pct = Math.min(100, bp.total_power || 0);
              return (
                <div key={bp.boat_number} className="flex items-center gap-2">
                  <span className={cn("w-5 h-5 rounded text-[10px] font-bold flex items-center justify-center shrink-0", boatColors[bp.boat_number])}>{bp.boat_number}</span>
                  <PlayerPhoto src={entry?.player_photo} registrationNumber={entry?.register_number || entry?.registration_number} alt={entry?.player_name} size="xs" />
                  <span className="text-[11px] text-slate-600 w-14 truncate shrink-0">{formatRacerDisplayName(entry?.player_name)}</span>
                  <div className="flex-1 h-2 rounded-full bg-slate-100 overflow-hidden">
                    <div className="h-full rounded-full bg-gradient-to-r from-blue-500 to-cyan-400" style={{ width: `${pct}%` }} />
                  </div>
                  <span className="text-xs font-bold text-slate-200 w-7 text-right shrink-0">{bp.total_power?.toFixed(0) ?? "—"}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* 展開予測理由 */}
      {pred?.race_scenario?.reasons?.length > 0 && (
        <div className="rounded-lg border border-slate-200 bg-white p-3">
          <div className="flex items-center gap-1.5 mb-1.5">
            <Activity className="w-3 h-3 text-[#f9c836]" />
            <span className="text-[11px] font-bold text-slate-600">展開予測の根拠</span>
          </div>
          <div className="space-y-0.5">
            {pred.race_scenario.reasons.map((r, i) => (
              <div key={i} className="text-[10px] text-slate-500">· {r}</div>
            ))}
          </div>
        </div>
      )}

      {/* 再実行 */}
      <div className="flex gap-2 mt-1">
        <button onClick={() => run("PRE")} disabled={busy || entries.length === 0}
          className="flex-1 h-9 rounded-lg bg-slate-100 border border-slate-200 text-slate-900 font-semibold text-xs flex items-center justify-center gap-1.5 hover:bg-slate-200 disabled:opacity-50">
          <RefreshCw className="w-3.5 h-3.5" /> 事前予想を再実行
        </button>
        <button onClick={() => run("FINAL")} disabled={busy || entries.length === 0 || !race?.exhibition_ready}
          className="flex-1 h-9 rounded-lg bg-[#f9c836] text-slate-950 font-semibold text-xs flex items-center justify-center gap-1.5 hover:bg-amber-300 disabled:opacity-50">
          <Gauge className="w-3.5 h-3.5" /> 直前予想を再実行
        </button>
      </div>
      {busy && <div className="text-xs text-[#f9c836] text-center animate-pulse">計算中…</div>}
      {!race?.exhibition_ready && <div className="text-[10px] text-slate-500 text-center">展示データ取得後に直前予想を生成できます</div>}
    </div>
  );
}

function resolveRoleBoats(pred, boats = []) {
  const rankedFirst = [...boats].sort((a, b) => (b.first_power || 0) - (a.first_power || 0));
  const honmei = pred?.honmei_boat ?? rankedFirst[0]?.boat_number;
  let taiko = pred?.taiko_boat;
  if (!taiko || taiko === honmei) {
    taiko = [...boats]
      .filter((b) => b.boat_number !== honmei)
      .sort((a, b) => ((b.second_power || 0) * 0.7 + (b.total_power || 0) * 0.3) - ((a.second_power || 0) * 0.7 + (a.total_power || 0) * 0.3))[0]?.boat_number;
  }
  let ana = pred?.ana_boat;
  if (!ana || ana === honmei || ana === taiko) {
    ana = [...boats]
      .filter((b) => b.boat_number !== honmei && b.boat_number !== taiko)
      .sort((a, b) => ((b.ana_potential || 0) * 0.7 + (b.first_power || 0) * 0.3) - ((a.ana_potential || 0) * 0.7 + (a.first_power || 0) * 0.3))[0]?.boat_number;
  }
  return { honmei, taiko, ana };
}

function RoleBox({ label, n, icon: Icon, cls, entry }) {
  return (
    <div className={cn("rounded-lg border bg-white p-2 text-center", cls)}>
      <div className="flex items-center justify-center gap-1 text-[10px] text-slate-600 mb-1">
        <Icon className="w-3 h-3" /> {label}
      </div>
      <div className="flex items-center justify-center gap-1.5 mb-1">
        <PlayerPhoto src={entry?.player_photo} registrationNumber={entry?.register_number || entry?.registration_number} alt={entry?.player_name} size="xs" />
        <div className={cn("w-7 h-7 rounded flex items-center justify-center font-black text-sm", n ? boatColors[n] : "bg-slate-700 text-slate-500")}>{n || "—"}</div>
      </div>
      {entry?.player_name && <div className="text-[10px] text-slate-600 truncate">{formatRacerDisplayName(entry.player_name)}</div>}
    </div>
  );
}