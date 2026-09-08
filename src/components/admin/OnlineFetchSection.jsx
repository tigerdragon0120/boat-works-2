import React, { useState, useEffect, useCallback } from "react";
import { fetchOnlineData, listTodayRacesForFetch } from "@/lib/dataManagementService";
import { Clock, DollarSign, Flag, Loader2, CheckCircle2, AlertTriangle, Zap } from "lucide-react";
import { cn } from "@/lib/utils";

const fetchTypes = [
  { key: "exhibition", label: "展示データ", desc: "展示タイム・展示ST・進入コース・チルト・欠場", icon: Clock, accent: "amber" },
  { key: "odds", label: "オッズ", desc: "3連単120通りのオッズを取得・期待値再計算", icon: DollarSign, accent: "purple" },
  { key: "result", label: "レース結果", desc: "着順・決まり手・払戻・予想検証", icon: Flag, accent: "emerald" },
];

const accentMap = {
  amber: "border-amber-200 bg-amber-50/50 text-amber-700",
  purple: "border-purple-200 bg-purple-50/50 text-purple-700",
  emerald: "border-emerald-200 bg-emerald-50/50 text-emerald-700",
};

export default function OnlineFetchSection() {
  const [races, setRaces] = useState([]);
  const [selectedRace, setSelectedRace] = useState("");
  const [batchBusy, setBatchBusy] = useState(null);
  const [batchProgress, setBatchProgress] = useState(null);
  const [results, setResults] = useState({});

  const load = useCallback(async () => {
    const r = await listTodayRacesForFetch();
    setRaces(r);
    if (r.length && !selectedRace) setSelectedRace(r[0].id);
  }, [selectedRace]);

  useEffect(() => { load(); }, [load]);

  const handleFetch = async (fetchType) => {
    if (!selectedRace) return;
    const race = races.find((r) => r.id === selectedRace);
    if (!race) return;
    setResults((p) => ({ ...p, [fetchType]: { busy: true } }));
    try {
      const r = await fetchOnlineData(fetchType, race.race_date, race.venue_code, race.race_number, race.id);
      setResults((p) => ({ ...p, [fetchType]: { ok: true, data: r.data } }));
    } catch (e) {
      setResults((p) => ({ ...p, [fetchType]: { ok: false, error: e?.response?.data?.error || e.message } }));
    }
  };

  const handleBatch = async (fetchType) => {
    setBatchBusy(fetchType);
    setBatchProgress({ done: 0, total: 0, errors: 0 });
    // 対象レース選別: 終了済みはスキップ、結果取得は締切後のみ
    const now = new Date();
    const applicable = races.filter((r) => {
      if (r.status === "finished") return false;
      if (fetchType === "result") return r.deadline && new Date(r.deadline) < now;
      return true;
    });
    setBatchProgress({ done: 0, total: applicable.length, errors: 0 });
    let done = 0, errors = 0;
    for (const race of applicable) {
      try {
        await fetchOnlineData(fetchType, race.race_date, race.venue_code, race.race_number, race.id);
      } catch { errors++; }
      done++;
      setBatchProgress({ done, total: applicable.length, errors });
      await new Promise((r) => setTimeout(r, 500));
    }
    setBatchBusy(null);
    setTimeout(() => setBatchProgress(null), 3000);
  };

  return (
    <div className="space-y-3">
      <div>
        <h2 className="text-lg font-bold text-slate-900">オンライン取得</h2>
        <p className="text-xs text-slate-500 mt-0.5">展示データ・オッズ・レース結果のみオンライン取得します。boatrace.jp公式サイトから自動取得。</p>
      </div>

      {/* レース選択 */}
      <div className="bg-white rounded-xl border border-slate-200 p-3">
        <div className="flex items-center gap-2">
          <label className="text-xs font-bold text-slate-700 shrink-0">対象レース:</label>
          <select value={selectedRace} onChange={(e) => setSelectedRace(e.target.value)} className="flex-1 h-8 px-2 rounded-lg border border-slate-200 text-sm">
            {races.length === 0 ? <option>今日のレースがありません</option> :
              races.map((r) => <option key={r.id} value={r.id}>{r.venue || r.venue_code} {r.race_number}R {r.deadline ? new Date(r.deadline).toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" }) : ""}</option>)}
          </select>
        </div>
      </div>

      {/* 一括取得プログレス */}
      {batchProgress && (
        <div className="bg-sky-50 border border-sky-200 rounded-lg p-2 text-xs text-sky-700 flex items-center gap-2">
          <Loader2 className="w-4 h-4 animate-spin" />
          一括取得中: {batchProgress.done}/{batchProgress.total} 完了 {batchProgress.errors > 0 && `(エラー${batchProgress.errors})`}
        </div>
      )}

 {/* 3種類の取得カード */}
      <div className="grid sm:grid-cols-3 gap-3">
        {fetchTypes.map((t) => {
          const r = results[t.key];
          return (
            <div key={t.key} className={cn("rounded-xl border p-3 space-y-2", accentMap[t.accent])}>
              <div className="flex items-center gap-2">
                <t.icon className="w-5 h-5" />
                <div>
                  <div className="font-bold text-sm">{t.label}取得</div>
                  <div className="text-[10px] text-slate-500">{t.desc}</div>
                </div>
              </div>

              <div className="flex gap-1.5">
                <button
                  onClick={() => handleFetch(t.key)}
                  disabled={!selectedRace || r?.busy}
                  className="flex-1 h-8 rounded-lg bg-slate-900 text-white text-xs font-semibold flex items-center justify-center gap-1 hover:bg-slate-800 disabled:opacity-40"
                >
                  {r?.busy ? <><Loader2 className="w-3.5 h-3.5 animate-spin" /> 取得中</> : "取得"}
                </button>
                <button
                  onClick={() => handleBatch(t.key)}
                  disabled={!!batchBusy}
                  className="h-8 px-2.5 rounded-lg bg-sky-600 text-white text-xs font-semibold flex items-center gap-1 hover:bg-sky-700 disabled:opacity-40"
                >
                  <Zap className="w-3.5 h-3.5" /> 一括
                </button>
              </div>

              {r?.ok && (
                <div className="bg-emerald-50 border border-emerald-200 rounded-lg p-1.5 flex items-center gap-1.5">
                  <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600" />
                  <span className="text-[10px] text-emerald-700">{r.data?.message || "取得完了"}</span>
                </div>
              )}
              {r?.ok === false && (
                <div className="bg-rose-50 border border-rose-200 rounded-lg p-1.5 flex items-start gap-1.5">
                  <AlertTriangle className="w-3.5 h-3.5 text-rose-500 mt-0.5 shrink-0" />
                  <span className="text-[10px] text-rose-700 break-all">{r.error}</span>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}