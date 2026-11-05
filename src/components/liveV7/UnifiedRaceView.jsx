import React, {useMemo} from "react";
import LiveV7Panel from "@/components/liveV7/LiveV7Panel";
import {buildV5ScenarioForecast} from "@/lib/v5ScenarioEngine";

function completeExhibition(race, entries) {
  const active=(entries||[]).filter(e=>!e.is_absent&&!e.is_scratched);
  return Boolean(race?.exhibition_ready && active.length >= 3 &&
    active.every(e=>Number.isFinite(Number(e.exhibition_time)) && Number(e.exhibition_time)>0 &&
      e.exhibition_st!=null && e.exhibition_course!=null &&
      Number.isInteger(Number(e.exhibition_course)) && +e.exhibition_course>=1 && +e.exhibition_course<=6) &&
    new Set(active.map(e=>Number(e.exhibition_course))).size===active.length);
}

export default function UnifiedRaceView({race, entries}) {
  const exhibitReady=completeExhibition(race,entries);
  const originalEntries=useMemo(()=>entries.map(({exhibition_course,exhibition_st,exhibition_time,exhibition_rank,...rest})=>rest),[entries]);
  const scenarios=useMemo(()=>originalEntries.length===6 ? buildV5ScenarioForecast(originalEntries,null) : null,[originalEntries]);
  return <section className="rounded-xl border border-blue-200 bg-white p-3 sm:p-4 space-y-3">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div>
        <h2 className="text-lg font-black text-slate-900">レース予想</h2>
        <p className="text-xs text-slate-600">
          {exhibitReady ? "展示データを反映した統合V7の予想判定" : "展示前：出走表から展開を予想。展示が揃うとV7の予想判定を表示"}
        </p>
      </div>
      <span className={exhibitReady?"rounded-lg bg-emerald-100 px-3 py-2 text-sm font-bold text-emerald-800":"rounded-lg bg-amber-100 px-3 py-2 text-sm font-bold text-amber-800"}>
        {exhibitReady?"展示反映・V7":"展開予想"}
      </span>
    </div>
    {!exhibitReady ? <div className="space-y-3">
      {scenarios ? <>
        <div className="rounded-lg bg-slate-50 border border-slate-200 p-3">
          <p className="font-bold text-slate-900">{scenarios.verdict}</p>
          <p className="text-xs text-slate-600 mt-1">イン防御 {scenarios.insideDefense} / 外攻撃 {scenarios.outsideAttack}</p>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
          {scenarios.scenarios.slice(0,6).map((item,i)=><article key={item.key} className="rounded-lg border border-slate-200 p-3 bg-white">
            <div className="flex justify-between items-center gap-2"><span className="text-sm font-semibold">{i+1}. {item.label}</span><span className="text-sm font-bold text-indigo-700">{item.probability}%</span></div>
            <p className="mt-1 text-xs text-slate-500">{item.reason}</p>
          </article>)}
        </div>
        <p className="text-xs text-slate-500">事前の展開シナリオ（未校正の参考分析）。展示ST・展示タイムを先取りしません。</p>
      </> : <p className="rounded-lg bg-slate-50 p-3 text-sm text-slate-600">出走表が6艇揃うまで展開予想を保留しています。</p>}
      <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
        展示進入・ST・タイムの取得待ちです。揃ったら、この位置に統合V7のFINAL判定と買い目を自動表示します。
      </div>
    </div> : <LiveV7Panel key={race.id} race={race} finalOnly />}
  </section>;
}
