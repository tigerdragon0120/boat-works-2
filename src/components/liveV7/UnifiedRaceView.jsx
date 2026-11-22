import React from "react";
import LiveV7Panel from "@/components/liveV7/LiveV7Panel";
// 開始後も同じLiveV7Panelを保持して予想と結果を併記する。
import V8RaceJourney from "@/components/liveV8/V8RaceJourney";

// A partial exhibition is enough for an explicitly labelled, provisional V7 view.
// Missing inputs remain missing in the engine; never imply full exhibition quality.
export function exhibitionProgress(race, entries) {
  const scratched=new Set((race?.scratched_boats||[]).map(Number));
  const active=(entries||[]).filter(e=>!e.is_absent&&!e.is_scratched&&!scratched.has(Number(e.boat_number)));
  const valid=active.filter(e=>Number.isFinite(Number(e.exhibition_time)) && Number(e.exhibition_time)>0 &&
    e.exhibition_st!=null && Number.isFinite(Number(e.exhibition_st)) &&
    Number.isInteger(Number(e.exhibition_course)) && +e.exhibition_course>=1 && +e.exhibition_course<=6);
  const unique=new Set(valid.map(e=>Number(e.exhibition_course))).size===valid.length;
  const complete=active.length>=3 && valid.length===active.length && unique;
  return {ready:active.length>=3 && active.length<=6 && unique && (race?.exhibition_ready===true || valid.length>=3) && valid.length>=3,
    complete, valid:valid.length, total:active.length};
}

export default function UnifiedRaceView({race, entries=[], nextOpenRace=null, onSelectNextRace=()=>{}}) {
  const exhibition=exhibitionProgress(race,entries);
  const deadlineMs=Date.parse(race?.deadline||'');
  const raceClosed=['finished','cancelled'].includes(race?.status) || (Number.isFinite(deadlineMs)&&Date.now()>=deadlineMs);
  return <section className="space-y-4">
    <V8RaceJourney race={race} entries={entries}/>
    {raceClosed && nextOpenRace && <button type="button" onClick={onSelectNextRace} className="rounded-lg border border-sky-200 bg-sky-50 px-4 py-3 text-sm font-bold text-sky-900">締切前の {nextOpenRace.race_number}R を見る</button>}
    {(exhibition.ready||raceClosed) && <details className="rounded-xl border border-slate-200 bg-white p-3 sm:p-4">
      <summary className="cursor-pointer text-sm font-semibold text-slate-600">V7の保存予想・従来の判定を確認</summary>
      <div className="mt-3"><LiveV7Panel key={race.id} race={race} finalOnly readOnly={raceClosed} exhibitionComplete={exhibition.complete} exhibitionCount={exhibition.valid} activeBoatCount={exhibition.total}/></div>
    </details>}
  </section>;
}

