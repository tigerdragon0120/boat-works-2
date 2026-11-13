import React,{useEffect,useState} from 'react';
import {base44} from '@/api/base44Client';
export default function V7SavedServerView({race}) {
 const [rows,setRows]=useState([]),[loading,setLoading]=useState(true),[error,setError]=useState(false);
 useEffect(()=>{let active=true;setRows([]);setLoading(true);setError(false);
 base44.entities.PredictionV7.filter({race_id:race.id},'-created_date',30).then(v=>{if(active)setRows(Array.isArray(v)?v:[])}).catch(()=>{if(active)setError(true)}).finally(()=>{if(active)setLoading(false)});
 return()=>{active=false};
 },[race.id]);
 const deadline=Date.parse(race.deadline||'');
 const valid=rows.filter(r=>{const t=Date.parse(r.created_date||'');return Number.isFinite(deadline)&&Number.isFinite(t)&&t<deadline});
 return <div className="rounded-xl border-2 border-indigo-200 bg-white p-4 space-y-3">
 <h3 className="font-black text-lg">V7・サーバー保存済み予想</h3>
 <p className="text-xs text-slate-600">締切前にDB保存された予想を読み取り専用で表示。締切後に新たな予想は生成しません。</p>
 {loading?<p>取得中…</p>:error?<p role="alert">DB保存履歴を取得できませんでした</p>:['PRE','FINAL'].map(stage=>{
 const matches=valid.filter(r=>r.stage===stage);
 if(matches.length!==1)return <p key={stage} className="rounded-lg bg-amber-50 p-3">{stage}：{matches.length?'重複のため表示保留':'保存済み記録なし'}</p>;
 const r=matches[0],plan=r.plans?.hit_8||r.plans?.hit_6||r.plans?.hit_4;
 return <div key={stage} className="rounded-lg border p-3 space-y-2">
 <strong>{stage}・{r.source==='SERVER'?'自動生成':'端末同期'}</strong>
 <p className="font-bold">三連単 {r.top_combination||'—'} ／ 確率 {Number.isFinite(+r.top_probability)?(+r.top_probability*100).toFixed(1)+'%':'—'}</p>
 <p className="text-sm">8点候補：{plan?.tickets?.join(' / ')||'なし'}</p>
 <p className="text-xs text-slate-600">DB保存時刻：{r.created_date||'不明'}・試験予想／購入推奨ではありません</p>
 </div>;
 })}
 </div>;
}