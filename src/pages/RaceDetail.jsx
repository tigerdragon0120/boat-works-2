import React, { useState, useEffect } from "react";
import { useParams, Link } from "react-router-dom";
import { base44 } from "@/api/base44Client";
import {
  getRaceEntries, getPrediction, getBoatPredictions, getTrifectaPredictions,
  generateAndSavePrediction, getSettings,
} from "@/lib/predictionService";
import { decideBetPlan } from "@/lib/predictionEngine";
import BoatCard from "@/components/BoatCard";
import { ArrowLeft, Zap, Gauge, Trophy, TrendingUp, AlertTriangle, CheckCircle2, XCircle } from "lucide-react";
import { cn } from "@/lib/utils";

const judgmentStyle = {
  STRONG_BUY: "bg-emerald-600 text-white",
  BUY: "bg-emerald-500 text-white",
  WATCH: "bg-amber-400 text-white",
  SKIP: "bg-slate-200 text-slate-500",
};

export default function RaceDetail() {
  const { id } = useParams();
  const [race, setRace] = useState(null);
  const [entries, setEntries] = useState([]);
  const [pre, setPre] = useState(null);
  const [fin, setFin] = useState(null);
  const [preBoats, setPreBoats] = useState([]);
  const [finBoats, setFinBoats] = useState([]);
  const [preTri, setPreTri] = useState([]);
  const [finTri, setFinTri] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [view, setView] = useState("FINAL");
  const [rankMode, setRankMode] = useState("prob");

  const load = async () => {
    setLoading(true);
    const r = await base44.entities.Race.get(id);
    setRace(r);
    const es = await getRaceEntries(id);
    setEntries(es || []);
    const p = await getPrediction(id, "PRE");
    const f = await getPrediction(id, "FINAL");
    setPre(p); setFin(f);
    if (p) {
      setPreBoats(await getBoatPredictions(p.id));
      setPreTri(await getTrifectaPredictions(p.id));
    }
    if (f) {
      setFinBoats(await getBoatPredictions(f.id));
      setFinTri(await getTrifectaPredictions(f.id));
      setView("FINAL");
    } else if (p) {
      setView("PRE");
    }
    setLoading(false);
  };
  useEffect(() => { load(); }, [id]);

  const run = async (stage) => {
    setBusy(true);
    try {
      const settings = await getSettings();
      await generateAndSavePrediction(race, entries, settings, stage, {});
      await load();
    } catch (e) {
      alert("予想生成に失敗: " + e.message);
    }
    setBusy(false);
  };

  if (loading) return <div className="text-center py-20 text-slate-400 text-sm">読み込み中…</div>;
  if (!race) return <div className="text-center py-20 text-slate-400">レースが見つかりません</div>;

  const activePred = view === "FINAL" ? fin : pre;
  const activeBoats = (view === "FINAL" ? finBoats : preBoats).sort((a, b) => a.boat_number - b.boat_number);
  const allTri = view === "FINAL" ? finTri : preTri;
  const probRank = [...allTri].sort((a, b) => a.rank - b.rank).slice(0, 10);
  const evRank = [...allTri].sort((a, b) => b.expected_value - a.expected_value).slice(0, 10);
  const activeTri = rankMode === "prob" ? probRank : evRank;
  const betPlan = activePred ? decideBetPlan(allTri, { min_confidence: 40 }, { dataConfidence: activePred.data_confidence, stage: view }) : null;

  const roleOf = (n) => {
    if (activePred?.honmei_boat === n) return "honmei";
    if (activePred?.taiko_boat === n) return "taiko";
    if (activePred?.ana_boat === n) return "ana";
    if (activePred?.keshi_boat === n) return "keshi";
    return null;
  };

  // PRE→FINAL比較
  const compareData = preBoats.length && finBoats.length
    ? [1, 2, 3, 4, 5, 6].map((n) => {
        const pb = preBoats.find((b) => b.boat_number === n);
        const fb = finBoats.find((b) => b.boat_number === n);
        if (!pb || !fb) return null;
        return { n, pre: pb.total_power, final: fb.total_power, delta: fb.total_power - pb.total_power };
      }).filter(Boolean)
    : [];

  return (
    <div>
      <Link to="/" className="inline-flex items-center gap-1 text-sm text-slate-500 hover:text-sky-600 mb-3">
        <ArrowLeft className="w-4 h-4" /> レース一覧
      </Link>

      {/* ヘッダー */}
      <div className="bg-gradient-to-br from-sky-600 to-blue-700 rounded-2xl p-4 text-white shadow-md">
        <div className="flex items-start justify-between">
          <div>
            <div className="text-xs text-sky-100 font-medium">{race.venue} · {race.race_type || "一般"} {race.grade ? `· ${race.grade}` : ""}</div>
            <div className="font-display font-bold text-2xl mt-0.5">第{race.race_number}R</div>
          </div>
          <div className="text-right">
            <div className="text-xs text-sky-100">締切</div>
            <div className="font-mono font-bold">{race.deadline ? new Date(race.deadline).toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" }) : "--:--"}</div>
          </div>
        </div>
        <div className="grid grid-cols-4 gap-2 mt-3 text-center text-[11px]">
          <Weather label="天候" v={race.weather} />
          <Weather label="風" v={race.wind_speed != null ? `${race.wind_dir || ""} ${race.wind_speed}m` : null} />
          <Weather label="波" v={race.wave_height != null ? `${race.wave_height}cm` : null} />
          <Weather label="水温" v={race.water_temp != null ? `${race.water_temp}℃` : null} />
        </div>
      </div>

      {/* アクション */}
      <div className="flex gap-2 mt-3">
        <button onClick={() => run("PRE")} disabled={busy || entries.length === 0}
          className="flex-1 h-10 rounded-xl bg-white border border-sky-200 text-sky-700 font-semibold text-sm flex items-center justify-center gap-1.5 hover:bg-sky-50 disabled:opacity-50">
          <Zap className="w-4 h-4" /> PRE予想
        </button>
        <button onClick={() => run("FINAL")} disabled={busy || entries.length === 0}
          className="flex-1 h-10 rounded-xl bg-sky-600 text-white font-semibold text-sm flex items-center justify-center gap-1.5 hover:bg-sky-700 disabled:opacity-50">
          <Gauge className="w-4 h-4" /> FINAL予想
        </button>
      </div>
      {busy && <div className="text-center text-xs text-sky-500 mt-2 animate-pulse">計算中…</div>}

      {/* ステージ切替 */}
      {(pre || fin) && (
        <div className="flex gap-2 mt-4">
          {pre && <StageBtn active={view === "PRE"} onClick={() => setView("PRE")} label="PRE(展示前)" />}
          {fin && <StageBtn active={view === "FINAL"} onClick={() => setView("FINAL")} label="FINAL(展示後)" />}
        </div>
      )}

      {!activePred && !busy && (
        <div className="text-center py-10 text-slate-400 text-sm bg-white rounded-2xl border border-dashed border-slate-200 mt-4">
          予想未実行です。上のボタンで{view === "FINAL" ? "FINAL" : "PRE"}予想を実行してください。
        </div>
      )}

      {/* 6艇カード */}
      {activePred && (
        <>
          <div className="flex items-center gap-2 mt-5 mb-2">
            <Trophy className="w-4 h-4 text-sky-600" />
            <h2 className="font-display font-bold text-slate-900">6艇評価</h2>
            <span className="text-xs text-slate-400">信頼度 {activePred.data_confidence}</span>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            {activeBoats.map((bp) => {
              const entry = entries.find((e) => e.boat_number === bp.boat_number);
              return <BoatCard key={bp.boat_number} entry={entry} score={bp} role={roleOf(bp.boat_number)} />;
            })}
          </div>

          {/* PRE→FINAL比較 */}
          {compareData.length > 0 && (
            <div className="mt-5 bg-white rounded-2xl border border-slate-100 p-3">
              <div className="flex items-center gap-2 mb-2">
                <TrendingUp className="w-4 h-4 text-sky-600" />
                <h3 className="font-display font-bold text-sm text-slate-900">PRE → FINAL 変化</h3>
              </div>
              <div className="grid grid-cols-6 gap-1.5">
                {compareData.map((c) => (
                  <div key={c.n} className="text-center">
                    <div className="text-[10px] text-slate-400">{c.n}号</div>
                    <div className="text-[10px] text-slate-400">{c.pre}→{c.final}</div>
                    <div className={cn("text-xs font-bold", c.delta > 0 ? "text-emerald-600" : c.delta < 0 ? "text-rose-500" : "text-slate-400")}>
                      {c.delta > 0 ? "+" : ""}{c.delta}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* 3連単ランキング */}
          <div className="flex items-center justify-between mt-5 mb-2">
            <div className="flex items-center gap-2">
              <TrendingUp className="w-4 h-4 text-sky-600" />
              <h2 className="font-display font-bold text-slate-900">3連単ランキング</h2>
            </div>
            <div className="flex gap-1">
              <button onClick={() => setRankMode("prob")} className={cn("px-2.5 h-7 rounded-lg text-[11px] font-bold", rankMode === "prob" ? "bg-sky-600 text-white" : "bg-white border border-slate-200 text-slate-500")}>予想(確率)</button>
              <button onClick={() => setRankMode("ev")} className={cn("px-2.5 h-7 rounded-lg text-[11px] font-bold", rankMode === "ev" ? "bg-emerald-600 text-white" : "bg-white border border-slate-200 text-slate-500")}>買い目(期待値)</button>
            </div>
          </div>
          {betPlan && (
            <div className={cn("mb-2 rounded-xl px-3 py-2 text-xs flex items-center gap-2", betPlan.tier === "skip" ? "bg-slate-100 text-slate-600" : betPlan.tier === "1-3" ? "bg-emerald-50 text-emerald-700" : "bg-amber-50 text-amber-700")}>
              <span className="font-bold">推奨買い目</span>
              <span className="font-bold">{betPlan.tier === "skip" ? "見送り" : `${betPlan.tier}点`}</span>
              <span className="text-slate-400">· {betPlan.reason}</span>
            </div>
          )}
          <div className="bg-white rounded-2xl border border-slate-100 overflow-hidden">
            {activeTri.map((t) => (
              <div key={t.combination} className="flex items-center px-3 py-2.5 border-b border-slate-50 last:border-0">
                <div className="w-7 text-center">
                  <span className={cn("inline-flex w-6 h-6 rounded-md items-center justify-center text-xs font-bold", t.rank <= 3 ? "bg-sky-600 text-white" : "bg-slate-100 text-slate-500")}>{t.rank}</span>
                </div>
                <div className="font-mono font-bold text-slate-900 text-base w-20">{t.combination}</div>
                <div className="flex-1 grid grid-cols-3 gap-1 text-center text-[11px]">
                  <div><div className="text-slate-300">確率</div><div className="font-semibold text-slate-700">{t.probability}%</div></div>
                  <div><div className="text-slate-300">オッズ</div><div className="font-semibold text-slate-700">{t.actual_odds != null ? t.actual_odds : t.estimated_odds}</div></div>
                  <div><div className="text-slate-300">期待値</div><div className={cn("font-semibold", t.expected_value >= 150 ? "text-emerald-600" : t.expected_value >= 110 ? "text-amber-500" : "text-slate-500")}>{t.expected_value}%</div></div>
                </div>
                <span className={cn("px-2 h-6 rounded-md text-[11px] font-bold flex items-center ml-2", judgmentStyle[t.judgment])}>{t.judgment}</span>
              </div>
            ))}
            {activeTri.length === 0 && <div className="text-center py-6 text-slate-400 text-sm">買い目データがありません</div>}
          </div>
          {activePred.top_judgment && (
            <div className="mt-3 text-xs text-slate-500 bg-sky-50 rounded-xl p-3">
              <span className="font-bold text-slate-700">総合判定: </span>
              {activePred.top_trifecta} / 確率{activePred.top_probability}% / 期待値{activePred.top_expected_value}% →
              <span className="font-bold text-sky-700 ml-1">{activePred.top_judgment}</span>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function Weather({ label, v }) {
  return (
    <div className="bg-white/15 rounded-lg py-1">
      <div className="text-sky-100">{label}</div>
      <div className="font-semibold">{v || "—"}</div>
    </div>
  );
}

function StageBtn({ active, onClick, label }) {
  return (
    <button onClick={onClick} className={cn("flex-1 h-9 rounded-lg text-sm font-semibold transition-colors", active ? "bg-slate-900 text-white" : "bg-white border border-slate-200 text-slate-500")}>{label}</button>
  );
}