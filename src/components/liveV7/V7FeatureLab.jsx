// Admin-only V7 factor data lab. Uses immutable pre-deadline feature observations.
// Joins results ONLY after independent V7 verification; never rewrites features/predictions.
import React,{useEffect,useMemo,useState} from 'react';
import { base44 } from '@/api/base44Client';
import { useAuth } from '@/lib/AuthContext';
import { jstDate } from '@/lib/v7Verification';

const PAGE=200;
const pct=(a,b)=>b>0?(100*a/b).toFixed(1)+'%':'—';
const number=n=>Number(n||0).toLocaleString('ja-JP');
const NAME={OPEN:'一般戦',WOMENS:'女子戦',UNKNOWN:'種別不明',
  QUALIFYING:'予選',SEMIFINAL:'準優勝戦',FINAL:'優勝戦',OTHER:'一般・特別',UNKNOWN_PHASE:'不明'};
const venueNames={
  '01':'桐生','02':'戸田','03':'江戸川','04':'平和島','05':'多摩川','06':'浜名湖',
  '07':'蒲郡','08':'常滑','09':'津','10':'三国','11':'びわこ','12':'住之江',
  '13':'尼崎','14':'鳴門','15':'丸亀','16':'児島','17':'宮島','18':'徳山',
  '19':'下関','20':'若松','21':'芦屋','22':'福岡','23':'唐津','24':'大村'
};
const utc=value=>{
  const raw=String(value||'').trim().replace(/(\.\d{3})\d+/,'$1');
  if(!raw)return null;
  const time=Date.parse(/(Z|[+-]\d{2}:?\d{2})$/.test(raw)?raw:raw+'Z');
  return Number.isFinite(time)?time:null;
};
async function loadAll(query) {
  const rows=[];
  const ids=new Set(),cursors=new Set();
  let cursor;
  for(let i=0;i<25;i++){
    const page=await base44.entities.V7FeatureSnapshot.filter(query,{
      sort:'-created_date',limit:PAGE,...(cursor?{cursor}:{})
    });
    if(!Array.isArray(page?.items)||typeof page.has_more!=='boolean')throw new Error('収集台帳を全件読み込めません');
    for(const row of page.items){
      if(!row?.id||ids.has(row.id))throw new Error('台帳の重複または不正な行');
      ids.add(row.id);rows.push(row);
    }
    if(!page.has_more){
      if(page.next_cursor)throw new Error('最終ページのカーソルが不正');
      return rows;
    }
    if(!page.next_cursor||cursors.has(page.next_cursor))throw new Error('途中ページの取得失敗');
    cursors.add(page.next_cursor);cursor=page.next_cursor;
  }
  throw new Error('直近7日の上限5000件を超えたため集計停止');
}
function Metric({label,value,sub}) {
  return <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
    <p className="text-xs text-slate-600">{label}</p>
    <p className="mt-1 text-xl font-black text-slate-900">{value}</p>
    {sub&&<p className="mt-1 text-[11px] text-slate-500">{sub}</p>}
  </div>;
}
function SmallTable({title,rows,empty='まだ有効データがありません'}) {
  return <section className="rounded-lg border border-slate-200 bg-white p-3">
    <h4 className="mb-2 text-sm font-black text-slate-900">{title}</h4>
    {rows.length ? <div className="space-y-2">{rows.map((r,i)=><div key={r.key||i} className="flex flex-wrap justify-between gap-2 border-b border-slate-100 pb-2 text-xs">
      <span className="font-semibold text-slate-700">{r.label}</span>
      <span className="tabular-nums text-slate-800">{r.value}</span>
    </div>)}</div>:<p className="text-xs text-slate-500">{empty}</p>}
  </section>;
}

