import React, { useEffect, useState } from "react";
import { BellRing, RefreshCw } from "lucide-react";
import { base44 } from "@/api/base44Client";
import { cn } from "@/lib/utils";
import BuyAlertCard from "@/components/alerts/BuyAlertCard";

// 一覧に必要な項目だけを読む(trifectas120通りは不要)
const ALERT_FIELDS = [
  "race_id", "race_key", "stage", "prediction_version", "final_judgment", "judgment_reason",
  "selected_trifectas", "ticket_count", "set_probability", "set_expected_recovery",
  "honmei_boat", "taiko_boat", "escape_probability", "winning_scenario", "computed_at", "status",
];

const DEADLINE_MAX = Number.MAX_SAFE_INTEGER;

function jstDate(offset = 0) {
  return new Date(Date.now() + offset * 86400000).toLocaleDateString("sv-SE", { timeZone: "Asia/Tokyo" });
}

function deadlineMs(race) {
  return race?.deadline ? new Date(race.deadline).getTime() : DEADLINE_MAX;
}

export default function BuyAlerts() {
  const [scope, setScope] = useState("today");
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [now, setNow] = useState(Date.now());
  const [refreshToken, setRefreshToken] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      setLoading(true);
      const dates = [jstDate(0)];
      if (scope === "tomorrow") dates[0] = jstDate(1);
      try {
        const [racePage, predPage] = await Promise.all([
          base44.entities.Race.filter({ race_date: { $in: dates } }, "deadline", 300),
          base44.entities.PredictionV6.filter(
            { race_key: { $regex: `^(${dates.join("|")})` }, final_judgment: "BUY" },
            "-computed_at", 300, ALERT_FIELDS,
          ),
        ]);
        if (cancelled) return;
        const races = racePage?.items || racePage || [];
        const preds = predPage?.items || predPage || [];
        const raceByKey = new Map(races.map((r) => [String(r.race_key), r]));
        const raceById = new Map(races.map((r) => [r.id, r]));

        // race_key単位でエンジン(v6.1/v6.2)・ステージ(PRE/FINAL)ごとに最新のBUY予想を持たせる
        const grouped = new Map();
        for (const p of preds) {
          if (p.status && p.status !== "COMPLETED") continue;
          if (!["v6.1", "v6.2"].includes(String(p.prediction_version))) continue;
          const race = raceByKey.get(String(p.race_key)) || raceById.get(p.race_id);
          if (!race) continue;
          const entry = grouped.get(String(p.race_key)) || { race, versions: {} };
          const slot = entry.versions[p.prediction_version] || {};
          const current = slot[p.stage];
          if (!current || String(p.computed_at || "") > String(current.computed_at || "")) slot[p.stage] = p;
          entry.versions[p.prediction_version] = slot;
          grouped.set(String(p.race_key), entry);
        }

        const stamp = Date.now();
        const list = [...grouped.values()]
          .map((e) => ({ ...e, confirmed: Object.values(e.versions).some((v) => !!v.FINAL) }))
          .sort((a, b) => {
            const am = deadlineMs(a.race);
            const bm = deadlineMs(b.race);
            const aPast = am <= stamp;
            const bPast = bm <= stamp;
            if (aPast !== bPast) return aPast ? 1 : -1;
            return aPast ? bm - am : am - bm;
          });
        setRows(list);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    load();
    const id = setInterval(load, 120000);
    return () => { cancelled = true; clearInterval(id); };
  }, [scope, refreshToken]);

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30000);
    return () => clearInterval(id);
  }, []);

  const confirmedCount = rows.filter((r) => r.confirmed).length;
  const urgentCount = rows.filter((r) => {
    const ms = deadlineMs(r.race);
    return ms !== DEADLINE_MAX && ms > now && ms - now <= 30 * 60000;
  }).length;

  return (
    <div className="text-[#26364d] space-y-3 pb-2">
      <div className="rounded-xl border border-[#d4dde9] bg-white p-3 sm:p-4 shadow-sm">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="w-9 h-9 rounded-lg bg-[#fff1f6] border border-[#f6b6d0] flex items-center justify-center shrink-0">
              <BellRing className="w-5 h-5 text-[#f02f7d]" />
            </div>
            <div className="min-w-0">
              <h1 className="text-lg sm:text-xl font-black text-[#123d9c]">BUYアラート</h1>
              <div className="text-[10px] text-slate-500">合成(V6.1) または V6.2 がBUY判定したレース</div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <div className="flex rounded-lg bg-slate-100 p-1">
              {[["today", "今日"], ["tomorrow", "明日"]].map(([key, label]) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => setScope(key)}
                  className={cn(
                    "h-8 px-3 rounded-md text-xs font-black transition-colors",
                    scope === key ? "bg-white text-[#123d9c] shadow-sm" : "text-slate-500 hover:text-slate-900",
                  )}
                >
                  {label}
                </button>
              ))}
            </div>
            <button
              onClick={() => { setNow(Date.now()); setRefreshToken((t) => t + 1); }}
              className="h-8 px-3 rounded-lg border border-[#e8c900] bg-[#ffe600] text-[#16254a] shadow-sm flex items-center gap-1.5 text-xs font-black hover:bg-[#ffeb33] active:scale-[0.98] transition"
            >
              <RefreshCw className={cn("w-3.5 h-3.5", loading && "animate-spin")} />
              更新
            </button>
          </div>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-2 text-[11px]">
          <span className="px-2.5 py-1 rounded-lg bg-[#fff1f6] border border-[#f6b6d0] font-black text-[#d92d72]">BUY {rows.length}レース</span>
          <span className="px-2.5 py-1 rounded-lg bg-white border border-[#d4dde9] font-bold text-slate-600">確定 {confirmedCount}</span>
          <span className="px-2.5 py-1 rounded-lg bg-white border border-[#d4dde9] font-bold text-slate-600">暫定 {rows.length - confirmedCount}</span>
          <span className="px-2.5 py-1 rounded-lg bg-white border border-[#d4dde9] font-bold text-slate-600">30分以内に締切 {urgentCount}</span>
          <span className="ml-auto text-[10px] text-slate-500">{scope === "today" ? jstDate(0) : jstDate(1)} 開催分・締切が近い順（2分ごと自動更新）</span>
        </div>
      </div>

      {loading && !rows.length ? (
        <div className="rounded-xl border border-[#d4dde9] bg-white p-8 text-center text-xs text-slate-500">読み込み中…</div>
      ) : rows.length === 0 ? (
        <div className="rounded-xl border border-[#d4dde9] bg-white p-8 text-center">
          <div className="text-sm font-black text-slate-900">{scope === "today" ? "本日" : "明日"}はBUY判定のレースがありません</div>
          <div className="mt-1 text-[11px] text-slate-500">
            展示・オッズ取得後に判定が確定すると、ここに表示されます。
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">
          {rows.map((row) => (
            <BuyAlertCard key={row.race.id} row={row} now={now} />
          ))}
        </div>
      )}
    </div>
  );
}