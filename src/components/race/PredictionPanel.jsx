import React from "react";
import { cn } from "@/lib/utils";
import { Crown, Shield, Sparkles, TrendingUp, Gauge, Trophy, Zap, Activity, Target, Calculator, Ticket } from "lucide-react";
import PlayerPhoto from "@/components/race/PlayerPhoto";

const gradeStyle = {
  S: "border-fuchsia-400 text-fuchsia-300 bg-fuchsia-500/10",
  A: "border-amber-400 text-amber-300 bg-amber-400/10",
  B: "border-emerald-500 text-emerald-300 bg-emerald-500/10",
  C: "border-slate-600 text-slate-600 bg-slate-700/20",
};

const judgmentConfig = {
  BUY: { label: "BUY", cls: "bg-rose-500/20 text-rose-300 border-rose-400/50", bar: "bg-rose-500" },
  WATCH: { label: "WATCH", cls: "bg-amber-500/20 text-amber-300 border-amber-400/50", bar: "bg-amber-500" },
  SKIP: { label: "SKIP", cls: "bg-slate-700/40 text-slate-600 border-slate-600", bar: "bg-slate-600" },
  PENDING: { label: "—", cls: "bg-slate-700/40 text-slate-500 border-slate-600", bar: "bg-slate-600" },
};

const boatColors = {
  1: "bg-white text-black",
  2: "bg-slate-500 text-slate-900",
  3: "bg-rose-600 text-slate-900",
  4: "bg-blue-600 text-slate-900",
  5: "bg-amber-400 text-black",
  6: "bg-emerald-600 text-slate-900",
};

const groupStyle = {
  A: "text-rose-300 bg-rose-500/10 border-rose-400/30",
  B: "text-amber-300 bg-amber-500/10 border-amber-400/30",
  C: "text-slate-600 bg-slate-700/30 border-slate-600",
};

