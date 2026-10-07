import React from "react";
import { cn } from "@/lib/utils";
import { AlertCircle, Gauge, Zap } from "lucide-react";
import PredictionJudgment from "@/components/race/PredictionJudgment";
import PredictionDetail from "@/components/race/PredictionDetail";
import V5ScenarioPanel from "@/components/race/V5ScenarioPanel";

const STAGE_TABS = [
  { key: "PRE", label: "事前予想", note: "出走表確定後" },
  { key: "FINAL", label: "直前予想", note: "展示・オッズ反映" },
];

// V6.1をメイン予想に置く(先頭)。他は根拠確認用の内訳。
const VERSION_TABS = [
  { key: "v61", label: "V6.1", activeCls: "bg-fuchsia-600 text-white shadow-sm" },
  { key: "mix", label: "合成", activeCls: "bg-rose-500 text-white shadow-sm" },
  { key: "v4", label: "V4", activeCls: "bg-blue-600 text-white shadow-sm" },
  { key: "v31", label: "V3.1", activeCls: "bg-violet-600 text-white shadow-sm" },
  { key: "v5", label: "V5", activeCls: "bg-cyan-500 text-slate-950 shadow-sm" },
];

export default function PredictionPanel({
  race, stage, stageTab, stages, onStageTabChange,
  run, busy, entries, activePred, activeBoats, allTri, compareData,
  pendingOdds, waitingFinalOdds, predictionVersion = "v61", onPredictionVersionChange,
}) {
  const hasPred = !!activePred;
  const isV61 = predictionVersion === "v61";
  const engineLabel = predictionVersion === "v31" ? "V3.1" : predictionVersion === "v61" ? "V6.1" : predictionVersion.toUpperCase();
  const stageLabel = stage === "FINAL" ? "直前予想" : stage === "PRE" ? "事前予想" : "予想待ち";

  return (
    <div className="bg-white rounded-xl border border-slate-200 overflow-hidden flex flex-col h-full">
      {/* ヘッダー: レース情報 + エンジン選択 */}
      <div className="px-3 sm:px-4 py-2.5 border-b border-slate-200 space-y-2.5">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="font-black text-slate-900 text-base sm:text-lg">{race.venue || "—"}</span>
            <span className="text-xs text-slate-600">{race.race_number}R</span>
          </div>
          {isV61 && activePred?.od3_status && stage === "FINAL" && (
            <span className={cn("px-1.5 h-5 rounded text-[9px] font-bold border flex items-center",
              activePred.od3_status === "READY"
                ? "bg-emerald-500/10 text-emerald-600 border-emerald-400/30"
                : activePred.od3_status === "ERROR"
                ? "bg-rose-500/10 text-rose-600 border-rose-400/30"
                : "bg-amber-500/10 text-amber-600 border-amber-400/30")}>
              OD3 {activePred.od3_status}
            </span>
          )}
        </div>
        <div className="grid grid-cols-5 gap-1 rounded-lg bg-slate-100 p-1">
          {VERSION_TABS.map((v) => (
            <button
              key={v.key}
              type="button"
              onClick={() => onPredictionVersionChange?.(v.key)}
              className={cn(
                "h-8 rounded-md text-xs font-black uppercase transition-colors",
                predictionVersion === v.key ? v.activeCls : "text-slate-500 hover:bg-white hover:text-slate-900"
              )}
            >
              {v.label}
            </button>
          ))}
        </div>
      </div>

      {/* メイン */}
      <div className="flex-1 p-3 sm:p-4 bg-gradient-to-b from-[#1e232d] to-[#161a22] flex flex-col overflow-auto">
        {predictionVersion === "v5" ? (
          <div className="flex flex-col gap-3">
            <V5ScenarioPanel entries={entries} activePred={activePred} />
            <div className="rounded-lg border border-cyan-400/20 bg-cyan-500/5 p-3 text-[10px] leading-relaxed text-cyan-100">
              V5はレース展開を比較するシナリオ予想です。買い目とBUY判定はV6.1タブで確認できます。
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {/* オッズ取得待ち */}
            {pendingOdds && (
              <div className="rounded-xl border-2 border-amber-400/60 bg-amber-500/10 p-2.5 flex items-center gap-2">
                <AlertCircle className="w-4 h-4 text-amber-400 shrink-0" />
                <div className="text-[11px] text-amber-300 font-semibold leading-relaxed">
                  {waitingFinalOdds
                    ? "直前予想 オッズ取得待ち — BOATCAST OD3未取得のため実オッズ・期待値は未表示。"
                    : "オッズ取得待ち — 実オッズ・期待値は未表示。"}
                </div>
              </div>
            )}

            {/* 予想判定(常にタブの上) */}
            {hasPred ? (
              <PredictionJudgment stage={stage} pred={activePred} allTri={allTri} race={race} />
            ) : (
              <div className="rounded-xl border border-slate-200 bg-white p-4 flex flex-col items-center text-center">
                <div className="w-14 h-14 rounded-full bg-slate-100 flex items-center justify-center mb-3">
                  <Zap className="w-7 h-7 text-[#f9c836]" />
                </div>
                <div className="text-slate-900 font-semibold text-sm mb-1">{engineLabel}予想生成待ち</div>
                <div className="text-slate-500 text-xs mb-4">
                  {isV61
                    ? "事前予想は出走表確定後に、直前予想は展示・オッズ取得後に自動生成されます"
                    : `${engineLabel}の生成を待っています`}
                </div>
                <div className="flex gap-2 w-full max-w-xs">
                  <button onClick={() => run("PRE")} disabled={busy || entries.length === 0}
                    className="flex-1 h-10 rounded-lg bg-slate-100 border border-slate-200 text-slate-900 font-semibold text-sm flex items-center justify-center gap-1.5 hover:bg-slate-200 disabled:opacity-50">
                    <Zap className="w-4 h-4" /> 事前
                  </button>
                  <button onClick={() => run("FINAL")} disabled={busy || entries.length === 0 || !race?.exhibition_ready}
                    className="flex-1 h-10 rounded-lg bg-[#f9c836] text-slate-950 font-semibold text-sm flex items-center justify-center gap-1.5 hover:bg-amber-300 disabled:opacity-50">
                    <Gauge className="w-4 h-4" /> 直前
                  </button>
                </div>
                {!race?.exhibition_ready && <div className="text-[10px] text-slate-500 mt-2">展示データ取得後に直前予想を生成できます</div>}
                {busy && <div className="text-xs text-[#f9c836] mt-3 animate-pulse">計算中…</div>}
              </div>
            )}

            {/* 事前予想 / 直前予想 タブ */}
            {isV61 && (
              <div className="grid grid-cols-2 gap-1 rounded-lg bg-slate-100 p-1">
                {STAGE_TABS.map((t) => {
                  const ready = !!stages?.[t.key];
                  return (
                    <button
                      key={t.key}
                      type="button"
                      onClick={() => onStageTabChange?.(t.key)}
                      className={cn(
                        "h-10 rounded-md flex flex-col items-center justify-center transition-colors",
                        stageTab === t.key ? "bg-[#f9c836] text-slate-950 shadow-sm" : "text-slate-500 hover:bg-white hover:text-slate-900"
                      )}
                    >
                      <span className="text-xs font-black flex items-center gap-1">
                        {t.label}
                        {!ready && <span className="text-[9px] font-bold opacity-70">未生成</span>}
                      </span>
                      <span className="text-[9px] opacity-80">{t.note}</span>
                    </button>
                  );
                })}
              </div>
            )}

            {/* 事前予想/直前予想の中身 */}
            {hasPred && (
              <PredictionDetail
                race={race} stage={stage} pred={activePred} boats={activeBoats}
                entries={entries} compareData={compareData}
                busy={busy} run={run} predictionVersion={predictionVersion}
              />
            )}
          </div>
        )}
      </div>

      {/* フッター */}
      <div className="px-3 py-2 border-t border-slate-200 flex items-center justify-between text-[11px]">
        <span className="text-slate-500">予想エンジン {engineLabel}</span>
        <span className="text-slate-500">{predictionVersion === "v5" ? "展開分析" : stageLabel}</span>
      </div>
    </div>
  );
}