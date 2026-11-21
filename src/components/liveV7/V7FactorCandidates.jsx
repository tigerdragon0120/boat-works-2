// V7+ 独立研究モデルの実成績比較。固定済み候補だけを公式検証へ紐付け。
// 予想時点のBUYや既存のV7買い目は変更しない。
import React,{useEffect,useMemo,useState} from 'react';
import {base44} from '@/api/base44Client';
import {useAuth} from '@/lib/AuthContext';
import {jstDate} from '@/lib/v7Verification';

const PHASE={QUALIFYING:'予選',SEMIFINAL:'準優勝戦',FINAL:'優勝戦',OTHER:'その他',UNKNOWN:'区分不明'};
const fmt=n=>Number(n||0).toLocaleString('ja-JP');
const pct=(a,n)=>n?((a/n)*100).toFixed(1)+'%':'—';
const yen=n=>fmt(n)+'円';
const VALID=/^[1-6]-[1-6]-[1-6]$/;
function readStats(candidates,groupByKey,phase){
  const all=candidates.filter(c=>phase==='ALL'||c.phase===phase);
  const matched=[];
  for(const c of all){
    const base=groupByKey.get(c.race_key);
    const verification=base?.verification;
    if(base?.status!=='VERIFIED'||!VALID.test(String(verification?.actual_result||'')))continue;
    if(!Array.isArray(c.factor_tickets)||c.factor_tickets.length!==8||
       !Array.isArray(c.baseline_tickets)||c.baseline_tickets.length!==8||c.status!=='CANDIDATE')continue;
    const actual=verification.actual_result;
    const raw=verification?.payout;
    const paid=Number(raw);
    if(raw==null||!Number.isFinite(paid)||paid<=0)continue;
    matched.push({c,actual,payout:paid,our:c.factor_tickets.includes(actual),old:c.baseline_tickets.includes(actual)});
  }
  const hitNew=matched.filter(r=>r.our).length,hitOld=matched.filter(r=>r.old).length;
  const n=matched.length;
  const stake=n*800;
  const returnNew=matched.reduce((s,r)=>s+(r.our?r.payout:0),0);
  const returnOld=matched.reduce((s,r)=>s+(r.old?r.payout:0),0);
  return {all,matched,n,hitNew,hitOld,returnNew,returnOld,stake};
}
export default function V7FactorCandidates({groups=[]}){
  const {user}=useAuth();
  const admin=user?.role==='admin';
  const [data,setData]=useState(null),[verifications,setVerifications]=useState(null),[error,setError]=useState(null),[loading,setLoading]=useState(false);
  const [model,setModel]=useState('OPEN'),[phase,setPhase]=useState('ALL'),[predictionStage,setPredictionStage]=useState('FINAL');
  const reload=async()=>{
    if(!admin)return;
    setLoading(true);setError(null);
    try{
      // 1日ごとに読むことで500件制限による欠落を防ぐ。
      const dates=Array.from({length:7},(_,i)=>jstDate(-i));
      const [pages,verificationPages]=await Promise.all([
        Promise.all(dates.map(date=>base44.entities.V7FactorCandidate.filter({race_date:date},'-created_date',500))),
        Promise.all(dates.map(date=>base44.entities.PredictionV7Verification.filter({race_date:date,stage:'FINAL'},'-created_date',500)))
      ]);
      if([...pages,...verificationPages].some(page=>!Array.isArray(page)||page.length>=500)){
        throw new Error('一部の日付の候補を全件取得できず、集計を停止しました');
      }
      const ids=new Set();const rows=[];
      for(const page of pages)for(const row of page){
        if(!row?.id||ids.has(row.id))throw new Error('候補台帳に重複または欠落があります');
        ids.add(row.id);rows.push(row);
      }
      setData(rows);
      setVerifications(verificationPages.flat());
    }catch(e){setData(null);setVerifications(null);setError(e?.message||'候補を取得できませんでした')}
    finally{setLoading(false)}
  };
  useEffect(()=>{if(admin)void reload()},[admin]);
  const verifiedByKey=useMemo(()=>{
    const map=new Map();
    const byHash=new Map();
    for(const v of verifications||[]){
      if(!v?.record_hash)continue;
      const old=byHash.get(v.record_hash);
      if(!old||String(v.created_date||'')>String(old.created_date||''))byHash.set(v.record_hash,v);
    }
    const ambiguous=new Set();
    for(const v of byHash.values()){
      if(v.stage!=='FINAL'||v.verification_version!=='v2'||v.verification_status!=='VERIFIED')continue;
      if(!v.race_key)continue;
      const old=map.get(v.race_key);
      if(old&&old.verification?.actual_result!==v.actual_result)ambiguous.add(v.race_key);
      else map.set(v.race_key,{status:'VERIFIED',verification:v});
    }
    for(const key of ambiguous)map.delete(key);
    if(!verifications)for(const g of groups){
      if(g.stage==='FINAL'&&g.status==='VERIFIED'&&g.verification&&!map.has(g.raceKey))map.set(g.raceKey,g);
    }
    return map;
  },[groups,verifications]);
  const filtered=useMemo(()=>{
    const records=(data||[]).filter(c=>c.model===model);
    const first=new Map();
    // A single record per race; stage priority LOCK > FINAL > PRE.
    for(const c of records){
      if(predictionStage==='PRE' ? c.stage!=='PRE' : !['FINAL','LOCK'].includes(c.stage))continue;
      const prev=first.get(c.race_key);
      const rank={PRE:1,FINAL:2,LOCK:3};
      if(!prev||rank[c.stage]>rank[prev.stage])first.set(c.race_key,c);
    }
    return readStats([...first.values()],verifiedByKey,phase);
  },[data,model,phase,predictionStage,verifiedByKey]);
  if(!admin)return null;
  const s=filtered;
  return <section data-testid="v7-factor-candidates" className="space-y-3 rounded-xl border border-sky-200 bg-white p-3 sm:p-5">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div>
        <h2 className="text-lg font-black text-slate-900">V7＋ 多因子予想・実成績比較</h2>
        <p className="text-xs text-slate-600">独立した研究モデル。一般戦と女子戦を分け、予選・準優・優勝戦ごとの成績を比較します。</p>
      </div>
      <button type="button" className="min-h-10 rounded-lg border px-3 text-sm font-semibold" onClick={reload} disabled={loading}>{loading?'取得中…':'データ更新'}</button>
    </div>
    <div className="flex flex-wrap gap-3">
      <label className="text-xs font-semibold text-slate-700">区分
        <select className="ml-2 rounded-lg border bg-white p-2" value={model} onChange={e=>setModel(e.target.value)}>
          <option value="OPEN">一般戦</option><option value="WOMENS">女子戦</option>
        </select>
      </label>
      <label className="text-xs font-semibold text-slate-700">予想段階
        <select className="ml-2 rounded-lg border bg-white p-2" value={predictionStage} onChange={e=>setPredictionStage(e.target.value)}>
          <option value="FINAL">直前（FINAL／LOCK）</option><option value="PRE">事前（PRE）</option>
        </select>
      </label>
      <label className="text-xs font-semibold text-slate-700">開催段階
        <select className="ml-2 rounded-lg border bg-white p-2" value={phase} onChange={e=>setPhase(e.target.value)}>
          <option value="ALL">すべて</option>{Object.entries(PHASE).map(([k,v])=><option key={k} value={k}>{v}</option>)}
        </select>
      </label>
    </div>
    {error&&<p role="alert" className="rounded-lg bg-rose-50 p-3 text-sm text-rose-800">{error}</p>}
    {!data&&!error&&<p className="text-sm text-slate-500">研究データを取得中…</p>}
    {data&&<>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {[
          ['前向き候補',fmt(s.all.length)+'R',predictionStage==='PRE'?'事前予想の記録':'直前予想の記録・1レース1回'],
          ['結果照合済み',fmt(s.n)+'R','V7有効FINALと照合できたレース'],
          ['V7＋ 8点的中率',pct(s.hitNew,s.n),fmt(s.hitNew)+'的中'],
          ['従来V7 8点的中率',pct(s.hitOld,s.n),fmt(s.hitOld)+'的中']
        ].map(([label,value,note])=><div key={label} className="rounded-lg border bg-slate-50 p-3">
          <p className="text-xs text-slate-500">{label}</p><p className="mt-1 text-xl font-black">{value}</p>
          <p className="mt-1 text-[11px] text-slate-500">{note}</p>
        </div>)}
      </div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {[
          ['V7＋ 仮想回収率',pct(s.returnNew,s.stake)],
          ['従来V7 仮想回収率',pct(s.returnOld,s.stake)],
          ['V7＋ 仮想払戻',yen(s.returnNew)],
          ['同条件の仮想投資',yen(s.stake)]
        ].map(([label,value])=><div key={label} className="rounded-lg border p-3"><p className="text-xs text-slate-600">{label}</p><p className="font-black">{value}</p></div>)}
      </div>
      <div className="space-y-2">
        <h3 className="text-sm font-black">最近の予想候補</h3>
        {!s.all.length&&<p className="p-3 text-sm text-slate-500">この条件ではまだ候補がありません。</p>}
        {s.all.slice(0,15).map(c=>{
          const v=s.matched.find(r=>r.c.candidate_key===c.candidate_key);
          return <div key={c.id} className="rounded-lg border border-slate-200 p-3 text-xs">
            <div className="flex flex-wrap justify-between gap-2"><strong>{c.race_date}　{c.venue_code}場 {c.race_number}R　{PHASE[c.phase]||c.phase}</strong><span>{c.stage}・{c.status==='CANDIDATE'?'研究予想':'データ不足'}</span></div>
            <p className="mt-1">V7：{c.baseline_top||'—'}　→　V7＋：<strong>{c.factor_top||'—'}</strong>{c.diff_from_baseline?'（本命変更）':''}</p>
            <p className="mt-1 text-slate-600">8点：{(c.factor_tickets||[]).join(' / ')||'不足'}</p>
            <p className="mt-1 text-slate-600">結果：{v?(v.our?'V7＋ 的中':'V7＋ 不的中')+'／'+(v.old?'V7 的中':'V7 不的中'):'結果照合待ち'}</p>
          </div>;
        })}
      </div>
      <p className="text-xs leading-5 text-slate-500">V7＋は仮説重みの未校正モデルで、勝率・確率として解釈できません。実績を採点できた同一レースだけで比較し、事後予想やオッズの後付けは禁止。BUYには連動していません。</p>
    </>}
  </section>;
}
