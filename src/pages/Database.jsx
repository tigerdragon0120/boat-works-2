import React, { useEffect, useMemo, useState } from 'react';
import { base44 } from '@/api/base44Client';
import PlayerPhoto from '@/components/race/PlayerPhoto';
import { Database as DbIcon, Users, MapPin, Gauge, Search, RefreshCw } from 'lucide-react';
import { cn } from '@/lib/utils';

const tabs=[['racers','選手DB',Users],['venues','レース場DB',MapPin],['motors','モーターDB',Gauge],['races','レースDB',DbIcon]];
export default function Database(){
  const [tab,setTab]=useState('racers'); const [q,setQ]=useState(''); const [busy,setBusy]=useState(false); const [data,setData]=useState({racers:[],venues:[],motors:[],races:[]});
  const load=async()=>{ const [racers,venues,motors,races]=await Promise.all([
    base44.entities.RacerDatabase.list('-latest_race_date',500), base44.entities.VenueDatabase.list('venue_code',100), base44.entities.MotorDatabase.list('-top2_rate',500), base44.entities.RaceDatabase.list('-race_date',500)
  ]); setData({racers,venues,motors,races}); };
  useEffect(()=>{load();},[]);
  const refresh=async()=>{setBusy(true);try{await base44.functions.invoke('refreshDatabase',{});await load();}finally{setBusy(false)}};
  const rows=useMemo(()=>{const s=q.trim().toLowerCase(); const a=data[tab]||[]; if(!s)return a; return a.filter(x=>JSON.stringify(x).toLowerCase().includes(s));},[data,tab,q]);
  return <div className="space-y-3">
    <div className="flex flex-wrap items-center justify-between gap-3"><div><h1 className="text-xl sm:text-2xl font-black text-white flex items-center gap-2"><DbIcon className="w-5 h-5 text-[#f9c836]"/>BOAT WORKS DATABASE</h1><p className="text-xs text-slate-500 mt-1">予想に使う長期データを蓄積・検証</p></div><button onClick={refresh} disabled={busy} className="h-10 px-4 rounded-lg bg-[#f9c836] text-slate-950 font-black text-sm flex items-center gap-2 disabled:opacity-50"><RefreshCw className={cn('w-4 h-4',busy&&'animate-spin')}/>{busy?'更新中':'DB更新'}</button></div>
    <div className="grid grid-cols-4 gap-1 bg-[#161a22] border border-[#2d3748] p-1 rounded-xl">{tabs.map(([k,label,I])=><button key={k} onClick={()=>setTab(k)} className={cn('h-10 rounded-lg text-[11px] sm:text-sm font-bold flex items-center justify-center gap-1.5',tab===k?'bg-[#f9c836] text-slate-950':'text-slate-400')}><I className="w-4 h-4"/><span className="hidden sm:inline">{label}</span></button>)}</div>
    <div className="relative"><Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500"/><input value={q} onChange={e=>setQ(e.target.value)} placeholder="選手名・登録番号・場名・モーター番号で検索" className="w-full h-11 pl-10 pr-3 rounded-xl bg-[#161a22] border border-[#2d3748] text-sm outline-none focus:border-blue-500"/></div>
    {tab==='racers'&&<Racers rows={rows}/>} {tab==='venues'&&<Venues rows={rows}/>} {tab==='motors'&&<Motors rows={rows}/>} {tab==='races'&&<Races rows={rows}/>} 
  </div>
}
function Card({children}){return <div className="bg-[#1e232d] border border-[#3a404c] rounded-xl overflow-hidden">{children}</div>}
function Racers({rows}){return <Card><div className="divide-y divide-[#303743]">{rows.map(r=><div key={r.registration_number} className="p-3 flex items-center gap-3"><PlayerPhoto src={r.photo_url} registrationNumber={r.registration_number} alt={r.racer_name} size="sm"/><div className="min-w-0 flex-1"><div className="font-bold text-white truncate">{r.racer_name||'—'} <span className="text-[10px] text-slate-500">#{r.registration_number}</span></div><div className="text-[10px] text-slate-500">{r.grade_class||'—'}・平均ST {n(r.avg_st,2)}・全国勝率 {n(r.national_win_rate,2)}</div></div><Stat label="実績1着" value={p(r.win_rate_actual)}/><Stat label="3着内" value={p(r.top3_rate_actual)}/><Stat label="標本" value={r.sample_races||0}/></div>)}</div>{!rows.length&&<Empty/>}</Card>}
function Venues({rows}){return <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-2">{rows.map(r=><Card key={r.venue_code}><div className="p-3"><div className="font-black text-white">{r.venue_name} <span className="text-xs text-slate-500">{r.venue_code}</span></div><div className="grid grid-cols-3 gap-2 mt-3"><Stat label="1号艇1着" value={p(r.boat1_win_rate)}/><Stat label="FINAL的中" value={p(r.final_hit_rate)}/><Stat label="回収率" value={p(r.recovery_rate)}/></div><div className="text-[10px] text-slate-500 mt-2">確定レース {r.sample_races||0}件</div></div></Card>)}</div>}
function Motors({rows}){return <Card><div className="divide-y divide-[#303743]">{rows.map(r=><div key={`${r.venue_code}_${r.motor_number}`} className="p-3 grid grid-cols-[1fr_60px_60px_60px] gap-2 items-center"><div className="font-bold text-white">場{r.venue_code}・M{r.motor_number}<div className="text-[10px] text-slate-500">公称2連 {p(r.latest_2rate)} / 標本 {r.sample_races||0}</div></div><Stat label="1着" value={p(r.win_rate)}/><Stat label="2着内" value={p(r.top2_rate)}/><Stat label="3着内" value={p(r.top3_rate)}/></div>)}</div>{!rows.length&&<Empty/>}</Card>}
function Races({rows}){return <Card><div className="divide-y divide-[#303743]">{rows.map(r=><div key={r.race_id} className="p-3 grid grid-cols-[1fr_auto] gap-2"><div><div className="font-bold text-white">{r.race_date} {r.venue_name} {r.race_number}R <span className="text-[10px] text-blue-300">{r.grade||'一般'}</span></div><div className="text-[11px] text-slate-500">結果 {r.result_trifecta||'未確定'} / 払戻 {r.payout?`${r.payout}円`:'—'} / FINAL {r.final_prediction||'—'}</div></div><div className={cn('text-xs font-black self-center',r.final_hit?'text-emerald-400':'text-slate-500')}>{r.final_hit?'HIT':'—'}</div></div>)}</div>{!rows.length&&<Empty/>}</Card>}
function Stat({label,value}){return <div className="text-right"><div className="text-[9px] text-slate-500">{label}</div><div className="text-xs sm:text-sm font-black text-slate-200">{value}</div></div>}
function Empty(){return <div className="p-10 text-center text-slate-500 text-sm">DBデータがありません。「DB更新」を押してください。</div>}
function n(v,d=1){return v==null?'—':Number(v).toFixed(d)} function p(v){return v==null?'—':`${Number(v).toFixed(1)}%`}
