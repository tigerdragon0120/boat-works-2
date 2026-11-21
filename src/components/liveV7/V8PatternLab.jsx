import React,{useEffect,useMemo,useState} from 'react';
import {base44} from '@/api/base44Client';
import {useAuth} from '@/lib/AuthContext';
import {jstDate} from '@/lib/v7Verification';
const VENUES={'01':'桐生','02':'戸田','03':'江戸川','04':'平和島','05':'多摩川','06':'浜名湖','07':'蒲郡','08':'常滑','09':'津','10':'三国','11':'びわこ','12':'住之江','13':'尼崎','14':'鳴門','15':'丸亀','16':'児島','17':'宮島','18':'徳山','19':'下関','20':'若松','21':'芦屋','22':'福岡','23':'唐津','24':'大村'};
const speedClass=n=>n==null?'風速未取得':n<3?'0〜2m':n<5?'3〜4m':n<8?'5〜7m':'8m以上';
const pct=(a,n)=>n?(100*a/n).toFixed(1)+'%':'—';
export default function V8PatternLab(){
 const {user}=useAuth(),admin=user?.role==='admin';
 const [records,setRecords]=useState(null),[error,setError]=useState(null),[loading,setLoading]=useState(false);
 const [venue,setVenue]=useState('ALL'),[model,setModel]=useState('ALL'),[view,setView]=useState('weather');
 const reload=async()=>{
  if(!admin)return;setLoading(true);setError(null);
  try{
   const dates=Array.from({length:7},(_,i)=>jstDate(-i));
   const chunks=await Promise.all(dates.map(race_date=>base44.entities.V8PatternEvidence.filter({race_date},'-created_date',500)));
   if(chunks.some(c=>!Array.isArray(c)||c.length>=500))throw Error('一部の日付の全件取得を確認できません。集計を停止しました');
   const ids=new Set(),combined=[];
   for(const chunk of chunks)for(const r of chunk){
    if(!r?.id||ids.has(r.id))throw Error('記録に重複または欠落があります');
    ids.add(r.id);combined.push(r);
   }setRecords(combined);
  }catch(e){setRecords(null);setError(e?.message||'データ取得に失敗しました')}
  finally{setLoading(false)}
 };
 useEffect(()=>{if(admin)void reload()},[admin]);
 const data=useMemo(()=>{
  const relevant=(records||[]).filter(r=>(venue==='ALL'||r.venue_code===venue)&&(model==='ALL'||r.model===model));
  const unique=new Map();
  for(const r of relevant){
   // Same race/version duplicates should not be counted as independent races.
   const prior=unique.get(r.race_key);
   if(!prior||String(r.created_date)>String(prior.created_date))unique.set(r.race_key,r);
  }
  const rows=[...unique.values()];
  const w=rows.filter(r=>r.wind_speed!=null&&(r.wind_icon_code!=null||r.wind_dir));
  const methods=rows.filter(r=>r.winning_method);
  const factors=new Map();
  for(const r of w){
   const dir=r.wind_dir||'風向コード'+r.wind_icon_code;
   const key=(VENUES[r.venue_code]||r.venue_code)+' / '+dir+' / '+speedClass(r.wind_speed);
   const v=factors.get(key)||{key,n:0,inside:0,methods:{}};
   v.n++;if(r.winner_boat===1)v.inside++;
   if(r.winning_method)v.methods[r.winning_method]=(v.methods[r.winning_method]||0)+1;
   factors.set(key,v);
  }
  const byPlayer=new Map();
  for(const r of rows)for(const b of r.boat_results||[]){
   if(!b.registration_number||!b.entry_known)continue;
   const key=b.registration_number+'-'+b.boat_number;
   const old=byPlayer.get(key)||{key,registration_number:b.registration_number,lane:b.boat_number,n:0,w:0,two:0,three:0};
   old.n++;if(b.win)old.w++;if(b.top2)old.two++;if(b.top3)old.three++;byPlayer.set(key,old);
  }
  return {rows,w,methods,raw:relevant.length,
   patterns:[...factors.values()].sort((a,b)=>b.n-a.n).slice(0,20),
   players:[...byPlayer.values()].sort((a,b)=>b.n-a.n).slice(0,25),
   methodSummary:Object.entries(methods.reduce((acc,r)=>(acc[r.winning_method]=(acc[r.winning_method]||0)+1,acc),{})).sort((a,b)=>b[1]-a[1])
  };
 },[records,venue,model]);
 if(!admin)return null;
 return <section data-testid="v8-pattern-lab" className="space-y-4 rounded-xl border border-sky-200 bg-white p-3 sm:p-5">
  <div className="flex flex-wrap items-start justify-between gap-3">
   <div><h2 className="text-lg font-black text-slate-900">V8・水面×選手 勝ちパターン分析</h2>
    <p className="mt-1 text-xs text-slate-600">研究用・直近7日。レース結果後に保存した記録だけで集計。既存BUY・V7予想には未反映。</p></div>
   <button type="button" onClick={reload} disabled={loading} className="min-h-11 rounded-lg border border-slate-300 px-4 text-sm font-semibold">{loading?'更新中…':'データ更新'}</button>
  </div>
  <div className="flex flex-wrap gap-3">
   <label className="text-sm">開催場 <select className="min-h-10 rounded-lg border bg-white px-2" value={venue} onChange={e=>setVenue(e.target.value)}><option value="ALL">全24場</option>{Object.entries(VENUES).map(([code,name])=><option key={code} value={code}>{name}</option>)}</select></label>
   <label className="text-sm">レース <select className="min-h-10 rounded-lg border bg-white px-2" value={model} onChange={e=>setModel(e.target.value)}><option value="ALL">全種別</option><option value="OPEN">一般</option><option value="WOMENS">女子</option></select></label>
   <label className="text-sm">分析 <select className="min-h-10 rounded-lg border bg-white px-2" value={view} onChange={e=>setView(e.target.value)}><option value="weather">場×風×決まり手</option><option value="racer">選手×枠番</option></select></label>
  </div>
  {error&&<p role="alert" className="rounded-lg bg-rose-50 p-3 text-sm text-rose-800">{error}</p>}
  {!records&&!error&&<p className="text-sm text-slate-500">履歴を読み込み中…</p>}
  {records&&<>
   <div className="grid grid-cols-3 gap-2">
    {[['レース記録',data.rows.length],['気象と結果',data.w.length],['決まり手あり',data.methods.length]].map(([k,v])=><div key={k} className="rounded-lg border bg-slate-50 p-3"><p className="text-xs text-slate-500">{k}</p><p className="mt-1 text-xl font-black">{v}</p></div>)}
   </div>
   {view==='weather'?<>
    <p className="text-xs text-slate-600">同じ場・風向・風速帯の組み合わせだけで、1号艇の1着と勝ち方を集計。30件未満は参考サンプルとして件数のみ表示。</p>
    <div className="space-y-2">{data.patterns.map(v=><div key={v.key} className="rounded-lg border p-3 text-sm">
     <div className="flex justify-between gap-2"><strong>{v.key}</strong><span>{v.n}R</span></div>
     <p className="mt-1 text-xs">1号艇1着：{v.n>=30?pct(v.inside,v.n):'標本不足（'+v.inside+'/'+v.n+'）'}</p>
     <p className="mt-1 text-xs text-slate-600">{Object.entries(v.methods).map(([m,n])=>m+' '+n+'件').join(' / ')||'決まり手未取得'}</p>
    </div>)}</div>
    {!data.patterns.length&&<p className="rounded-lg bg-slate-50 p-4 text-sm">気象条件と確定結果が揃ったレースがまだありません。</p>}
   </>:<>
    <p className="text-xs text-slate-600">選手登録番号×枠番ごとの実成績。実進入コースの独立確認ができていないため、コース別勝率とは呼びません。</p>
    <div className="overflow-x-auto"><table className="w-full min-w-[450px] text-xs">
     <thead className="bg-slate-50"><tr><th className="p-2 text-left">登録番号</th><th>枠</th><th>出走</th><th>1着率</th><th>2連対</th><th>3連対</th></tr></thead>
     <tbody>{data.players.map(v=><tr key={v.key} className="border-t">
      <td className="p-2 font-bold">{v.registration_number}</td><td className="text-center">{v.lane}</td><td className="text-center">{v.n}</td>
      <td className="text-center">{v.n>=10?pct(v.w,v.n):v.w+'/'+v.n}</td><td className="text-center">{v.n>=10?pct(v.two,v.n):v.two+'/'+v.n}</td><td className="text-center">{v.n>=10?pct(v.three,v.n):v.three+'/'+v.n}</td>
     </tr>)}</tbody>
    </table></div>
   </>}
   <p className="text-xs leading-5 text-slate-500">未取得の潮位・潮流は不明のまま保存。枠番と進入コースを混同せず、決まり手不明レースは決まり手の分母に含めません。少数データの勝率を過信しません。</p>
  </>}
 </section>;
}
