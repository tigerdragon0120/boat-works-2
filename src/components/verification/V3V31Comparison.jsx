import React, { useCallback, useEffect, useState } from "react";
import { base44 } from "@/api/base44Client";
import { cn } from "@/lib/utils";
import { dedupeVerifications } from "@/lib/verificationUtils";
import { Target, CheckCircle2, XCircle, AlertCircle } from "lucide-react";

const PERIODS=[["50","直近50 BUY"],["100","直近100 BUY"],["300","直近300 BUY"],["all","全期間"]];
const HIT_TARGET=16, REC_TARGET=100;

function aggregate(rows, period){
  const limit=period==="all"?99999:Number(period);
  const buy=dedupeVerifications(rows||[]).filter(v=>v.v3_final_judgment==="BUY" && v.v3_recommended_hit!=null).slice(0,limit);
  const hits=buy.filter(v=>v.v3_recommended_hit).length;
  const investment=buy.reduce((s,v)=>s+Number(v.v3_investment||0),0);
  const payout=buy.reduce((s,v)=>s+Number(v.v3_payout||0),0);
  const reasons={};
  buy.filter(v=>!v.v3_recommended_hit).forEach(v=>{if(v.miss_reason_primary) reasons[v.miss_reason_primary]=(reasons[v.miss_reason_primary]||0)+1});
  return {buy_count:buy.length,hit_count:hits,hit_rate:buy.length?hits/buy.length*100:0,investment,payout,recovery_rate:investment?payout/investment*100:0,
    miss_reasons:Object.entries(reasons).map(([reason,count])=>({reason,count})).sort((a,b)=>b.count-a.count)};
}
function Card({label,d,newOne}){
 const hit=d.hit_rate>=HIT_TARGET, rec=d.recovery_rate>=REC_TARGET;
 return <div className={cn("rounded-lg p-3 border",newOne?"bg-violet-950/50 border-violet-700":"bg-slate-900 border-slate-700")}>
  <div className="flex gap-1.5 items-center mb-3">{newOne&&<span className="bg-violet-600 text-white text-[9px] px-1.5 py-.5 rounded font-bold">NEW</span>}<b className={newOne?"text-violet-300 text-xs":"text-slate-300 text-xs"}>{label}</b></div>
  {[["BUY的中率",d.hit_rate,HIT_TARGET,hit],["BUY回収率",d.recovery_rate,REC_TARGET,rec]].map(([l,v,t,ok])=><div className="mb-3" key={l}><div className="flex justify-between text-[10px] text-slate-400"><span>{l}</span>{ok?<CheckCircle2 className="w-3 h-3 text-emerald-400"/>:<XCircle className="w-3 h-3 text-rose-400"/>}</div><div><b className={cn("text-lg",ok?"text-emerald-400":"text-slate-200")}>{Number(v).toFixed(1)}%</b><span className="text-[10px] text-slate-500"> / TARGET {t}%</span></div></div>)}
  <div className="grid grid-cols-2 gap-1 text-[10px] text-slate-400 border-t border-slate-700 pt-2"><div>BUY: <b className="text-slate-200">{d.buy_count}</b></div><div>的中: <b className="text-slate-200">{d.hit_count}</b></div><div>投資: <b className="text-slate-200">{d.investment.toLocaleString()}円</b></div><div>払戻: <b className="text-slate-200">{d.payout.toLocaleString()}円</b></div></div>
 </div>
}
export default function V3V31Comparison(){
 const [period,setPeriod]=useState("100"),[data,setData]=useState(null),[loading,setLoading]=useState(true);
 const load=useCallback(async()=>{setLoading(true);try{
   const [v3,v31]=await Promise.all([base44.entities.PredictionV3Verification.list("-verified_at",1000).catch(()=>[]),base44.entities.PredictionV31Verification.list("-verified_at",1000).catch(()=>[])]);
   setData({v3:aggregate(v3,period),v31:aggregate(v31,period)});
 }finally{setLoading(false)}},[period]);
 useEffect(()=>{load()},[load]);
 if(loading)return <div className="text-center text-slate-400 py-8 text-sm">V3.1検証データ読み込み中…</div>;
 const {v3,v31}=data;
 return <div className="space-y-4">
  <div className="bg-gradient-to-r from-violet-900 to-indigo-900 rounded-lg p-4 border border-violet-700"><div className="flex items-center gap-2"><Target className="w-5 h-5 text-violet-300"/><b className="text-white">V3 vs V3.1 — TARGET 16 / 100</b></div><p className="text-violet-200 text-xs mt-1">V3の的中率16%以上を維持し、回収率100%以上を狙う</p></div>
  <div className="flex gap-2 flex-wrap">{PERIODS.map(([k,l])=><button key={k} onClick={()=>setPeriod(k)} className={cn("px-3 py-1.5 rounded-md text-xs font-medium",period===k?"bg-violet-600 text-white":"bg-slate-800 text-slate-400")}>{l}</button>)}</div>
  <div className="grid grid-cols-2 gap-3"><Card label="V3 基準" d={v3}/><Card label="V3.1 Candidate" d={v31} newOne/></div>
  <div className="bg-slate-900 rounded-lg p-3 border border-slate-700"><b className="text-slate-300 text-xs">V3.1 改善差分</b><div className="grid grid-cols-2 gap-2 mt-2">{[["的中率",v31.hit_rate-v3.hit_rate],["回収率",v31.recovery_rate-v3.recovery_rate]].map(([l,d])=><div className="bg-slate-800/50 rounded p-2" key={l}><div className="text-[10px] text-slate-400">{l}</div><b className={cn("text-xs",d>0?"text-emerald-400":d<0?"text-rose-400":"text-slate-300")}>{d>0?"+":""}{d.toFixed(1)}%</b></div>)}</div></div>
  {v31.buy_count===0&&<div className="flex gap-2 items-start bg-amber-950/30 border border-amber-800 rounded-lg p-3 text-xs text-amber-300"><AlertCircle className="w-4 h-4 shrink-0"/>V3.1は追加直後なので、まだ検証サンプルがありません。今後の予想・結果確定から自動で蓄積されます。</div>}
  {v31.miss_reasons.length>0&&<div className="bg-slate-900 rounded-lg p-3 border border-slate-700"><b className="text-slate-300 text-xs">V3.1 外れ原因TOP5</b>{v31.miss_reasons.slice(0,5).map((x,i)=><div className="flex justify-between text-xs mt-1" key={x.reason}><span className="text-slate-400">{i+1}. {x.reason}</span><span className="text-slate-200">{x.count}件</span></div>)}</div>}
 </div>
}
