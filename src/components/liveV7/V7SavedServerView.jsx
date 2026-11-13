import React,{useEffect,useState} from 'react';
import {base44} from '@/api/base44Client';
import {findBackfillEvidence,findResultEvidence,evidenceTimeLabel} from '@/lib/resultEvidence';

// DBのcreated_dateはオフセットの無いUTC壁時計時刻なので、UTCとして解釈する
const dbMs=v=>{const raw=String(v??'').trim().replace(/(\.\d{3})\d+/,'$1');if(!raw)return NaN;return Date.parse(/(Z|[+-]\d{2}:?\d{2})$/.test(raw)?raw:`${raw}Z`);};
const pct=v=>Number.isFinite(Number(v))?(Number(v)*100).toFixed(1)+'%':'—';
const yen=v=>Number.isFinite(Number(v))?Number(v).toLocaleString('ja-JP')+'円':'—';
const PLAN_KEYS=['hit_4','hit_6','hit_8','hit_12'];
const PLAN_LABEL={hit_4:'4点',hit_6:'6点',hit_8:'8点',hit_12:'12点'};
const JUDGMENT_STYLE={BUY:'bg-emerald-100 text-emerald-900',WATCH:'bg-amber-100 text-amber-900',SKIP:'bg-slate-200 text-slate-700'};
const COMBO_RE=/^[1-6]-[1-6]-[1-6]$/;
const OFFICIAL_SOURCES=['BOATCAST','LOCAL','TXT'];
// 照合に使える結果か: 公式取得元 / 確定状態 / 三連単として正しい形式(1〜6の異なる3艇)
const isOfficialResult=r=>!!r
 &&OFFICIAL_SOURCES.includes(String(r.source||''))
 &&(r.is_finished===true||r.result_status==='RESULT_FINAL')
 &&COMBO_RE.test(String(r.result_trifecta||''))
 &&new Set(String(r.result_trifecta).split('-')).size===3;

function StageBlock({row,combination,payout,judged}){
 const plan=key=>row.plans?.[key];
 const primary=['hit_8','hit_6','hit_4','hit_12'].map(plan).find(p=>p?.judgment)?.judgment||null;
 return <div className="rounded-lg border p-3 space-y-2">
  <div className="flex flex-wrap items-center justify-between gap-2">
   <strong>{row.stage}・{row.source==='SERVER'?'自動生成':'端末同期'}</strong>
   <span className={'rounded-md px-2 py-1 text-xs font-bold '+(JUDGMENT_STYLE[primary]||'bg-amber-100 text-amber-900')}>BUY判定 {primary||'判定保留'}</span>
  </div>
  <p className="font-bold">本命三連単 {row.top_combination||'—'} ／ 確率 {pct(row.top_probability)}</p>
  <div className="grid gap-2 sm:grid-cols-2">
   {PLAN_KEYS.map(key=>{const p=plan(key);if(!p?.tickets?.length)return null;
    const hit=judged?p.tickets.includes(combination):null;
    return <div key={key} className="rounded-md border border-slate-200 p-2 text-sm">
     <div className="flex items-center justify-between gap-2">
      <span className="font-bold">{PLAN_LABEL[key]}（{p.judgment||'判定なし'}）</span>
      <span className="text-xs text-slate-600">合計確率 {pct(p.probability)}</span>
     </div>
     <p className="mt-1 break-words text-xs text-slate-700">{p.tickets.join(' / ')}</p>
     {hit!=null&&<p className={'mt-1 text-xs font-bold '+(hit?'text-emerald-700':'text-slate-500')}>{hit?`的中${payout?'・'+yen(payout):''}`:'不的中'}</p>}
    </div>;})}
  </div>
  <p className="text-xs text-slate-600">DB保存時刻：{row.created_date||'不明'}・試験予想／購入推奨ではありません</p>
 </div>;
}

