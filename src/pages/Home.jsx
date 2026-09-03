import React, { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { RefreshCw, Clock, Waves } from "lucide-react";
import { listTodayRaces } from "@/lib/predictionService";
import { cn } from "@/lib/utils";

const gradeStyle = {
  S: "border-fuchsia-500 text-fuchsia-300 bg-fuchsia-500/10",
  A: "border-amber-400 text-amber-300 bg-amber-400/10",
  B: "border-emerald-500 text-emerald-300 bg-emerald-500/10",
  C: "border-slate-600 text-slate-400 bg-slate-700/20",
};
const judgmentStyle = {
  STRONG_BUY: "text-fuchsia-300",
  BUY: "text-rose-400",
  WATCH: "text-amber-300",
  SKIP: "text-slate-400",
  PENDING: "text-slate-500",
};

export default function Home() {
  const [races, setRaces] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState({});

  const load = async () => {
    setLoading(true);
    const list = await listTodayRaces({ includeFinished: false });
    setRaces(list || []);
    setLoading(false);
  };
  useEffect(() => { load(); }, []);

  const grouped = useMemo(() => {
    const map = new Map();
    for (const r of races) {
      const key = r.venue_code || r.venue || "unknown";
      if (!map.has(key)) map.set(key, { key, venue: r.venue || r.venue_name || key, races: [] });
      map.get(key).races.push(r);
    }
    return [...map.values()].map((g) => ({ ...g, races: g.races.sort((a, b) => a.race_number - b.race_number) }));
  }, [races]);

  useEffect(() => {
    if (!grouped.length) return;
    setSelected((prev) => {
      const next = { ...prev };
      for (const g of grouped) if (!next[g.key]) next[g.key] = g.races[0]?.id;
      return next;
    });
  }, [grouped]);

  const counts = useMemo(() => ({
    total: races.length,
    buy: races.filter((r) => ["BUY", "STRONG_BUY"].includes(r.final_judgment)).length,
    watch: races.filter((r) => r.final_judgment === "WATCH").length,
  }), [races]);

  return (
    <div className="space-y-4 text-slate-100">
      <div className="flex flex-wrap items-center gap-2">
        <Pill active label="本日のレース" value={counts.total} />
        <Pill label="BUY" value={counts.buy} tone="text-rose-400" />
        <Pill label="WATCH" value={counts.watch} tone="text-amber-300" />
        <button onClick={load} className="ml-auto h-9 px-3 rounded-lg border border-slate-700 bg-slate-900 text-slate-300 hover:bg-slate-800 flex items-center gap-2 text-xs font-semibold">
          <RefreshCw className={cn("w-4 h-4", loading && "animate-spin")} /> 更新
        </button>
      </div>

      {loading && <div className="py-24 text-center text-slate-500">読み込み中…</div>}
      {!loading && grouped.length === 0 && <div className="py-24 text-center text-slate-500">本日のレースがありません</div>}

      <div className="space-y-4">
        {grouped.map((g) => {
          const selectedRace = g.races.find((r) => r.id === selected[g.key]) || g.races[0];
          return <VenuePanel key={g.key} group={g} race={selectedRace} onSelect={(id) => setSelected((s) => ({ ...s, [g.key]: id }))} />;
        })}
      </div>
    </div>
  );
}

function VenuePanel({ group, race, onSelect }) {
  if (!race) return null;
  const grade = race.prediction_grade || "C";
  const judgment = race.final_judgment || "PENDING";
  const deadline = race.deadline ? new Date(race.deadline).toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" }) : "--:--";

  return (
    <section className="rounded-xl border border-slate-800 bg-[#0b1118] overflow-hidden shadow-xl shadow-black/10">
      <div className="px-4 py-3 border-b border-slate-800 flex items-center gap-3">
        <div className="w-7 h-7 rounded-lg bg-blue-600/15 border border-blue-500/30 flex items-center justify-center"><Waves className="w-4 h-4 text-blue-400" /></div>
        <div className="font-bold text-lg">{group.venue}</div>
        <div className="text-xs text-slate-500 tracking-wider">{String(group.key).padStart(2, "0")}</div>
        <div className="ml-auto text-xs text-slate-400 flex items-center gap-1.5"><Clock className="w-3.5 h-3.5" />{race.race_number}R 締切 {deadline}</div>
      </div>

      <div className="px-4 py-3 border-b border-slate-800 flex gap-1.5 overflow-x-auto">
        {group.races.map((r) => (
          <button key={r.id} onClick={() => onSelect(r.id)} className={cn(
            "min-w-12 h-8 rounded-md border text-xs font-bold transition",
            r.id === race.id ? "bg-amber-400 text-slate-950 border-amber-300" : "bg-slate-800/80 text-slate-300 border-slate-700 hover:border-slate-500"
          )}>{r.race_number}R</button>
        ))}
      </div>

      <div className="grid lg:grid-cols-[190px_1fr_230px]">
        <div className="p-4 border-b lg:border-b-0 lg:border-r border-slate-800">
          <div className="text-[11px] text-slate-500 mb-2">予想評価</div>
          <div className="flex items-center gap-3">
            <div className={cn("w-12 h-12 border-2 rounded-lg flex items-center justify-center text-2xl font-black", gradeStyle[grade])}>{grade}</div>
            <div className={cn("font-black text-xl", judgmentStyle[judgment])}>{judgment === "STRONG_BUY" ? "S BUY" : judgment}</div>
          </div>
          <div className="mt-4 space-y-2 text-xs">
            <StatLine label="的中期待度" value={race.top_probability != null ? `${race.top_probability}%` : "—"} />
            <StatLine label="推奨配当" value={race.top_odds != null ? `${race.top_odds}倍` : "—"} />
            <StatLine label="判定段階" value={race.has_final ? "FINAL" : "PRE"} />
          </div>
          <Link to={`/race/${race.id}`} className="mt-4 h-9 rounded-lg bg-blue-600 hover:bg-blue-500 text-white flex items-center justify-center text-xs font-bold">予想詳細を見る</Link>
        </div>

        <div className="p-4 border-b lg:border-b-0 lg:border-r border-slate-800">
          <div className="text-[11px] text-slate-500 mb-2">本命・買い目</div>
          <div className="grid grid-cols-3 gap-2">
            <BoatRole label="本命" n={race.honmei_boat} />
            <BoatRole label="対抗" n={race.taiko_boat} />
            <BoatRole label="穴" n={race.ana_boat} />
          </div>
          <div className="mt-4 text-[11px] text-slate-500">予想1位</div>
          <div className="mt-1 flex items-center gap-3">
            <div className="font-mono text-2xl font-black tracking-wider text-amber-300">{race.top_trifecta || "—"}</div>
            <div className="text-xs text-slate-400">{race.top_probability != null ? `${race.top_probability}%` : ""}</div>
          </div>
          <div className="mt-3 flex gap-2 flex-wrap">
            <MiniTag>{race.has_pre ? "PRE済" : "PRE待ち"}</MiniTag>
            <MiniTag>{race.has_final ? "FINAL済" : "FINAL待ち"}</MiniTag>
            {race.grade && <MiniTag>{race.grade}</MiniTag>}
          </div>
        </div>

        <div className="p-3 bg-[#080d13]">
          <div className="text-[11px] text-slate-500 mb-2">この場のレース一覧</div>
          <div className="space-y-1">
            {group.races.map((r) => (
              <button key={r.id} onClick={() => onSelect(r.id)} className={cn("w-full grid grid-cols-[34px_1fr_auto] items-center gap-2 px-2 py-1.5 rounded-md text-xs", r.id === race.id ? "bg-slate-800" : "hover:bg-slate-900") }>
                <span className="font-bold text-slate-300">{r.race_number}R</span>
                <span className="text-left text-slate-500 truncate">{r.deadline ? new Date(r.deadline).toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" }) : "--:--"}</span>
                <span className={cn("font-black", judgmentStyle[r.final_judgment || "PENDING"])}>{r.prediction_grade || "C"} {shortJudgment(r.final_judgment)}</span>
              </button>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

function shortJudgment(v) { if (v === "STRONG_BUY") return "BUY"; return v || "—"; }
function Pill({ label, value, active, tone }) { return <div className={cn("h-10 px-4 rounded-lg border flex items-center gap-2 text-xs font-bold", active ? "bg-blue-600/15 border-blue-500/30 text-blue-300" : "bg-slate-900 border-slate-800 text-slate-400")}><span>{label}</span><span className={cn("text-base", tone || "text-white")}>{value}</span></div>; }
function StatLine({ label, value }) { return <div className="flex justify-between gap-3"><span className="text-slate-500">{label}</span><span className="text-slate-200 font-semibold">{value}</span></div>; }
function MiniTag({ children }) { return <span className="px-2 py-1 rounded bg-slate-800 border border-slate-700 text-[10px] font-bold text-slate-300">{children}</span>; }
function BoatRole({ label, n }) {
  const colors = { 1:"bg-white text-black", 2:"bg-slate-500 text-white", 3:"bg-rose-600 text-white", 4:"bg-blue-600 text-white", 5:"bg-amber-400 text-black", 6:"bg-emerald-600 text-white" };
  return <div className="rounded-lg border border-slate-700 bg-slate-900 p-2"><div className="text-[10px] text-slate-500">{label}</div><div className="mt-1 flex items-center gap-2"><span className={cn("w-7 h-7 rounded flex items-center justify-center font-black", colors[n] || "bg-slate-700 text-white")}>{n || "-"}</span><span className="text-sm font-bold">{n ? `${n}号艇` : "—"}</span></div></div>;
}