function aggregate(rows,verificationByRace,model) {
  const eligible=rows.filter(s=>{
    const created=utc(s.created_date),observed=utc(s.observed_at),deadline=utc(s.deadline);
    return s.gender_model===model&&created!=null&&observed!=null&&deadline!=null
      &&created<deadline-60000 &&observed<deadline-60000;
  });
  const dedup=new Map();
  const stageWeight={LOCK:3,FINAL:2,PRE:1};
  for(const item of eligible){
    const prior=dedup.get(item.race_key);
    if(!prior||stageWeight[item.snapshot_stage]>stageWeight[prior.snapshot_stage]||
      (stageWeight[item.snapshot_stage]===stageWeight[prior.snapshot_stage]&&String(item.created_date)>String(prior.created_date)))
      dedup.set(item.race_key,item);
  }
  const selected=[...dedup.values()];
  const withResults=selected.filter(s=>verificationByRace.has(s.race_key));
  const firstWins=withResults.filter(s=>verificationByRace.get(s.race_key)?.startsWith('1-'));
  const weatherRows=selected.filter(s=>s.weather_complete);
  const rankRows=selected.filter(s=>s.qualifying_rank_complete);
  const movement=selected.filter(s=>s.market?.comparable_count>=1);
  const changed=selected.filter(s=>s.signals?.top_changed!=null);
  const finalWithPre=withResults.filter(s=>s.signals?.pre_top && s.signals?.final_top);
  const preHit=finalWithPre.filter(s=>s.signals.pre_top===verificationByRace.get(s.race_key)).length;
  const finalHit=finalWithPre.filter(s=>s.signals.final_top===verificationByRace.get(s.race_key)).length;
  const motorSamples=withResults.filter(s=>(s.boats||[]).length===6&&s.boats.every(b=>b.motor_2rate!=null));
  let motorTopWins=0;
  for(const snap of motorSamples){
    const best=[...snap.boats].sort((a,b)=>b.motor_2rate-a.motor_2rate)[0];
    if(Number(verificationByRace.get(snap.race_key).split('-')[0])===best?.boat_number)motorTopWins++;
  }
  const buckets=Object.entries(selected.reduce((acc,s)=>{
    const key=s.phase||'UNKNOWN';
    if(!acc[key])acc[key]={total:0,result:0,win1:0};
    acc[key].total++;
    if(verificationByRace.has(s.race_key)){acc[key].result++;if(verificationByRace.get(s.race_key).startsWith('1-'))acc[key].win1++}
    return acc;
  },{})).map(([key,v])=>({key,label:NAME[key]||key,value:v.total+'レース／結果照合'+v.result+'件'}));
  const byVenueWeather=Object.entries(withResults.reduce((acc,s)=>{
    if(!s.weather_complete)return acc;
    const band=s.wind_speed>=5?'5m以上':s.wind_speed>=3?'3〜4m':'0〜2m';
    const key=(venueNames[s.venue_code]||s.venue_code)+'・'+s.wind_dir+'・'+band;
    if(!acc[key])acc[key]={n:0,win:0};
    acc[key].n++;if(verificationByRace.get(s.race_key).startsWith('1-'))acc[key].win++;
    return acc;
  },{})).sort((a,b)=>b[1].n-a[1].n).slice(0,8).map(([key,v])=>({
    key,label:key,value:v.n>=10?pct(v.win,v.n)+'（'+v.win+'/'+v.n+'）':v.n+'件・標本不足'
  }));
  return {
    total:selected.length,rawCount:eligible.length,withResults:withResults.length,
    weather:weatherRows.length,ranks:rankRows.length,firstWins:firstWins.length,
    movement:movement.length,changed:changed.length,
    changedCount:changed.filter(s=>s.signals.top_changed).length,
    compared:finalWithPre.length,preHit,finalHit,
    motorN:motorSamples.length,motorTopWins,
    oddsDelta:movement.length?movement.reduce((sum,s)=>sum+Math.abs(Number(s.market.average_odds_change_pct)||0),0)/movement.length:null,
    phases:buckets,windRows:byVenueWeather,
    recent:selected.sort((a,b)=>String(b.observed_at).localeCompare(String(a.observed_at))).slice(0,12)
  };
}