export default function V7SavedServerView({race}) {
 const [rows,setRows]=useState([]),[resultRows,setResultRows]=useState([]),[evidenceRows,setEvidenceRows]=useState([]),[loading,setLoading]=useState(true),[error,setError]=useState(false);
 useEffect(()=>{let active=true;setRows([]);setResultRows([]);setEvidenceRows([]);setLoading(true);setError(false);
  Promise.all([
   base44.entities.PredictionV7.filter({race_id:race.id},'-created_date',30),
   base44.entities.RaceResult.filter({race_id:race.id},'-created_date',5).catch(()=>[]),
   base44.entities.ResultProvenance.filter({race_id:race.id},'-recorded_at',20).catch(()=>[]),
  ]).then(([saved,results,evidence])=>{if(!active)return;
   setRows(Array.isArray(saved)?saved:[]);
   setResultRows(Array.isArray(results)?results:[]);
   setEvidenceRows(Array.isArray(evidence)?evidence:[]);
  }).catch(()=>{if(active)setError(true)}).finally(()=>{if(active)setLoading(false)});
  return()=>{active=false};
 },[race.id]);

 const deadline=dbMs(race.deadline);
 const valid=rows.filter(r=>{const t=dbMs(r.created_date);return Number.isFinite(deadline)&&Number.isFinite(t)&&t<deadline});
 // 公式取得元・確定状態・三連単の形式をすべて確認できた結果だけを照合に使う
 const result=resultRows.find(isOfficialResult)||null;
 const combination=result?String(result.result_trifecta):null;
 // 有効な払戻(100円あたり1円以上)を確認できたものだけを判定材料にする
 const payoutValue=Number(result?.payout??result?.payouts?.trifecta?.payout);
 const payout=Number.isFinite(payoutValue)&&payoutValue>0?payoutValue:null;
 // 日次照合と同じ条件（実取得の証跡・結果ID必須）で、候補すべてから有効な証跡を探す
 const evidence=result?findResultEvidence(evidenceRows,{combination:result.result_trifecta,source:result.source,resultId:result.id}):null;
 const matched=evidence||(result?findBackfillEvidence(evidenceRows,{combination:result.result_trifecta,source:result.source}):null);
 // 判定に使うのは「画面に表示している保存予想」(重複なく1件だけの組)のみ。
 // 予想が無い・重複保留の場合は判定せず保留とする
 const shown=['FINAL','PRE'].map(stage=>[stage,valid.filter(r=>r.stage===stage)]).filter(([,list])=>list.length===1);
 const hitStages=shown.filter(([,list])=>PLAN_KEYS.some(key=>Array.isArray(list[0].plans?.[key]?.tickets)&&list[0].plans[key].tickets.includes(combination))).map(([stage])=>stage);
 // 公式ソース(確定結果)と有効な払戻の両方を確認できた場合に限り的中・不的中を判定する
 const judged=!!combination&&payout!=null&&!!evidence;
 const verdict=!combination?null:!judged||!shown.length?'held':(hitStages.length?'hit':'miss');

 return <div className="rounded-xl border-2 border-indigo-200 bg-white p-4 space-y-3">
  <div className="flex flex-wrap items-center justify-between gap-2">
   <h3 className="font-black text-lg">統合V7・締切前の保存予想と結果</h3>
   <span className="rounded-md bg-slate-100 px-2 py-1 text-xs font-bold text-slate-700">読取専用</span>
  </div>
  <p className="text-xs text-slate-600">締切前にDBへ保存されたV7予想（FINAL優先）のBUY判定と買い目を表示します。締切後に新たな予想は作成しません。</p>

  {combination?<div className="rounded-lg border-2 border-rose-400 bg-rose-50 p-3 space-y-1">
   <p className="font-bold text-rose-900">公式確定結果 三連単 {combination} ／ 払戻 {payout?yen(payout):'未取得'}</p>
   <p className="text-sm text-rose-900">{verdict==='hit'?`表示中の保存予想で的中：${hitStages.join('・')}`
    :verdict==='miss'?'表示中の保存予想は不的中（公式確定結果と照合）'
    :!evidence?(matched?'実取得の証跡が無いため判定は保留（事後補完のみ）':'公式取得経路の記録を確認できないため判定は保留')
    :!judged?'公式払戻を確認できていないため判定は保留'
    :'表示できる保存予想が無いため判定は保留'}</p>
   {evidence&&<p className="text-xs text-rose-900">取得経路 {evidence.endpoint||evidence.source} ／ {evidenceTimeLabel(evidence.source)} {evidence.fetched_at||'不明'} ／ 結果ID {evidence.result_id||'不明'}</p>}
  </div>:<p className="rounded-lg bg-slate-50 p-3 text-sm text-slate-600">{resultRows.length?'公式取得元・確定状態・三連単の形式を確認できないため照合は保留です。':'確定結果はまだ取得できていません。結果が入り次第、この画面に反映されます。'}</p>}

  {loading?<p className="text-sm text-slate-600">取得中…</p>
   :error?<p role="alert" className="text-sm text-red-700">DB保存履歴を取得できませんでした</p>
   :['FINAL','PRE'].map(stage=>{
    const matches=valid.filter(r=>r.stage===stage);
    if(matches.length!==1)return <p key={stage} className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900">{stage}：{matches.length?'重複のため表示保留':'締切前の保存済み記録なし'}</p>;
    return <StageBlock key={stage} row={matches[0]} combination={combination} payout={payout} judged={judged}/>;
   })}
 </div>;
}