// Administrator-only independent V8 theory trial comparison.
import React,{useEffect,useMemo,useState} from 'react';
import {base44} from '@/api/base44Client';
import {useAuth} from '@/lib/AuthContext';
import {jstDate} from '@/lib/v7Verification';
const LABELS={UICHI_MAIN:'ういち基本型',UICHI_URA:'裏ういち型',UICHI_NEW_MAIN:'新ういち型',UICHI_NEW_URA:'新裏ういち型',EXHIBITION_RELATIVE:'展示・スタート相対評価',V8_ALL_FACTOR:'V8多因子'};
const fmt=x=>x==null?'—':(100*x).toFixed(1);
const pct=(a,n)=>n?(100*a/n).toFixed(1)+'%':'—';
export default function V8TheoryLab(){
 const {user}=useAuth();const admin=user?.role==='admin';
 const [data,setData]=useState(null),[error,setError]=useState(null),[loading,setLoading]=useState(false);
 const [model,setModel]=useState('OPEN'),[stage,setStage]=useState('FINAL'),[pattern,setPattern]=useState('ALL');
 const load=async()=>{
  if(!admin)return;
  setLoading(true);setError(null);
  try{
   const dates=Array.from({length:7},(_,i)=>jstDate(-i));
   const pages=await Promise.all(dates.map(race_date=>base44.entities.V8TheoryTrial.filter({race_date},'-created_date',500)));
   if(pages.some(p=>!Array.isArray(p)||p.length>=500))throw new Error('一部の日付が500件以上あるため集計を停止しました');
   const keys=new Set(),rows=[];
   for(const page of pages)for(const r of page){
    if(!r?.id||keys.has(r.id))throw new Error('台帳の重複・不整合を検出しました');
    keys.add(r.id);rows.push(r);
   }setData(rows);
  }catch(e){setData(null);setError(e?.message||'読込に失敗しました')}
  finally{setLoading(false)}
 };
 useEffect(()=>{void load()},[admin]);
 const records=useMemo(()=>{
  const byRace=new Map();
  for(const r of data||[]){
   if(r.gender_model!==model)continue;
   if(stage==='PRE'?r.stage!=='PRE':!['FINAL','LOCK'].includes(r.stage))continue;
   const old=byRace.get(r.race_key),order={PRE:1,FINAL:2,LOCK:3};
   if(!old||order[r.stage]>order[old.stage])byRace.set(r.race_key,r);
  }
  return [...byRace.values()].sort((a,b)=>String(b.generated_at).localeCompare(String(a.generated_at)));
 },[data,model,stage]);
 const stats=useMemo(()=>{
  const keys=Object.keys(LABELS);
  return keys.map(k=>{
   const available=records.map(r=>r.models?.find(m=>m.key===k)).filter(m=>m?.status==='READY');
   return {key:k,count:available.length,average:available.length?available.reduce((s,m)=>s+(Number(m.score)||0),0)/available.length:null};
  });
 },[records]);
 if(!admin)return null;
 return <section data-testid="v8-theory-lab" className="space-y-3 rounded-xl border border-indigo-200 bg-white p-3 sm:p-5">
  <div className="flex flex-wrap items-start justify-between gap-2"><div>
   <h2 className="text-lg font-black text-slate-900">V8・予想家型ロジック比較研究</h2>
   <p className="mt-1 text-xs leading-5 text-slate-600">ういち型4種類／舟券太郎参考の独自展示評価／V8多因子を同一レースで比較。未校正のスコアで、BUYや購入推奨には使いません。</p>
  </div><button type="button" onClick={load} disabled={loading} className="min-h-10 rounded-lg border bg-white px-3 text-sm font-semibold">{loading?'読込中…':'再取得'}</button></div>
  <div className="flex flex-wrap gap-2">
   <label className="text-xs">種別 <select className="min-h-10 rounded-lg border bg-white p-2" value={model} onChange={e=>setModel(e.target.value)}><option value="OPEN">一般戦</option><option value="WOMENS">女子戦</option></select></label>
   <label className="text-xs">予想段階 <select className="min-h-10 rounded-lg border bg-white p-2" value={stage} onChange={e=>setStage(e.target.value)}><option value="PRE">事前PRE</option><option value="FINAL">直前FINAL/LOCK</option></select></label>
   <label className="text-xs">理論 <select className="min-h-10 rounded-lg border bg-white p-2" value={pattern} onChange={e=>setPattern(e.target.value)}><option value="ALL">全理論</option>{Object.entries(LABELS).map(([k,v])=><option key={k} value={k}>{v}</option>)}</select></label>
  </div>
  {error&&<p role="alert" className="rounded-lg bg-rose-50 p-3 text-sm text-rose-800">{error}</p>}
  {!data&&!error&&<p className="text-sm text-slate-500">記録を読み込み中…</p>}
  {data&&<>
   <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
    <div className="rounded-lg bg-slate-50 border p-3"><p className="text-xs text-slate-600">対象レース</p><p className="text-xl font-black">{records.length}件</p></div>
    {stats.filter(s=>pattern==='ALL'||pattern===s.key).slice(0,2).map(s=><div key={s.key} className="rounded-lg bg-slate-50 border p-3">
     <p className="text-xs text-slate-600">{LABELS[s.key]}・計算できた数</p><p className="text-xl font-black">{s.count}件</p>
    </div>)}
   </div>
   {!records.length&&<p className="rounded-lg bg-slate-50 p-3 text-sm text-slate-600">この条件の予想候補はまだありません。</p>}
   <div className="space-y-3">{records.slice(0,18).map(r=><div key={r.id} className="rounded-lg border p-3 text-sm">
    <p className="font-bold">{r.race_date}／{String(r.venue_code).padStart(2,'0')}場 {r.race_number}R　{r.stage}</p>
    <p className="mt-1 text-xs text-slate-500">既存V7本命：{r.baseline_top||'未記録'}／締切 {r.deadline?.slice(11,16)||'—'}</p>
    <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">{(r.models||[]).filter(m=>pattern==='ALL'||m.key===pattern).map(m=><div key={m.key} className="rounded-lg bg-slate-50 p-2 text-xs">
     <p className="font-bold">{LABELS[m.key]||m.label}</p>
     <p className="mt-1">{m.status==='READY'?(m.top?'本命 '+m.top:'展開相性スコア '+fmt(m.score)):'入力不足・評価保留'}</p>
     <p className="mt-1 break-words text-slate-600">{(m.tickets||[]).join(' / ')||'買い目未算出'}</p>
    </div>)}</div>
   </div>)}</div>
   <p className="text-xs leading-5 text-slate-500">舟券太郎氏のSUM・シンSUM・スリットアラート等の非公開式は再現していません。展示相対評価は公開された考え方を参考にした独自の暫定研究モデルです。各理論のスコアは確率ではなく、理論間で直接大小比較もしません。的中率・回収率の正式比較は結果検証の接続後に行います。</p>
  </>}
 </section>;
}
