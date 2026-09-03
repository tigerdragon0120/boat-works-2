import React, { useState, useEffect } from "react";
import { base44 } from "@/api/base44Client";
import { listTodayRaces } from "@/lib/predictionService";
import { Link } from "react-router-dom";
import { Clock, ChevronRight, Eye, EyeOff, Filter, RefreshCw } from "lucide-react";
import { cn } from "@/lib/utils";

const gradeStyle = {
  S: "bg-gradient-to-br from-amber-400 to-amber-600 text-white",
  A: "bg-gradient-to-br from-sky-500 to-blue-600 text-white",
  B: "bg-slate-200 text-slate-700",
  C: "bg-slate-100 text-slate-400",
};

const judgmentStyle = {
  STRONG_BUY: "bg-emerald-600 text-white",
  BUY: "bg-emerald-500 text-white",
  WATCH: "bg-amber-400 text-white",
  SKIP: "bg-slate-200 text-slate-500",
  PENDING: "bg-slate-100 text-slate-400",
};

const filters = [
  { key: "all", label: "全て" },
  { key: "S", label: "S" },
  { key: "A", label: "A" },
  { key: "B", label: "B" },
  { key: "BUY", label: "BUY" },
  { key: "WATCH", label: "WATCH" },
  { key: "ana", label: "穴狙い" },
];

export default function Home() {
  const [races, setRaces] = useState(null);
  const [showFinished, setShowFinished] = useState(false);
  const [filter, setFilter] = useState("all");
  const [loading, setLoading] = useState(true);

  const load = async () => {
    setLoading(true);
    const list = await listTodayRaces({ includeFinished: showFinished });
    setRaces(list);
    setLoading(false);
  };
  useEffect(() => { load(); }, [showFinished]);

  const filtered = (races || []).filter((r) => {
    if (filter === "all") return true;
    if (filter === "S" || filter === "A" || filter === "B") return r.prediction_grade === filter;
    if (filter === "BUY") return r.final_judgment === "STRONG_BUY" || r.final_judgment === "BUY";
    if (filter === "WATCH") return r.final_judgment === "WATCH";
    if (filter === "ana") return r.ana_boat != null && r.ana_boat !== r.honmei_boat;
    return true;
  });
  // S/A/B上位表示
  const gradeOrder = { S: 0, A: 1, B: 2, C: 3 };
  const sorted = [...filtered].sort((a, b) => (gradeOrder[a.prediction_grade] ?? 4) - (gradeOrder[b.prediction_grade] ?? 4));

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <div>
          <h1 className="text-xl font-display font-bold text-slate-900">今日のレース</h1>
          <p className="text-xs text-slate-500 mt-0.5">{new Date().toLocaleDateString("ja-JP", { month: "long", day: "numeric", weekday: "short" })}</p>
        </div>
        <button onClick={load} className="w-9 h-9 rounded-lg border border-sky-200 text-sky-600 flex items-center justify-center hover:bg-sky-50">
          <RefreshCw className={cn("w-4 h-4", loading && "animate-spin")} />
        </button>
      </div>

      <div className="flex items-center gap-2 mb-4 overflow-x-auto pb-1">
        <div className="flex items-center gap-1 text-slate-400 shrink-0">
          <Filter className="w-3.5 h-3.5" />
        </div>
        {filters.map((f) => (
          <button
            key={f.key}
            onClick={() => setFilter(f.key)}
            className={cn(
              "px-3 h-7 rounded-full text-xs font-semibold whitespace-nowrap transition-colors",
              filter === f.key ? "bg-sky-600 text-white" : "bg-white border border-slate-200 text-slate-600 hover:border-sky-300"
            )}
          >
            {f.label}
          </button>
        ))}
        <button
          onClick={() => setShowFinished((v) => !v)}
          className={cn("ml-auto px-2.5 h-7 rounded-full text-xs font-semibold flex items-center gap-1 shrink-0", showFinished ? "bg-slate-700 text-white" : "bg-white border border-slate-200 text-slate-500")}
        >
          {showFinished ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
          終了
        </button>
      </div>

      {loading && <div className="text-center py-20 text-slate-400 text-sm">読み込み中…</div>}
      {!loading && sorted.length === 0 && (
        <div className="text-center py-20 text-slate-400 text-sm">
          <p>対象レースがありません。</p>
          <p className="mt-1 text-xs">サンプルレースを登録するには管理画面をご利用ください。</p>
        </div>
      )}

      <div className="grid gap-3">
        {sorted.map((r) => (
          <RaceCard key={r.id} race={r} />
        ))}
      </div>
    </div>
  );
}

