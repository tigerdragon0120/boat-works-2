import React,{useEffect,useMemo,useState} from 'react';
import {base44} from '@/api/base44Client';
import {useAuth} from '@/lib/AuthContext';
import {jstDate} from '@/lib/v7Verification';

const VENUES={'01':'桐生','02':'戸田','03':'江戸川','04':'平和島','05':'多摩川','06':'浜名湖','07':'蒲郡','08':'常滑','09':'津','10':'三国','11':'びわこ','12':'住之江','13':'尼崎','14':'鳴門','15':'丸亀','16':'児島','17':'宮島','18':'徳山','19':'下関','20':'若松','21':'芦屋','22':'福岡','23':'唐津','24':'大村'};
const bucket=s=>s==null?null:s<3?'0〜2m':s<5?'3〜4m':s<8?'5〜7m':'8m以上';
const pct=(a,b)=>b?(100*a/b).toFixed(1)+'%':'—';
const time=x=>{
  if(!x)return '未取得';
  const d=new Date(x);return Number.isNaN(d.getTime())?'未取得':d.toLocaleString('ja-JP',{timeZone:'Asia/Tokyo',month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'});
};
const validSample=row=>row.kind==='RESULT_ACTUAL'&&row.quality==='COMPLETE'&&
  !!row.wind_dir&&row.wind_speed!=null&&typeof row.first_boat_win==='boolean';

export default function V7WeatherLab(){
  const {user}=useAuth();
  const admin=user?.role==='admin';
  const [rows,setRows]=useState(null),[error,setError]=useState(null),[loading,setLoading]=useState(false),[venue,setVenue]=useState('ALL');
  const reload=async()=>{
    if(!admin)return;
    setLoading(true);setError(null);
    try{
      const dates=Array.from({length:7},(_,i)=>jstDate(-i));
      const pages=await Promise.all(dates.map(date=>base44.entities.V7WeatherObservation.filter({race_date:date},'-created_date',500)));
      if(pages.some(x=>!Array.isArray(x)||x.length>=500))throw Error('全件取得を確認できないため集計できません');
      const unique=new Set(),all=[];
      for(const page of pages)for(const item of page){
        if(!item?.id||unique.has(item.id))throw Error('重複・欠損を検出しました');
        unique.add(item.id);all.push(item);
      }
      setRows(all);
    }catch(err){setRows(null);setError(err?.message||'気象記録の読込に失敗しました')}
    finally{setLoading(false)}
  };
  useEffect(()=>{if(admin)void reload()},[admin]);
  const summary=useMemo(()=>{
    const items=(rows||[]).filter(z=>venue==='ALL'||z.venue_code===venue);
    const pre=items.filter(x=>x.kind==='PRE_REFERENCE');
    const actual=items.filter(x=>x.kind==='RESULT_ACTUAL');
    const complete=actual.filter(validSample);
    const map=new Map();
    for(const row of complete){
      const key=(VENUES[row.venue_code]||row.venue_code)+'／'+row.wind_dir+'／'+bucket(row.wind_speed);
      const v=map.get(key)||{n:0,wins:0,venue:row.venue_code,dir:row.wind_dir,speed:bucket(row.wind_speed)};
      v.n++;if(row.first_boat_win)v.wins++;
      map.set(key,v);
    }
    const groups=[...map.values()].sort((a,b)=>b.n-a.n);
    return {pre,actual,complete,groups,partial:items.filter(z=>z.quality==='PARTIAL').length,
      missingDir:items.filter(z=>!z.wind_dir).length,
      recent:[...items].sort((a,b)=>String(b.created_date).localeCompare(String(a.created_date))).slice(0,20)};
  },[rows,venue]);
  if(!admin)return null;
  return <section className="space-y-4 rounded-xl border border-sky-200 bg-white p-3 sm:p-5" data-testid="v7-weather-lab">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h2 className="text-lg font-black text-slate-900">V7＋ 場別・風向風速の研究台帳</h2>
        <p className="mt-1 text-xs leading-5 text-slate-600">直近7日。レース前の参照気象と結果ページの当該レース気象を別々に保管。予想・BUYにはまだ反映しません。</p>
      </div>
      <button type="button" onClick={reload} disabled={loading} className="min-h-11 rounded-lg border border-slate-300 bg-white px-4 text-sm font-bold disabled:opacity-60">{loading?'読込中…':'最新記録を取得'}</button>
    </div>
    <label className="text-sm font-semibold text-slate-700">開催場
      <select className="ml-2 min-h-11 rounded-lg border bg-white px-3" value={venue} onChange={e=>setVenue(e.target.value)}>
        <option value="ALL">全24場</option>
        {Object.entries(VENUES).map(([k,v])=><option key={k} value={k}>{v}</option>)}
      </select>
    </label>
    {error&&<p role="alert" className="rounded-lg bg-rose-50 p-3 text-sm text-rose-800">{error}</p>}
    {!rows&&!error&&<p className="text-sm text-slate-500">収集記録を読み込み中…</p>}
    {rows&&<>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {[
          ['締切前の参照記録',summary.pre.length+'件'],
          ['レース後の実測候補',summary.actual.length+'件'],
          ['風向・風速・結果が揃う',summary.complete.length+'件'],
          ['風向未取得',summary.missingDir+'件']
        ].map(([name,value])=><div key={name} className="rounded-lg border bg-slate-50 p-3"><div className="text-xs text-slate-500">{name}</div><div className="mt-1 text-xl font-black">{value}</div></div>)}
      </div>
      <h3 className="text-sm font-black">開催場×風向×風速帯ごとの1号艇1着率</h3>
      {summary.groups.length?<div className="overflow-x-auto"><table className="w-full min-w-[420px] text-sm">
        <thead className="bg-slate-50"><tr><th className="p-2 text-left">条件</th><th className="p-2 text-right">件数</th><th className="p-2 text-right">1号艇1着率</th></tr></thead>
        <tbody>{summary.groups.map(g=><tr key={g.venue+g.dir+g.speed} className="border-t">
          <td className="p-2">{VENUES[g.venue]}／{g.dir}／{g.speed}</td><td className="p-2 text-right">{g.n}</td>
          <td className="p-2 text-right font-bold">{g.n>=30?pct(g.wins,g.n):'標本不足'}</td>
        </tr>)}</tbody>
      </table></div>:<p className="rounded-lg bg-slate-50 p-4 text-sm text-slate-600">条件が揃う記録はまだありません。公式の風向情報が取れなければ勝率を表示しません。</p>}
      <h3 className="text-sm font-black">最近の収集状況</h3>
      <div className="space-y-2">{summary.recent.map(z=><div key={z.id} className="rounded-lg border p-3 text-xs">
        <div className="flex flex-wrap justify-between gap-2 font-semibold"><span>{z.race_date} {VENUES[z.venue_code]||z.venue_code} {z.race_number}R</span><span>{z.kind==='PRE_REFERENCE'?'締切前・参照気象':'レース後・結果気象'}</span></div>
        <div className="mt-1 text-slate-600">観測取得 {time(z.observed_at)} ／ 公式表示時刻 {time(z.source_display_time)} ／ 風向 {z.wind_dir||'未取得'}・風速 {z.wind_speed==null?'未取得':z.wind_speed+'m'} ／ {z.quality}</div>
      </div>)}</div>
      <p className="text-xs leading-5 text-slate-500">公式の直前気象は直近レースの値である場合があります。締切前の参照値を当該レースの実測として勝率の分母に加えません。30件未満の細分類は標本不足。過去データや未来の気象を予想時点へ流用しません。</p>
    </>}
  </section>;
}
