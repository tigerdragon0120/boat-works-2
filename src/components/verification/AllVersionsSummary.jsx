import React, { useEffect, useState } from "react";
import { base44 } from "@/api/base44Client";
import { getV2VerificationSummary } from "@/lib/predictionService";
import { getV61Summary } from "@/lib/v61ComparisonSummary";
import { dedupeVerifications } from "@/lib/verificationUtils";

const pct = n => Math.round(Number(n || 0) * 10) / 10;
const normal = (label, buy=0, hits=0, rate=0, recovery=0) => ({ label, buy:Number(buy||0), hits:Number(hits||0), rate:pct(rate), recovery:pct(recovery) });
function aggregate(rows, cfg) {
  const buy = dedupeVerifications(rows || []).filter(v => v[cfg.judgment] === "BUY" && v[cfg.hit] != null);
  const hits = buy.filter(v => v[cfg.hit] === true).length;
  const investment = buy.reduce((s,v)=>s+Number(v[cfg.investment]||0),0);
  const payout = buy.reduce((s,v)=>s+Number(v[cfg.payout]||0),0);
  return normal(cfg.label,buy.length,hits,buy.length?hits/buy.length*100:0,investment?payout/investment*100:0);
}
function v5FromV2(rows) {
  const source=dedupeVerifications(rows||[]).filter(v=>v.v2_final_judgment==="BUY"&&v.v2_recommended_hit!=null);
  const kept=source.filter(v=>{
    const scores=Array.isArray(v.v2_boat_scores)?v.v2_boat_scores:[];
    const tc=Number(v.v2_ticket_count||0); if(scores.length!==6||tc<6||tc>8)return false;
    const ranked=[...scores].filter(s=>Number.isFinite(Number(s.final_score))).sort((a,b)=>Number(b.final_score)-Number(a.final_score));
    if(ranked.length<2)return false;
    const top=ranked[0], second=ranked[1], boat=Number(top.boat_number), gap=Number(top.final_score)-Number(second.final_score);
    const recentTop2=[...scores].sort((a,b)=>Number(b.recent_score||0)-Number(a.recent_score||0)).slice(0,2).some(s=>Number(s.boat_number)===boat);
    const todayTop2=[...scores].sort((a,b)=>Number(b.today_score||0)-Number(a.today_score||0)).slice(0,2).some(s=>Number(s.boat_number)===boat);
    return Number(top.final_score)>=52&&gap>=5&&Number(top.recent_score)>=34&&Number(top.today_score)>=52&&recentTop2&&todayTop2&&(boat<5||(gap>=9&&Number(top.recent_score)>=38));
  });
  const hits=kept.filter(v=>v.v2_recommended_hit===true).length, inv=kept.reduce((s,v)=>s+Number(v.v2_investment||0),0), ret=kept.reduce((s,v)=>s+Number(v.v2_payout||0),0);
  return normal("V5",kept.length,hits,kept.length?hits/kept.length*100:0,inv?ret/inv*100:0);
}
export default function AllVersionsSummary(){
 const [rows,setRows]=useState(null);
 useEffect(()=>{(async()=>{try{
  const [v12,v3,v31,v4,v2rows,v61]=await Promise.all([
   getV2VerificationSummary().catch(()=>null),
   base44.entities.PredictionV3Verification.list("-verified_at",1000).catch(()=>[]),
   base44.entities.PredictionV31Verification.list("-created_date",1000).catch(()=>[]),
   base44.entities.PredictionV4Verification.list("-verified_at",1000).catch(()=>[]),
   base44.entities.PredictionV2Verification.list("-verified_at",1000).catch(()=>[]),
   getV61Summary(0).catch(()=>null)
  ]);
  const data=[
   normal("V1",v12?.v1?.buy_count,v12?.v1?.buy_hits,v12?.v1?.buy_hit_rate,v12?.v1?.buy_recovery_rate),
   normal("V2",v12?.v2?.buy_count,v12?.v2?.buy_hits,v12?.v2?.buy_hit_rate,v12?.v2?.buy_recovery_rate),
   aggregate(v3,{label:"V3",judgment:"v3_final_judgment",hit:"v3_recommended_hit",investment:"v3_investment",payout:"v3_payout"}),
   aggregate(v31,{label:"V3.1",judgment:"v3_final_judgment",hit:"v3_recommended_hit",investment:"v3_investment",payout:"v3_payout"}),
   aggregate(v4,{label:"V4",judgment:"v4_final_judgment",hit:"v4_recommended_hit",investment:"v4_investment",payout:"v4_payout"}),
   v5FromV2(v2rows),
   normal("V6.1",v61?.buy_count,v61?.hits,v61?.hit_rate,v61?.recovery_rate)
  ]; setRows(data);
 }catch(e){console.error("AllVersionsSummary",e);setRows([])}})()},[]);
 if(rows===null)return <div className="py-5 text-center text-sm text-slate-400">V1〜V6.1を集計中…</div>;
 return <section className="rounded-2xl border border-slate-200 bg-white p-4">
  <div className="mb-3"><div className="text-[10px] font-bold text-slate-400">ALL ENGINE PERFORMANCE</div><h2 className="text-lg font-black text-slate-900">V1〜V6.1 成績一覧</h2><p className="mt-1 text-[10px] text-slate-400">各エンジンの全期間BUY実績。下に個別の詳細検証を表示します。</p></div>
  <div className="overflow-x-auto"><table className="w-full min-w-[620px] text-sm">
   <thead><tr className="border-b border-slate-200 text-[11px] text-slate-400"><th className="py-2 text-left">VERSION</th><th className="text-right">BUY数</th><th className="text-right">的中数</th><th className="text-right">的中率</th><th className="text-right">回収率</th></tr></thead>
   <tbody>{rows.map(r=><tr key={r.label} className={`border-b border-slate-100 last:border-0 ${r.label==="V6.1"?"bg-fuchsia-50/50":""}`}><td className="py-3 font-black text-slate-900">{r.label}{r.label==="V6.1"&&<span className="ml-2 rounded bg-fuchsia-100 px-1.5 py-0.5 text-[9px] text-fuchsia-700">MAIN</span>}</td><td className="text-right font-bold">{r.buy}R</td><td className="text-right font-bold">{r.hits}R</td><td className="text-right font-bold">{r.rate}%</td><td className={`text-right font-black ${r.recovery>=100?"text-emerald-600":"text-rose-500"}`}>{r.recovery}%</td></tr>)}</tbody>
  </table></div>
 </section>;
}