import React,{useEffect,useState} from 'react';
import {liveV7} from '@/liveV7/runtime';
import {minimumBalancedStakes} from '@/liveV7/compositeStake';
import {syncV7ToServer} from '@/liveV7/serverSync';
import {resolveEvidence, isValidTrifecta} from '@/lib/resultEvidence';
import useV7SavedRace from '@/components/liveV7/useV7SavedRace';
const pct=x=>x==null?'—':(x*100).toFixed(1)+'%';
const fmt=v=>{const d=Date.parse(v||'');return Number.isFinite(d)?new Intl.DateTimeFormat('ja-JP',{hour:'2-digit',minute:'2-digit',second:'2-digit',timeZone:'Asia/Tokyo',hour12:false}).format(d):'未取得';};
const COLORS=['','bg-white text-slate-900 border-slate-400','bg-slate-900 text-white border-slate-900','bg-red-600 text-white border-red-600','bg-blue-600 text-white border-blue-600','bg-yellow-400 text-slate-900 border-yellow-400','bg-emerald-600 text-white border-emerald-600'];
const Boat=({n})=><span className={'inline-flex h-9 w-9 sm:h-11 sm:w-11 shrink-0 items-center justify-center rounded-md border font-black text-lg sm:text-xl '+(COLORS[+n]||'bg-slate-100 text-slate-900')}>{n}</span>;
function Combination({value}){return <span className="inline-flex items-center gap-1">{String(value).split('-').map((n,i)=><React.Fragment key={i}>{i>0&&<span className="font-bold text-slate-400">-</span>}<Boat n={n}/></React.Fragment>)}</span>;}
export default function LiveV7Panel({race,finalOnly=false,exhibitionComplete=true,exhibitionCount=6,activeBoatCount=6,readOnly=false}){
 const [,refresh]=useState(0),[stage,setStage]=useState('AUTO'),[mode,setMode]=useState('hit'),[count,setCount]=useState(8),[refreshing,setRefreshing]=useState(false);
 const savedState=useV7SavedRace(race);
 const deadlineMs=Date.parse(race.deadline||'');
 const pageClosed=['finished','cancelled'].includes(race.status)||(Number.isFinite(deadlineMs)&&Date.now()>=deadlineMs);
 useEffect(()=>{const clock=window.setInterval(()=>refresh(n=>n+1),15000);return()=>window.clearInterval(clock);},[race.id]);
 useEffect(()=>setStage('AUTO'),[race.id]);
 useEffect(()=>{
  // 匿名・締切済みの画面からは予想を生成・同期しない。既存の見た目を維持して保存済み予想を表示する。
  if(readOnly||pageClosed)return undefined;
  // 生成されたV7予想は端末内に加えてサーバーへも保存する(検証用)。
  const off=liveV7.subscribe(()=>{refresh(n=>n+1);void syncV7ToServer(liveV7);});
  const stop=liveV7.watch(race.id);
  void syncV7ToServer(liveV7);
  return()=>{off();stop();};
 },[race.id,readOnly,pageClosed]);
 const state=liveV7.get(race.id);
 const finalAvailable=state.stages.FINAL?.status==='READY'||!!savedState.stages.FINAL;
 // FINALが取得できないときは締切前に保存済みのPREを参考予想として表示する。
 const selected=finalOnly?(finalAvailable?'FINAL':'PRE'):stage==='AUTO'?(finalAvailable?'FINAL':'PRE'):stage;
 const local=state.stages[selected];
 // 締切後は固定のサーバー保存予想を優先。端末内のみの参考予想を正式結果として扱わない。
 const result=(pageClosed&&savedState.stages[selected])|| (local?.status==='READY'?local:(savedState.stages[selected]||local));
 const p=result?.record?.payload,o=p?.output;
 const usingSaved=result?.fromServer===true;
 const settlement=p&&!liveV7.conflicts.has(p.race_key)?liveV7.resultHistory.get(p.race_key):null;
 const settled=settlement?.deadline===p?.deadline?settlement:null;
 const payout=settled?(liveV7.resultEnrichment.get(p.race_key)??settled.payout):null;
 const evidenceData=savedState.evidence;
 const officialResolution=evidenceData?.resultResolution;
 const official=officialResolution?.status==='ready'?officialResolution.result:null;
 const officialCombo=isValidTrifecta(official?.result_trifecta)?String(official.result_trifecta):null;
 const candidate=savedState.resultConflict?null:savedState.resultCandidate;
 const resultCombo=officialResolution?.status==='conflict'||savedState.resultConflict?null:(officialCombo||(isValidTrifecta(candidate?.result_trifecta)?String(candidate.result_trifecta):null));
 const officialPayoutValue=Number(official?.payout??official?.payouts?.trifecta?.payout);
 const officialPayout=Number.isFinite(officialPayoutValue)&&officialPayoutValue>0?officialPayoutValue:null;
 const candidatePayoutValue=Number(candidate?.payout??candidate?.payouts?.trifecta?.payout);
 const resultPayout=officialPayout??(Number.isFinite(candidatePayoutValue)&&candidatePayoutValue>0?candidatePayoutValue:null);
 const evidence=official&&officialCombo?resolveEvidence(evidenceData?.rows||[],{
  combination:officialCombo,source:official.source,resultId:official.id,raceId:String(race.id)
 }):null;
 const verifiedResult=!!officialCombo&&officialPayout!=null&&evidenceData?.complete===true&&evidence?.status==='ok'&&!savedState.resultConflict&&usingSaved;
 const plan=(mode==='hit'?o?.ticketPlans:o?.recoveryPlans)?.[count];
 const oddsFailed=!usingSaved&&state.quality?.rows?.find(row=>row.key==='odds')?.failed;
 const firstId=p?liveV7.first.get(JSON.stringify([p.race_key,selected])):null;
 const firstRecord=firstId?liveV7.records.get(firstId):null;
 const revisionCount=p?[...liveV7.records.values()].filter(r=>r.payload?.race_key===p.race_key&&r.payload?.stage===selected).length:0;
 // 最新の締切前オッズを表示専用に使う。固定済みの予想やBUY判定には反映しない。
 const displayOddsSnapshot=savedState.displayOdds;
 const originalOddsAt=p?.snapshot?.provenance?.odds_captured_at??null;
 const usingDisplayOdds=!!displayOddsSnapshot && (
  !originalOddsAt || Date.parse(displayOddsSnapshot.captured_at)>=Date.parse(originalOddsAt));
 const displayOddsMap=usingDisplayOdds?displayOddsSnapshot.odds_map:(p?.snapshot?.oddsMap||{});
 const oddsCaptured=usingDisplayOdds?displayOddsSnapshot.captured_at:originalOddsAt;
 const oddsAgeMs=oddsCaptured?Date.now()-Date.parse(oddsCaptured):null;
 const deadline=Date.parse(race.deadline||'');
 const closed=state.closed||pageClosed;
 const remaining=Number.isFinite(deadline)?Math.max(0,Math.ceil((deadline-Date.now())/60000)):null;
 const refreshNow=async()=>{if(refreshing||closed||readOnly)return;setRefreshing(true);try{await liveV7.refresh(race.id);}finally{setRefreshing(false);}};
 const ordered=(plan?.tickets||[]).map(key=>o?.combinations?.find(row=>row.combination===key)).filter(Boolean);
 // Synthetic/composite odds (dutching) = 1 / sum(1 / decimal_odds).
 // Show only when every selected ticket has a valid odds quote.
 // This assumes payouts are balanced across bets, unlike current 100-yen-per-ticket display.
 const selectedOdds=(plan?.tickets||[]).map(key=>Number(displayOddsMap?.[key]));
 const displayOddsCoverage=plan?.tickets?.length
  ?plan.tickets.filter(k=>Number.isFinite(Number(displayOddsMap?.[k]))&&Number(displayOddsMap[k])>0).length/plan.tickets.length:null;
 const allOddsAvailable=selectedOdds.length>0 && selectedOdds.length===plan?.tickets?.length &&
   selectedOdds.every(value=>Number.isFinite(value) && value>0);
 const compositeOdds=selected==='FINAL' && allOddsAvailable
   ?1/selectedOdds.reduce((total,value)=>total+1/value,0):null;
 const balanced=compositeOdds!=null?minimumBalancedStakes(selectedOdds):null;
 // Display one physically possible ordered finish. Marginal leaders at
 // each rank are independent and can repeat; they are not a trifecta.
 const topFinish=o?.combinations?.filter(row=>
   typeof row.combination==='string' &&
   /^[1-6]-[1-6]-[1-6]$/.test(row.combination) &&
   new Set(row.combination.split('-')).size===3 &&
   Number.isFinite(row.probability) && row.probability>0
 )?.sort((a,b)=>b.probability-a.probability || a.combination.localeCompare(b.combination))[0]||null;
 const topBoats=topFinish?.combination.split('-')||[];


 return <section data-testid="live-v7-panel" className="min-w-0 space-y-4 rounded-xl border-2 border-indigo-200 bg-white p-3 sm:p-5">
  <div className="flex flex-wrap items-center justify-between gap-2"><div><h3 className="text-lg font-black text-slate-900">統合V7 <span className="text-sm font-medium text-slate-500">{o?.model==='WOMENS'?'女子戦':'通常戦'}・{selected}</span></h3><p className="text-xs text-slate-600">試験予想・確率未校正。購入推奨ではありません。</p></div><span className={'rounded-full px-3 py-1.5 text-sm font-bold '+(closed?'bg-slate-100 text-slate-700':'bg-blue-50 text-blue-800')}>{closed?'締切済み':('締切まで '+(remaining==null?'—':remaining+'分'))}</span></div>
  {!finalOnly&&<div className="flex gap-2">{['AUTO','PRE','FINAL'].map(s=><button type="button" key={s} onClick={()=>setStage(s)} aria-pressed={stage===s} className={'rounded-lg px-3 py-2 text-sm font-bold '+(stage===s?'bg-indigo-700 text-white':'bg-slate-100 text-slate-700')}>{s==='AUTO'?'自動切替':s}</button>)}</div>}
  {selected==='PRE'&&finalOnly&&<p role="status" className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm font-semibold text-amber-900">FINAL予想はまだありません。締切前に保存されたPRE（事前予想）を参考表示しています。展示データが不足したレースではFINALを後から生成しません。</p>}
  {(state.error||liveV7.storageError)&&<p role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">{state.error||liveV7.storageError}</p>}
  {!resultCombo&&settled&&!savedState.resultConflict&&<p data-testid="trial-v7-result" className="rounded-lg bg-slate-100 p-3 text-sm font-bold">取得結果 三連単 {settled.combination} / 払戻 {payout==null?'未取得':payout.toLocaleString('ja-JP')+'円'}（公式照合待ち）</p>}
  {!o?<p data-testid="live-v7-waiting" className="rounded-lg border border-amber-200 bg-amber-50 p-4 font-semibold">{savedState.loading?'保存済みV7予想を確認中…':savedState.error?'保存済みデータの取得に失敗しました：'+savedState.error:(result?.reason||(closed?'締切前に保存されたV7予想はありません':'V7予想を準備中です'))}</p>:<>
   <div className="space-y-3 rounded-xl border border-blue-200 bg-blue-50 p-3 sm:p-4">
    <div className="flex flex-wrap items-center gap-2"><strong className="text-base">着順予想</strong><span className="rounded-md bg-white px-2 py-1 text-xs font-bold text-blue-900">{o.model==='WOMENS'?'女子戦モデル':'通常戦モデル'}</span><span className="text-xs text-slate-600">{exhibitionComplete?('展示反映 '+activeBoatCount+'艇'):('展示一部反映 '+exhibitionCount+'/'+activeBoatCount+'艇')}</span></div>
    <div className="grid grid-cols-3 gap-2">{[0,1,2].map(i=><div key={i} className="flex flex-col items-center gap-1 rounded-lg bg-white p-2"><span className="text-xs font-bold text-slate-600">{i+1}着予想</span>{topBoats[i]?<Boat n={topBoats[i]}/>:<span>—</span>}</div>)}</div>
    <p className="text-sm font-bold text-indigo-900">本命三連単 {topFinish?.combination||'未算出'} / その組み合わせの予測確率 {pct(topFinish?.probability)}</p>
    <p className="text-xs text-slate-600">{usingSaved?'締切前にサーバー保存された予想を固定表示。個別確率など保存されていない項目は「—」で表示します。':'三連単'+(o.combinations?.length??0)+'通りの中で最も確率が高い組み合わせを表示。各着順を独立に選ぶのではなく、同じ号艇の重複を防いでいます。確率は未校正の参考値です。'}</p>
   </div>
   {closed&&<div data-testid="v7-stable-result" className="rounded-xl border border-slate-200 bg-white p-3 sm:p-4 space-y-3">
      <h4 className="font-black text-base text-slate-900">レース結果・的中判定</h4>
      {resultCombo?<>
        <div className="grid grid-cols-3 gap-2">{resultCombo.split('-').map((n,i)=><div key={i} className="flex flex-col items-center gap-1 rounded-lg bg-slate-50 p-2"><span className="text-xs font-bold text-slate-600">実際の{i+1}着</span><Boat n={n}/></div>)}</div>
        <p className="text-sm font-bold">{verifiedResult?'公式照合済み':'結果取得済み・照合待ち'} 三連単 {resultCombo} ／ 払戻 {resultPayout==null?'未確認':resultPayout.toLocaleString('ja-JP')+'円'}</p>
        <p className={'rounded-lg p-3 text-sm font-bold '+(verifiedResult?(plan?.tickets?.includes(resultCombo)?'bg-emerald-50 text-emerald-800':'bg-slate-100 text-slate-800'):'bg-amber-50 text-amber-900')}>
          {verifiedResult?(plan?.tickets?.includes(resultCombo)?'この買い目は的中！':'この買い目は不的中'):
            '暫定照合：'+(plan?.tickets?.includes(resultCombo)?'組番一致':'組番不一致')+(usingSaved?'（正式判定は証跡・払戻の確認待ち）':'（端末参考予想・締切前サーバー保存の確認待ち）')}
        </p>
      </>:<p className="rounded-lg bg-slate-50 p-3 text-sm text-slate-600">{savedState.resultConflict||officialResolution?.status==='conflict'?'確定結果に矛盾があるため判定保留':officialResolution?.status==='incomplete'?'公式結果の取得が未完了のため判定保留':'結果取得待ち。予想と買い目はこのまま残します。'}</p>}
    </div>}
   <div className="space-y-3"><div className="flex items-center justify-between gap-2"><h4 className="text-lg font-black">三連単・買い目候補</h4><span className={'shrink-0 rounded-lg px-3 py-1.5 text-sm font-bold '+(plan?.judgment==='BUY'?'bg-emerald-100 text-emerald-900':'bg-amber-100 text-amber-900')}>{plan?.judgment==='BUY'?'研究用BUY':plan?.judgment||'判定保留'}</span></div>
    <div className="flex flex-wrap gap-3 rounded-lg bg-slate-50 p-3"><div><p className="mb-1 text-xs font-bold text-slate-600">方式</p><div className="flex gap-1">{[{key:'hit',label:'的中率'},{key:'value',label:'回収率'}].map(x=><button type="button" key={x.key} aria-pressed={mode===x.key} onClick={()=>setMode(x.key)} className={'min-h-10 rounded-lg px-3 text-sm font-bold '+(mode===x.key?'bg-indigo-700 text-white':'border border-slate-300 bg-white')}>{x.label}</button>)}</div></div><div><p className="mb-1 text-xs font-bold text-slate-600">点数</p><div className="flex flex-wrap gap-1">{[4,6,8,12].map(n=><button type="button" key={n} aria-pressed={count===n} onClick={()=>setCount(n)} className={'min-h-10 rounded-lg px-3 text-sm font-bold '+(count===n?'bg-indigo-700 text-white':'border border-slate-300 bg-white')}>{n}点</button>)}</div></div></div>
    {plan?<><div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
      <div className="rounded-lg border p-3"><p className="text-xs text-slate-600">合計予想確率</p><strong className="text-2xl text-indigo-900">{pct(plan.probability)}</strong></div>
      <div className="rounded-lg border p-3"><p className="text-xs text-slate-600">仮想投資</p><strong className="text-2xl">{plan.stake?.toLocaleString('ja-JP')}円</strong></div>
      <div className="rounded-lg border p-3"><p className="text-xs text-slate-600">概算合成オッズ</p><strong className="text-2xl text-indigo-900">{compositeOdds==null?'—':compositeOdds.toFixed(2)+'倍'}</strong><p className="mt-1 text-xs font-bold text-indigo-900">均等払戻向け最小額：{balanced?balanced.total.toLocaleString('ja-JP')+'円':'—'}</p></div>
      <div className="rounded-lg border p-3"><p className="text-xs text-slate-600">期待回収率（未校正）</p><strong className="text-2xl">{selected==='PRE'||oddsFailed?'—':pct(plan.expectedRecovery)}</strong></div>
     </div>
     <div className="rounded-lg border border-indigo-200 bg-indigo-50 p-3 text-sm text-indigo-950">
      <p className="font-bold">100円単位で合成オッズに近づける購入例</p>
      {balanced?<><p className="mt-1">最低概算購入額 <strong className="text-xl">{balanced.total.toLocaleString('ja-JP')}円</strong> / 的中時の概算払戻 <strong>{Math.round(balanced.minPayout).toLocaleString('ja-JP')}〜{Math.round(balanced.maxPayout).toLocaleString('ja-JP')}円</strong></p><p className="mt-1 text-xs">どの買い目が的中しても払戻差が10%以内になる条件での、最小購入例です。下表の「均等払戻配分」列で各点の購入額を確認できます。</p></>:<p className="mt-1 text-xs">オッズ未取得、または10万円以内で払戻差10%以内の配分が作れないため、購入額は算出できません。</p>}
     </div>
     <div className="overflow-hidden rounded-lg border border-slate-200">
      <div className="grid grid-cols-[1.5rem_minmax(0,1fr)_3rem_3.5rem_4rem] items-center gap-1 bg-slate-100 px-2 py-2 text-xs font-bold text-slate-600 sm:grid-cols-[2rem_minmax(0,1fr)_5rem_5rem_6rem]"><span>順</span><span>組番</span><span className="text-right">確率</span><span className="text-right">オッズ</span><span className="text-right">配分額</span></div>
      {ordered.map((t,i)=><div key={t.combination} className={'grid grid-cols-[1.5rem_minmax(0,1fr)_3rem_3.5rem_4rem] items-center gap-1 border-t border-slate-200 px-2 py-2 sm:grid-cols-[2rem_minmax(0,1fr)_5rem_5rem_6rem] '+(verifiedResult&&t.combination===officialCombo?'bg-emerald-100 ring-1 ring-inset ring-emerald-400':i%2?'bg-slate-50':'bg-white')}><span className="text-sm font-semibold text-slate-500">{i+1}</span><span className="flex flex-wrap items-center gap-1"><Combination value={t.combination}/>{verifiedResult&&t.combination===officialCombo&&<span className="text-xs font-black text-emerald-800">的中</span>}</span><strong className="text-right text-sm text-indigo-900">{pct(t.probability)}</strong><strong className="text-right text-sm">{displayOddsMap?.[t.combination]??'—'}</strong><strong className="text-right text-sm text-blue-900">{balanced?balanced.stakes[plan.tickets.indexOf(t.combination)].toLocaleString('ja-JP')+'円':'—'}</strong></div>)}
     </div>
     <p className="text-xs text-slate-600">表示オッズ {fmt(oddsCaptured)} / オッズ充足 {pct(displayOddsCoverage)}。{usingDisplayOdds?'サーバー取得の実オッズを表示（予想時点より後の更新を含みます）。':'予想時点に取得したオッズを表示。'}{oddsAgeMs!=null&&oddsAgeMs>10*60*1000&&!closed?' 最終取得から10分以上経過しています。':''}オッズは締切まで変動します。</p>
     <p className="text-xs text-slate-600">概算合成オッズと配分額は表示用の取得オッズによる参考計算で、保存済みの予想・BUY/WATCH・検証成績を再判定しません。表示中の「100円ずつ購入」とは異なります。オッズ不足時は表示しません。</p></>:<p className="rounded-lg bg-amber-50 p-4 text-sm font-semibold text-amber-900">この方式では有効な買い目が不足しています。的中率方式で候補を確認できます。</p>}
   </div>
  </>}
  <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border bg-slate-50 p-3"><span className="text-xs text-slate-600">{usingSaved?'サーバー保存済みV7':'読込 '+fmt(state.lastRead)+' / 更新 '+(revisionCount?revisionCount-1:0)+'件（端末内）'} / 使用オッズ {fmt(oddsCaptured)}</span><button type="button" onClick={refreshNow} disabled={refreshing||closed||readOnly} className="rounded-lg border border-blue-300 bg-white px-3 py-2 text-sm font-bold text-blue-800 disabled:opacity-50">{refreshing?'更新中…':'予想・オッズを再確認'}</button></div>
  <details className="rounded-lg border border-slate-200 p-3 text-sm"><summary className="cursor-pointer font-bold">詳細・警告・予想の保存記録</summary><div className="mt-3 space-y-2 text-xs text-slate-700"><p>未学習・未校正の試算です。既存BUYは置き換えず、正式検証対象外です。</p><p>初回記録 {fmt(firstRecord?.payload?.generated_at)} / 締切 {race.deadline||'不明'}</p><p>入力充足率 {pct(o?.coverage)} / 進入 {o?.course_basis||'未確認'}</p>{state.quality?.rows?.some(r=>r.failed)&&<p className="font-bold text-red-700">取得失敗・未完了ログがあります。最新取得済みではありません。</p>}{o&&<><p>{o.judgment_reason}</p><p>不足・警告：{[...(o.missing||[]),...(o.warnings||[]),...(p?.snapshot?.adapter_warnings||[])].join(' / ')||'なし'}</p><p className="break-all">入力hash {p.input_hash} / 記録ID {result?.record?.id}</p></>}<p>ブラウザー観測のため独立時点証明はありません。</p></div></details>
  {o&&<details className="rounded-lg border border-slate-200 p-3 text-sm"><summary className="cursor-pointer font-bold">三連単{o.combinations.length}通りの全確率</summary><div className="mt-3 max-h-72 overflow-auto"><table className="w-full text-xs"><thead><tr><th scope="col">組番</th><th scope="col">確率</th></tr></thead><tbody>{o.combinations.map(t=><tr key={t.combination}><td>{t.combination}</td><td>{pct(t.probability)}</td></tr>)}</tbody></table></div></details>}
 </section>;
}