function RaceCard({ race }) {
  const grade = race.prediction_grade || "C";
  const judg = race.final_judgment || "PENDING";
  return (
    <Link to={`/race/${race.id}`} className="block bg-white rounded-2xl border border-slate-100 shadow-sm hover:shadow-md hover:border-sky-200 transition-all overflow-hidden">
      <div className="flex">
        <div className="flex flex-col items-center justify-center px-3 py-3 bg-slate-50 border-r border-slate-100 min-w-[68px]">
          <div className={cn("w-10 h-10 rounded-xl flex items-center justify-center font-display font-bold text-lg shadow-sm", gradeStyle[grade])}>{grade}</div>
          <div className="text-[10px] text-slate-400 mt-1">R{race.race_number}</div>
        </div>
        <div className="flex-1 p-3">
          <div className="flex items-start justify-between">
            <div>
              <div className="font-semibold text-slate-900 text-sm">{race.venue}</div>
              <div className="flex items-center gap-2 mt-0.5 text-[11px] text-slate-500">
                <span className="flex items-center gap-0.5"><Clock className="w-3 h-3" />{race.deadline ? new Date(race.deadline).toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" }) : "--:--"}</span>
                <span>·</span>
                <span>{race.race_type || "一般"}</span>
                {race.grade && <><span>·</span><span className="text-sky-600 font-medium">{race.grade}</span></>}
              </div>
            </div>
            <span className={cn("px-2 h-6 rounded-md text-[11px] font-bold flex items-center", judgmentStyle[judg])}>{judg}</span>
          </div>

          <div className="grid grid-cols-3 gap-2 mt-3 text-center">
            <Role label="本命" n={race.honmei_boat} color="text-sky-600" />
            <Role label="対抗" n={race.taiko_boat} color="text-blue-500" />
            <Role label="穴" n={race.ana_boat} color="text-rose-500" />
          </div>

          <div className="flex items-center justify-between mt-3 pt-2.5 border-t border-slate-100">
            <div className="text-xs">
              <span className="text-slate-400">予想1位 </span>
              <span className="font-mono font-bold text-slate-900">{race.top_trifecta || "—"}</span>
              <span className="text-slate-400 ml-2">{race.top_probability != null ? `${race.top_probability}%` : ""}</span>
            </div>
            <div className="flex items-center gap-1.5">
              <StageTag active={race.has_pre} label="PRE" />
              <StageTag active={race.has_final} label="FINAL" />
              <ChevronRight className="w-4 h-4 text-slate-300" />
            </div>
          </div>
        </div>
      </div>
    </Link>
  );
}

function Role({ label, n, color }) {
  return (
    <div className="rounded-lg bg-slate-50 py-1.5">
      <div className="text-[10px] text-slate-400">{label}</div>
      <div className={cn("font-display font-bold text-lg leading-tight", color)}>{n != null ? `${n}号` : "—"}</div>
    </div>
  );
}

function StageTag({ active, label }) {
  return (
    <span className={cn("px-1.5 h-5 rounded text-[10px] font-bold flex items-center", active ? "bg-sky-100 text-sky-700" : "bg-slate-100 text-slate-300")}>{label}</span>
  );
}