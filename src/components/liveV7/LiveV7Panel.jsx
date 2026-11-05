import React,{useEffect,useState} from 'react';
import {liveV7} from '@/liveV7/runtime';
const pct=x=>x==null?'—':`${(x*100).toFixed(1)}%`;
export default function LiveV7Panel({race}){
 const [,refresh]=useState(0),[stage,setStage]=useState('AUTO'),[mode,setMode]=useState('hit'),[count,setCount]=useState(8);
 useEffect(()=>{setStage('AUTO');},[race.id]);
 useEffect(()=>{const off=liveV7.subscribe(()=>refresh(n=>n+1)),stop=liveV7.watch(race.id);return()=>{off();stop();};},[race.id]);
 const state=liveV7.get(race.id),selected=stage==='AUTO'?(state.stages.FINAL?.status==='READY'?'FINAL':'PRE'):stage,result=state.stages[selected],p=result?.record?.payload,o=p?.output;
 const settlement=p&&!liveV7.conflicts.has(p.race_key)?liveV7.resultHistory.get(p.race_key):null;
 const settled=settlement?.deadline===p?.deadline?settlement:null;
 const payout=settled?(liveV7.resultEnrichment.get(p.race_key)??settled.payout):null;
 const plan=(mode==='hit'?o?.ticketPlans:o?.recoveryPlans)?.[count];
 const oddsFailed=state.quality?.rows.find(row=>row.key==='odds')?.failed;
 return <section data-testid="live-v7-panel" className="rounded-xl border-2 border-indigo-300 bg-white p-3 space-y-3 min-w-0">
  <h3 className="font-bold text-indigo-900">V7 試験予想 · {selected}</h3><p className="text-xs text-amber-900">未学習・未校正の試算です。既存BUYは置き換えません。更新プレビューと比較用の初回記録は分けて保持します。</p>
  <div className="flex flex-wrap gap-2">{['AUTO','PRE','FINAL'].map(s=><button key={s} aria-pressed={stage===s} onClick={()=>setStage(s)} className={'rounded p-2 text-sm '+(stage===s?'bg-indigo-700 text-white':'bg-slate-100')}>{s==='AUTO'?'V7 自動切替':`V7 ${s}`}</button>)}</div>
  <p className="text-xs">30秒ごとに既存の保存データを確認。展示が揃えば自動でFINALを表示します。保存データの最終読込 {state.lastRead||'未取得'}。締切後は再生成しません。</p>
  {state.error&&<p role="alert" className="text-red-700">{state.error}。表示が残っている場合は前回取得分です。</p>}
  {liveV7.storageError&&<p role="alert" className="text-red-700">{liveV7.storageError}</p>}
  {settled&&<p className="rounded bg-slate-100 p-2 text-sm" data-testid="trial-v7-result">確定三連単 {settled.combination} · 払戻 {payout==null?'不明':`${payout.toLocaleString('ja-JP')}円`}</p>}
  {!o?<p data-testid="live-v7-waiting">{result?.reason||(p?'この初回記録に対象モデルはありません':'既存データから予想を準備中…')}</p>:<>
   <p className="font-bold">{o.model==='WOMENS'?'女子戦モデル':'通常戦モデル'} · {state.error?'判定保留':(plan?.judgment==='BUY'?'研究用BUY':plan?.judgment??'SKIP')} · 三連単 {o.combinations.length}通り · 実績信頼度は未評価</p>
   <p className="text-xs">{o.coverage<1?"入力不足のため参考度低下。性能信頼度は未評価。":"性能信頼度は未評価。"}評価項目充足率 {pct(o.coverage)}（オッズは別） / 進入：{o.course_basis}</p>
   <p className="text-xs break-all">観測 {p.observed_at} / 生成 {p.generated_at} / 締切 {p.deadline} {result.closed?'· 締切後の固定表示':''}</p>
   <div className="grid grid-cols-3 gap-1 text-xs">{o.marginals.map((m,i)=>{const first=Object.entries(m).sort((a,b)=>b[1]-a[1]||+a[0]-+b[0])[0];return <p key={i}>{i+1}着候補 {first[0]}号艇<br/>{pct(first[1])}</p>;})}</div>
   <p className="text-xs">各着候補は個別の周辺確率です。三連単は同一艇の重複を除きます。</p>
   {!!state.quality?.rows.some(r=>r.failed)&&<p className="text-xs text-red-700">取得失敗・未完了ログがあります。保存済み入力による参考表示で、最新取得済みではありません。</p>}
   <p className="text-xs">{oddsFailed||state.error||state.closed?"取引判定は保留しています":o.judgment_reason}</p>
   <div className="flex flex-wrap gap-2 text-sm">
    <label>方式 <select className="min-h-11" value={mode} onChange={e=>setMode(e.target.value)}><option value="hit">的中率優先</option><option value="value">回収率優先</option></select></label>
    <label>点数 <select className="min-h-11" value={count} onChange={e=>setCount(Number(e.target.value))}>{[4,6,8,12].map(n=><option key={n} value={n}>{n}点</option>)}</select></label>
   </div>
   {plan ? <><h4 className="font-bold text-sm">試験買い目 {plan.tickets.length}点 · 合計確率 {pct(plan.probability)}</h4>
   <p className="text-xs">仮想投資 {plan.stake}円 · 有効オッズ充足 {pct(plan.oddsCoverage)} · 各着の候補艇数 {plan.spread.join(' / ')}</p><div className="grid grid-cols-2 gap-1 text-xs">{plan.tickets.map(key=>o.combinations.find(row=>row.combination===key)).map(t=><p key={t.combination}>{t.combination} {pct(t.probability)}{selected==='FINAL'&&<span className="block text-slate-500">オッズ {oddsFailed||state.error?'保留':p.snapshot.oddsMap?.[t.combination]??'—'}</span>}</p>)}</div>
   <p className="text-xs">期待回収の試算：{selected==='PRE'?'PREではオッズを使いません':oddsFailed||state.error?'取得失敗のため表示保留':plan.expectedRecovery==null?'候補オッズ不足・未算出':pct(plan.expectedRecovery)}（未校正・購入推奨ではありません）</p></> : <p>有効オッズが不足しているため、この点数の回収率優先案は保留します。</p>}
   <details><summary className="min-h-11 py-2 text-sm cursor-pointer">三連単の全確率（{o.combinations.length}通り）</summary><div className="max-h-72 overflow-auto"><table className="w-full text-xs"><thead><tr><th scope="col">組番</th><th scope="col">確率</th></tr></thead><tbody>{o.combinations.map(t=><tr key={t.combination}><td>{t.combination}</td><td>{(t.probability*100).toFixed(4)}%</td></tr>)}</tbody></table></div></details>
   <details><summary className="text-xs cursor-pointer">不足・警告・データ証跡</summary><ul className="text-xs max-h-40 overflow-auto">{[...o.missing,...o.warnings,...p.snapshot.adapter_warnings].map((s,i)=><li key={i}>{s}</li>)}</ul><p className="text-xs break-all">入力hash {p.input_hash}<br/>記録ID {result.record.id}<br/>取得元：既存Race / RaceEntry / OddsSnapshot。ブラウザー観測時点であり独立時点証明はありません。正式集計対象外。</p></details>
  </>}
 </section>;
}