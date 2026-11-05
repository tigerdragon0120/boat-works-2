import React,{useEffect,useState} from 'react';
import {liveV7} from '@/liveV7/runtime';
export default function LiveDataStatus({race}){
 const [,refresh]=useState(0);useEffect(()=>liveV7.subscribe(()=>refresh(n=>n+1)),[]);
 const state=liveV7.get(race.id),quality=state.quality;
 return <section data-testid="live-data-status" className="my-3 min-w-0 rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs space-y-2">
  <p className="font-bold">取得状況 · 元データの最新性は未保証</p><p>保存データ読込：{state.lastRead||'未確認'}。{state.error?'通信失敗・表示が残っている場合は前回取得分です。':'読込時刻と元サイトの取得時刻は別です。'}</p>
  {state.error&&<p role="alert" className="text-red-700">{state.error}</p>}
  {quality?.logError&&<p>{quality.logError}</p>}
  <details><summary className="cursor-pointer">取得元・時刻・欠損を確認</summary><p className="my-2">{quality?.note||'取得元・更新時刻を確認中です。'}</p><div className="overflow-x-auto"><table className="min-w-[680px] w-full"><thead><tr><th>項目</th><th>保存先・取得元</th><th>入力充足</th><th>保存行更新（最新・不明件数）</th><th>取得ログ</th></tr></thead><tbody>{quality?.rows.map(r=><tr key={r.key} className="border-t align-top"><th className="p-1 text-left">{r.label}</th><td className="p-1">{r.source}<br/>{r.note}</td><td className="p-1">{r.count==null?'未取得':`${r.count}/${r.total}`}{r.priced!=null?`・${r.priced}通り`:''}</td><td className="p-1">{r.capturedAt||r.newest||'時刻不明'}<br/>{r.unknown!=null?`更新時刻不明 ${r.unknown}件`:''}</td><td className={'p-1 '+(r.failed||r.stale||r.future?'text-red-700 font-bold':'')}>{r.future?'未来時刻・V7不採用':r.stale?'オッズ10分超・V7不採用':r.lastStatus==='UNKNOWN'?'ログ未確認':r.lastStatus}<br/>{r.lastAttempt||'取得時刻未確認'}</td></tr>)}</tbody></table></div></details>
 </section>;
}