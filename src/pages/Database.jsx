import React, { useEffect, useMemo, useState } from 'react';
import { base44 } from '@/api/base44Client';
import PlayerPhoto from '@/components/race/PlayerPhoto';
import { Database as DbIcon, Users, Search, RefreshCw, History } from 'lucide-react';
import { cn } from '@/lib/utils';

const PAGE_SIZE=100;
const tabs=[['profiles','選手プロフィール',Users],['terms','期別成績',History]];
export default function Database(){
 const [tab,setTab]=useState('profiles'),[q,setQ]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const [rows,setRows]=useState([]),[total,setTotal]=useState(0),[page,setPage]=useState(1),[termCounts,setTermCounts]=useState({}),[profileCount,setProfileCount]=useState(0),[selectedTerm,setSelectedTerm]=useState('');
 const termKeys=useMemo(()=>Object.keys(termCounts).sort().reverse(),[termCounts]);
 const invoke=async(body)=>{const r=await base44.functions.invoke('getDatabasePage',body);return r?.data||r;};
 const loadSummary=async()=>{const d=await invoke({mode:'summary'});if(!d?.ok)throw new Error(d?.error||'集計失敗');setTermCounts(d.term_counts||{});setProfileCount(d.profile_count||0);if(!selectedTerm){const ks=Object.keys(d.term_counts||{}).sort().reverse();setSelectedTerm(ks[0]||'');}};
 const loadRows=async(p=page)=>{setBusy(true);setError('');try{const mode=tab==='profiles'?'profiles':'terms';const d=await invoke({mode,term_key:mode==='terms'?selectedTerm:'',q,page:p,page_size:PAGE_SIZE});if(!d?.ok)throw new Error(d?.error||'DB読込失敗');setRows(d.rows||[]);setTotal(d.total||0);}catch(e){setRows([]);setTotal(0);setError(e?.message||'DBの読込に失敗しました');}finally{setBusy(false);}};
 const reload=async()=>{setBusy(true);setError('');try{await loadSummary();}catch(e){setError(e?.message||'集計読込失敗');}finally{setBusy(false);}};
 useEffect(()=>{reload();},[]);
 useEffect(()=>{if(tab==='profiles'||selectedTerm){setPage(1);loadRows(1);}},[tab,selectedTerm]);
 useEffect(()=>{const t=setTimeout(()=>{setPage(1);loadRows(1);},300);return()=>clearTimeout(t);},[q]);
 const pages=Math.max(1,Math.ceil(total/PAGE_SIZE));
 return <div className="space-y-3">
  <div className="flex flex-wrap items-center justify-between gap-3"><div><h1 className="text-xl sm:text-2xl font-black text-white flex items-center gap-2"><DbIcon className="w-5 h-5 text-[#f9c836]"/>BOAT WORKS DATABASE</h1><p className="text-xs text-slate-500 mt-1">サーバー側ページングで全件検索</p></div><button onClick={async()=>{await reload();await loadRows(1)}} disabled={busy} className="h-10 px-4 rounded-lg bg-[#f9c836] text-slate-950 font-black text-sm flex items-center gap-2 disabled:opacity-50"><RefreshCw className={cn('w-4 h-4',busy&&'animate-spin')}/>{busy?'読込中':'再読込'}</button></div>
  <div className="grid grid-cols-2 gap-2"><Summary label="選手プロフィール" value={profileCount} suffix="人" sub="期別成績から最新プロフィールを集計"/><Summary label="期別成績" value={selectedTerm?(termCounts[selectedTerm]||0):0} suffix="人" sub={selectedTerm?`${selectedTerm} の全選手`:'期を選択'}/></div>
  {error&&<div className="rounded-xl border border-rose-500/30 bg-rose-950/40 px-3 py-2 text-sm text-rose-300">{error}</div>}
  <div className="grid grid-cols-2 gap-1 bg-[#161a22] border border-[#2d3748] p-1 rounded-xl">{tabs.map(([k,l,I])=><button key={k} onClick={()=>setTab(k)} className={cn('h-10 rounded-lg text-xs sm:text-sm font-bold flex items-center justify-center gap-1.5',tab===k?'bg-[#f9c836] text-slate-950':'text-slate-400')}><I className="w-4 h-4"/>{l}</button>)}</div>
  {tab==='terms'&&<select value={selectedTerm} onChange={e=>setSelectedTerm(e.target.value)} className="w-full h-11 px-3 rounded-xl bg-[#161a22] border border-[#2d3748] text-sm text-slate-200">{termKeys.map(k=><option key={k} value={k}>{k}（{termCounts[k]}人）</option>)}</select>}
  <div className="relative"><Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500"/><input value={q} onChange={e=>setQ(e.target.value)} placeholder="選手名・登録番号・支部・級別・期・元ファイル名で全件検索" className="w-full h-11 pl-10 pr-3 rounded-xl bg-[#161a22] border border-[#2d3748] text-sm outline-none focus:border-blue-500"/></div>
  <div className="flex items-center justify-between text-xs text-slate-500 px-1"><span>{total}件中 {total?((page-1)*PAGE_SIZE+1):0}〜{Math.min(page*PAGE_SIZE,total)}件</span><div className="flex items-center gap-2"><button disabled={page<=1||busy} onClick={()=>{const p=page-1;setPage(p);loadRows(p)}} className="px-3 py-2 rounded-lg border border-[#303743] disabled:opacity-30">前へ</button><span>{page}/{pages}</span><button disabled={page>=pages||busy} onClick={()=>{const p=page+1;setPage(p);loadRows(p)}} className="px-3 py-2 rounded-lg border border-[#303743] disabled:opacity-30">次へ</button></div></div>
  {tab==='profiles'?<Profiles rows={rows}/>:<Terms rows={rows}/>} </div>;
}
function Summary({label,value,suffix,sub}){return <div className="bg-[#1e232d] border border-[#3a404c] rounded-xl p-3"><div className="text-[10px] text-slate-500">{label}</div><div className="text-xl font-black text-white mt-1">{value}<span className="text-[10px] text-slate-500 ml-1">{suffix}</span></div><div className="text-[9px] text-slate-500 mt-1">{sub}</div></div>}
function Card({children}){return <div className="bg-[#1e232d] border border-[#3a404c] rounded-xl overflow-hidden">{children}</div>}
function Profiles({rows}){return <Card><div className="divide-y divide-[#303743]">{rows.map(r=><div key={r.id||`${r.registration_number}_${r.term_key}`} className="p-3 flex items-center gap-3"><PlayerPhoto src={r.photo_url} registrationNumber={r.registration_number} alt={r.racer_name} size="sm"/><div className="min-w-0 flex-1"><div className="font-bold text-white truncate">{r.racer_name||'—'} <span className="text-[10px] text-slate-500">#{r.registration_number}</span></div><div className="text-[10px] text-slate-500">{r.player_class||'—'} ・ {r.branch_name||'—'} ・ {r.age??'—'}歳 ・ {r.weight??'—'}kg</div></div><Stat label="勝率" value={num(r.win_rate,2)}/><Stat label="2連率" value={pct(r.fukusho_rate)}/><Stat label="平均ST" value={num(r.avg_st,2)}/></div>)}</div>{!rows.length&&<Empty/>}</Card>}
function Terms({rows}){return <Card><div className="divide-y divide-[#303743]">{rows.map(r=><div key={r.id} className="p-3 flex items-center justify-between gap-3"><div className="min-w-0"><div className="font-bold text-white truncate">{r.racer_name||'—'} <span className="text-[10px] text-slate-500">#{r.registration_number}</span></div><div className="text-[10px] text-slate-500">{r.term_key||'—'} ・ {r.player_class||'—'} ・ {r.branch_name||'—'} ・ {r.source_file||'—'}</div></div><div className="grid grid-cols-4 gap-3 shrink-0"><Stat label="出走" value={r.race_count??0}/><Stat label="勝率" value={num(r.win_rate,2)}/><Stat label="2連率" value={pct(r.fukusho_rate)}/><Stat label="平均ST" value={num(r.avg_st,2)}/></div></div>)}</div>{!rows.length&&<Empty/>}</Card>}
function Stat({label,value}){return <div className="text-right"><div className="text-[9px] text-slate-500">{label}</div><div className="text-xs sm:text-sm font-black text-slate-200">{value??'—'}</div></div>}
function Empty(){return <div className="p-10 text-center text-slate-500 text-sm">表示できるデータがありません。</div>}
function num(v,d=1){return v==null?'—':Number(v).toFixed(d)} function pct(v){return v==null?'—':`${Number(v).toFixed(1)}%`}