export default function PredictionPanel({ race, pre, fin, view, setView, run, busy, entries, activePred, activeBoats, allTri, compareData }) {
  const hasPred = pre || fin;
  const judgment = activePred?.final_judgment || "PENDING";
  const jcfg = judgmentConfig[judgment] || judgmentConfig.PENDING;
  const selectedTri = (allTri || []).filter((t) => t.is_selected).sort((a, b) => (a.ticket_rank || 99) - (b.ticket_rank || 99));
  // 旧予想データに本命/対抗/穴の重複が残っていても表示時に必ず補正する。
  const roles = resolveRoleBoats(activePred, activeBoats);

  return (
    <div className="bg-white rounded-xl border border-slate-200 overflow-hidden flex flex-col h-full">
      {/* ヘッダー */}
      <div className="px-3 sm:px-4 py-2.5 border-b border-slate-200 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="font-black text-slate-900 text-base sm:text-lg">{race.venue || "—"}</span>
          <span className="text-xs text-slate-600">{race.race_number}R</span>
        </div>
        <div className="flex gap-1">
          {pre && <TabBtn active={view === "PRE"} onClick={() => setView("PRE")} label="PRE" />}
          {fin && <TabBtn active={view === "FINAL"} onClick={() => setView("FINAL")} label="FINAL" />}
        </div>
      </div>

      {/* メイン */}
      <div className="flex-1 p-3 sm:p-4 bg-gradient-to-b from-[#1e232d] to-[#161a22] flex flex-col overflow-auto">
        {!hasPred ? (
          <div className="flex-1 flex flex-col items-center justify-center text-center py-10">
            <div className="w-16 h-16 rounded-full bg-slate-100 flex items-center justify-center mb-3">
              <Zap className="w-8 h-8 text-[#f9c836]" />
            </div>
            <div className="text-slate-700 font-semibold text-sm mb-1">予想未実行</div>
            <div className="text-slate-500 text-xs mb-4">PRE/FINAL予想を実行すると<br />買い目と判定が表示されます</div>
            <div className="flex gap-2 w-full max-w-xs">
              <button onClick={() => run("PRE")} disabled={busy || entries.length === 0}
                className="flex-1 h-10 rounded-lg bg-slate-100 border border-slate-200 text-slate-900 font-semibold text-sm flex items-center justify-center gap-1.5 hover:bg-slate-200 disabled:opacity-50">
                <Zap className="w-4 h-4" /> PRE
              </button>
              <button onClick={() => run("FINAL")} disabled={busy || entries.length === 0}
                className="flex-1 h-10 rounded-lg bg-[#f9c836] text-slate-950 font-semibold text-sm flex items-center justify-center gap-1.5 hover:bg-amber-300 disabled:opacity-50">
                <Gauge className="w-4 h-4" /> FINAL
              </button>
            </div>
            {busy && <div className="text-xs text-[#f9c836] mt-3 animate-pulse">計算中…</div>}
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {/* === 1. 最終判定 BUY/WATCH/SKIP === */}
            <div className={cn("rounded-xl border-2 p-3 flex items-center gap-3", jcfg.cls)}>
              <div className="text-center shrink-0">
                <div className="text-[10px] text-slate-600 mb-0.5">最終判定</div>
                <div className={cn("w-16 h-16 rounded-xl border-2 flex items-center justify-center text-2xl font-black", jcfg.cls)}>
                  {jcfg.label}
                </div>
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-[10px] text-slate-600">買い目</span>
                  <span className="px-2 py-0.5 rounded bg-slate-100 text-slate-900 text-xs font-bold">{activePred?.ticket_count || "—"}点</span>
                  {activePred?.ticket_strategy && (
                    <span className="text-[10px] text-slate-500 truncate">{activePred.ticket_strategy}</span>
                  )}
                </div>
                <div className="text-[11px] text-slate-700 leading-relaxed">{activePred?.judgment_reason || "—"}</div>
                {activePred?.expand_reason && (
                  <div className="text-[10px] text-amber-400/80 mt-1">拡張: {activePred.expand_reason}</div>
                )}
              </div>
            </div>

            {/* === 2. 買い目一覧 6-8点 === */}
            <div className="rounded-lg border border-slate-200 bg-white p-3">
              <div className="flex items-center gap-1.5 mb-2">
                <Ticket className="w-3.5 h-3.5 text-[#f9c836]" />
                <span className="text-[11px] font-bold text-slate-600">買い目 {selectedTri.length}点</span>
              </div>
              {selectedTri.length > 0 ? (
                <div className="space-y-1">
                  {selectedTri.map((t) => (
                    <TicketRow key={t.combination} t={t} />
                  ))}
                </div>
              ) : (
                <div className="text-xs text-slate-500 py-2 text-center">買い目データがありません</div>
              )}
            </div>

            {/* === 3. セット期待値・合成オッズ === */}
            {activePred?.set_probability != null && (
              <div className="rounded-lg border border-slate-200 bg-white p-3">
                <div className="flex items-center gap-1.5 mb-2">
                  <Calculator className="w-3.5 h-3.5 text-blue-400" />
                  <span className="text-[11px] font-bold text-slate-600">セット分析</span>
                </div>
                <div className="grid grid-cols-2 gap-2 text-center">
                  <Metric label="セット的中率" v={activePred.set_probability != null ? `${activePred.set_probability}%` : "—"} />
                  <Metric label="合成オッズ" v={activePred.synthetic_odds != null ? `${activePred.synthetic_odds}倍` : "—"} />
                  <Metric label="期待回収率" v={activePred.set_expected_recovery != null ? `${activePred.set_expected_recovery}%` : "—"} highlight={activePred.set_expected_recovery >= 120} />
                  <Metric label="平均払戻" v={activePred.avg_payout != null ? `${activePred.avg_payout}円` : "—"} />
                  <Metric label="最低払戻" v={activePred.min_payout != null ? `${activePred.min_payout}円` : "—"} />
                  <Metric label="最高払戻" v={activePred.max_payout != null ? `${activePred.max_payout}円` : "—"} />
                </div>
                {activePred.best_ev_ticket && (
                  <div className="mt-2 pt-2 border-t border-slate-200 text-[10px] text-slate-500 flex justify-between">
                    <span>最高EV: <span className="font-mono font-bold text-emerald-400">{activePred.best_ev_ticket}</span></span>
                    {activePred.worst_efficiency_ticket && <span>低効率: <span className="font-mono text-slate-600">{activePred.worst_efficiency_ticket}</span></span>}
                  </div>
                )}
              </div>
            )}

            {/* === 4. 展開予測 === */}
            <div className="flex items-center gap-3">
              <div className={cn("w-12 h-12 border-2 rounded-xl flex items-center justify-center text-xl font-black", gradeStyle[activePred?.prediction_grade || "C"])}>
                {activePred?.prediction_grade || "C"}
              </div>
              <div className="flex-1">
                <div className="text-[10px] text-slate-500 mb-0.5">展開予測</div>
                <div className="font-black text-sm text-[#f9c836]">{activePred?.race_scenario?.primary || "—"}</div>
                {activePred?.race_scenario?.secondary && activePred.race_scenario.secondary !== "—" && (
                  <div className="text-[10px] text-slate-600 mt-0.5">{activePred.race_scenario.secondary}</div>
                )}
              </div>
              <div className="text-right">
                <div className="text-[10px] text-slate-500">信頼度</div>
                <div className="font-black text-lg text-slate-200">{activePred?.data_confidence ?? "—"}</div>
              </div>
            </div>

            {/* 本命/対抗/穴 */}
            <div className="grid grid-cols-3 gap-2">
              <RoleBox label="本命" n={roles.honmei} icon={Crown} cls="border-amber-400/40" photo={entries.find((e) => e.boat_number === roles.honmei)?.player_photo} reg={entries.find((e) => e.boat_number === roles.honmei)?.register_number || entries.find((e) => e.boat_number === roles.honmei)?.registration_number} name={entries.find((e) => e.boat_number === roles.honmei)?.player_name} />
              <RoleBox label="対抗" n={roles.taiko} icon={Shield} cls="border-blue-400/40" photo={entries.find((e) => e.boat_number === roles.taiko)?.player_photo} reg={entries.find((e) => e.boat_number === roles.taiko)?.register_number || entries.find((e) => e.boat_number === roles.taiko)?.registration_number} name={entries.find((e) => e.boat_number === roles.taiko)?.player_name} />
              <RoleBox label="穴" n={roles.ana} icon={Sparkles} cls="border-rose-400/40" photo={entries.find((e) => e.boat_number === roles.ana)?.player_photo} reg={entries.find((e) => e.boat_number === roles.ana)?.register_number || entries.find((e) => e.boat_number === roles.ana)?.registration_number} name={entries.find((e) => e.boat_number === roles.ana)?.player_name} />
            </div>

            {/* 展開予測理由 */}
            {activePred?.race_scenario?.reasons?.length > 0 && (
              <div className="rounded-lg border border-slate-200 bg-white p-3">
                <div className="flex items-center gap-1.5 mb-1.5">
                  <Activity className="w-3 h-3 text-[#f9c836]" />
                  <span className="text-[11px] font-bold text-slate-600">展開予測の根拠</span>
                </div>
                <div className="space-y-0.5">
                  {activePred.race_scenario.reasons.map((r, i) => (
                    <div key={i} className="text-[10px] text-slate-500">· {r}</div>
                  ))}
                </div>
              </div>
            )}

            {/* PRE→FINAL比較 */}
            {compareData.length > 0 && (
              <div className="rounded-lg border border-slate-200 bg-white p-3">
                <div className="flex items-center gap-1.5 mb-2">
                  <TrendingUp className="w-3.5 h-3.5 text-blue-400" />
                  <span className="text-[11px] font-bold text-slate-600">PRE → FINAL 変化</span>
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
            {activeBoats.length > 0 && (
              <div className="rounded-lg border border-slate-200 bg-white p-3">
                <div className="flex items-center gap-1.5 mb-2">
                  <Gauge className="w-3.5 h-3.5 text-blue-400" />
                  <span className="text-[11px] font-bold text-slate-600">6艇 総合力</span>
                </div>
                <div className="space-y-1.5">
                  {activeBoats.map((bp) => {
                    const entry = entries.find((e) => e.boat_number === bp.boat_number);
                    const pct = Math.min(100, bp.total_power || 0);
                    return (
                      <div key={bp.boat_number} className="flex items-center gap-2">
                        <span className={cn("w-5 h-5 rounded text-[10px] font-bold flex items-center justify-center shrink-0", boatColors[bp.boat_number])}>{bp.boat_number}</span>
                        <PlayerPhoto src={entry?.player_photo} registrationNumber={entry?.register_number || entry?.registration_number} alt={entry?.player_name} size="xs" />
                        <span className="text-[11px] text-slate-600 w-14 truncate shrink-0">{entry?.player_name || ""}</span>
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

            {/* 再実行ボタン */}
            <div className="flex gap-2 mt-1">
              <button onClick={() => run("PRE")} disabled={busy || entries.length === 0}
                className="flex-1 h-9 rounded-lg bg-slate-100 border border-slate-200 text-slate-900 font-semibold text-xs flex items-center justify-center gap-1.5 hover:bg-slate-200 disabled:opacity-50">
                <Zap className="w-3.5 h-3.5" /> PRE再実行
              </button>
              <button onClick={() => run("FINAL")} disabled={busy || entries.length === 0}
                className="flex-1 h-9 rounded-lg bg-[#f9c836] text-slate-950 font-semibold text-xs flex items-center justify-center gap-1.5 hover:bg-amber-300 disabled:opacity-50">
                <Gauge className="w-3.5 h-3.5" /> FINAL再実行
              </button>
            </div>
            {busy && <div className="text-xs text-[#f9c836] text-center animate-pulse">計算中…</div>}
          </div>
        )}
      </div>

      {/* フッター */}
      <div className="px-3 py-2 border-t border-slate-200 flex items-center justify-between text-[11px]">
        <span className="text-slate-500">予想エンジン v5</span>
        <span className="text-slate-500">{race.has_final ? "FINAL済" : race.has_pre ? "PRE済" : "予想待ち"}</span>
      </div>
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

function Metric({ label, v, highlight }) {
  return (
    <div className={cn("rounded-md py-1.5", highlight ? "bg-emerald-500/10" : "bg-white")}>
      <div className={cn("font-bold text-sm", highlight ? "text-emerald-500" : "text-slate-900")}>{v}</div>
      <div className="text-[9px] text-slate-500">{label}</div>
    </div>
  );
}

function TabBtn({ active, onClick, label }) {
  return (
    <button onClick={onClick} className={cn("px-3 h-7 rounded-md text-xs font-bold transition-colors", active ? "bg-[#f9c836] text-slate-950" : "bg-slate-100 text-slate-600 hover:text-slate-900")}>{label}</button>
  );
}

function resolveRoleBoats(activePred, activeBoats = []) {
  const rankedFirst = [...activeBoats].sort((a, b) => (b.first_power || 0) - (a.first_power || 0));
  const honmei = activePred?.honmei_boat ?? rankedFirst[0]?.boat_number;
  let taiko = activePred?.taiko_boat;
  if (!taiko || taiko === honmei) {
    taiko = [...activeBoats]
      .filter((b) => b.boat_number !== honmei)
      .sort((a, b) => ((b.second_power || 0) * 0.7 + (b.total_power || 0) * 0.3) - ((a.second_power || 0) * 0.7 + (a.total_power || 0) * 0.3))[0]?.boat_number;
  }
  let ana = activePred?.ana_boat;
  if (!ana || ana === honmei || ana === taiko) {
    ana = [...activeBoats]
      .filter((b) => b.boat_number !== honmei && b.boat_number !== taiko)
      .sort((a, b) => ((b.ana_potential || 0) * 0.7 + (b.first_power || 0) * 0.3) - ((a.ana_potential || 0) * 0.7 + (a.first_power || 0) * 0.3))[0]?.boat_number;
  }
  return { honmei, taiko, ana };
}

function RoleBox({ label, n, icon: Icon, cls, photo, reg, name }) {
  const boatColors = {
    1: "bg-white text-black", 2: "bg-slate-500 text-slate-900", 3: "bg-rose-600 text-slate-900",
    4: "bg-blue-600 text-slate-900", 5: "bg-amber-400 text-black", 6: "bg-emerald-600 text-slate-900",
  };
  return (
    <div className={cn("rounded-lg border bg-white p-2 text-center", cls)}>
      <div className="flex items-center justify-center gap-1 text-[10px] text-slate-600 mb-1">
        <Icon className="w-3 h-3" /> {label}
      </div>
      <div className="flex items-center justify-center gap-1.5 mb-1">
        <PlayerPhoto src={photo} registrationNumber={reg} alt={name} size="xs" />
        <div className={cn("w-7 h-7 rounded flex items-center justify-center font-black text-sm", n ? boatColors[n] : "bg-slate-700 text-slate-500")}>{n || "—"}</div>
      </div>
      {name && <div className="text-[10px] text-slate-600 truncate">{name}</div>}
    </div>
  );
}