export default function V7FeatureLab({groups=[]}) {
  const {user}=useAuth();
  const admin=user?.role==='admin';
  const [snapshots,setSnapshots]=useState(null),[error,setError]=useState(null),[busy,setBusy]=useState(false),[model,setModel]=useState('OPEN');
  const load=async()=>{
    if(!admin)return;
    setBusy(true);setError(null);
    try{setSnapshots(await loadAll({race_date:{$gte:jstDate(-6),$lte:jstDate(0)}}))}
    catch(e){setSnapshots(null);setError(e?.message||'収集台帳の取得に失敗しました')}
    finally{setBusy(false)}
  };
  useEffect(()=>{if(admin)void load()},[admin]);
  const actualByRace=useMemo(()=>{
    const map=new Map();
    for(const item of groups){
      if(item.stage!=='FINAL'||item.status!=='VERIFIED')continue;
      const result=String(item.verification?.actual_result||'');
      if(/^[1-6]-[1-6]-[1-6]$/.test(result)&&new Set(result.split('-')).size===3)
        map.set(item.raceKey,result);
    }
    return map;
  },[groups]);
  const data=useMemo(()=>aggregate(snapshots||[],actualByRace,model),[snapshots,actualByRace,model]);
  if(!admin)return null;
  return <section data-testid="v7-feature-lab" className="rounded-xl border border-sky-200 bg-white p-3 space-y-4 sm:p-5">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h2 className="text-lg font-black text-slate-900">V7 多因子データ収集・分析</h2>
        <p className="mt-1 text-xs leading-5 text-slate-600">管理者用の研究画面。事前／展示後／締切前の保存値だけを使い、レース確定後の数字を予想時点へ逆流させません。</p>
        <p className="text-xs text-slate-500">直近7日・V7本体と現行BUYは変更しません。欠損値は補完しません。</p>
      </div>
      <button type="button" onClick={load} disabled={busy} className="min-h-11 rounded-lg border border-slate-300 bg-white px-3 text-sm font-bold disabled:opacity-60">
        {busy?'集計中…':'最新データを再読込'}
      </button>
    </div>
    <label className="text-sm font-medium text-slate-700">モデル別に独立集計
      <select className="ml-2 min-h-11 rounded-lg border border-slate-300 bg-white px-2" value={model} onChange={e=>setModel(e.target.value)}>
        <option value="OPEN">一般戦</option><option value="WOMENS">女子戦</option>
      </select>
    </label>
    {error&&<p role="alert" className="rounded-lg bg-rose-50 p-3 text-sm text-rose-800">{error}</p>}
    {!snapshots&&!error&&<p className="text-xs text-slate-500">前向き記録を読み込み中…</p>}
    {snapshots&&<>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Metric label="保存済みレース" value={number(data.total)+'R'} sub={'時点記録 '+number(data.rawCount)+'件'} />
        <Metric label="結果照合済み" value={number(data.withResults)+'R'} sub="V7 VERIFIEDと一致したもののみ" />
        <Metric label="オッズ変動を比較" value={number(data.movement)+'R'} sub={data.oddsDelta!=null?'平均変化の絶対値 '+data.oddsDelta.toFixed(1)+'%':'まだ不足'} />
        <Metric label="予想の本命変更" value={number(data.changedCount)+'R'} sub={data.changed+'レースでPREとFINALの比較可能'} />
      </div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Metric label="気象・風の取得" value={pct(data.weather,data.total)} sub={data.weather+'/'+data.total+'R'} />
        <Metric label="公式予選順位の取得" value={pct(data.ranks,data.total)} sub={data.ranks+'/'+data.total+'R／推定順位を代用しない'} />
        <Metric label="モーター2連率1位艇の1着" value={pct(data.motorTopWins,data.motorN)} sub={data.motorTopWins+'/'+data.motorN+'R・単純な観察値'} />
        <Metric label="1号艇の1着率" value={pct(data.firstWins,data.withResults)} sub={data.firstWins+'/'+data.withResults+'R・場と気象は別比較'} />
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <SmallTable title="開催区分別の収集件数" rows={data.phases}/>
        <SmallTable title="開催場×風向×風速別の1号艇1着率" rows={data.windRows} empty="実測の風向・風速が揃うまで表示しません。各条件10レース未満は標本不足です。"/>
        <SmallTable title="事前→展示後で本命が変わったか"
          rows={[{label:'PREとFINAL両方を比較',value:data.compared+'R'},
            {label:'PRE本命の三連単的中',value:data.preHit+'/'+data.compared+'R'},
            {label:'FINAL本命の三連単的中',value:data.finalHit+'/'+data.compared+'R'}]}
          />
        <SmallTable title="収集方針と未取得の扱い"
          rows={[
            {label:'予選4日目・5日目の勝負がけ',value:'開催日・公式順位・基準が揃うまで未判定'},
            {label:'準優勝戦・優勝戦',value:'レース種別で別集計'},
            {label:'女子戦の優位性',value:'一般戦と混合せず、別標本で検証'},
            {label:'モーター勝率・2連率・3連率',value:'取得値・艇内差・時刻を保存'}
          ]} />
      </div>
      <div>
        <h3 className="mb-2 text-sm font-black text-slate-900">最近の収集記録</h3>
        <div className="space-y-2">
          {data.recent.map(s=><div key={s.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-200 p-2 text-xs">
            <span className="font-semibold">{s.race_date} {venueNames[s.venue_code]||s.venue_code} {s.race_number}R</span>
            <span>{s.snapshot_stage} ／ {NAME[s.phase]||s.phase}</span>
            <span>オッズ比較 {s.market?.comparable_count||0}点</span>
            <span>{s.weather_complete?'風データあり':'風未取得'}</span>
          </div>)}
        </div>
        {!data.total&&<p className="rounded-lg bg-slate-50 p-4 text-sm text-slate-500">まだ観測記録がありません。自動収集を開始すると、ここへ表示されます。</p>}
      </div>
      <p className="text-[11px] leading-5 text-slate-500">数値は相関や傾向の観察用です。観測レースが増えるまで高勝率とは断定しません。予選順位や風の向かい・追い分類を推測で補いません。V7の予想エンジンと現行BUYの判断にはまだ反映しません。</p>
    </>}
  </section>;
}
