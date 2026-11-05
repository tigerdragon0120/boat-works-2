const positive=v=>typeof v==='number'&&Number.isFinite(v)&&v>0;
export function winningDividend(row){
 const raw=row?.payouts?.trifecta;
 if(raw&&typeof raw==='object'&&raw.combination&&raw.combination!==row.result_trifecta)return null;
 const nested=raw&&typeof raw==='object'?raw.payout:raw,top=row?.payout;
 if(positive(nested)&&positive(top)&&nested!==top)return null;
 // Existing fallback writers can persist missing payout as0. A winning dividend0 is unproven.
 return positive(nested)?nested:positive(top)?top:null;
}
export function selectFinalResult(rows,raceId){
 const finals=rows.filter(r=>(r.is_finished||r.result_status==='RESULT_FINAL')&&(!raceId||r.race_id===raceId)&&/^[1-6]-[1-6]-[1-6]$/.test(r.result_trifecta)&&new Set(r.result_trifecta.split('-')).size===3);
 const combinations=new Set(finals.map(r=>r.result_trifecta)),amounts=new Set(finals.map(winningDividend).filter(v=>v!=null));
 if(combinations.size>1||amounts.size>1)throw Error('確定結果が競合しています。V7照合を停止します');
 return finals.find(r=>winningDividend(r)!=null)||finals[0]||null;
}