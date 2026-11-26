import React from 'react';
import {buildTicketOdds} from './v8TicketOdds';
import {formatTime} from './v8Client';

const TICKET_COLORS=['','bg-white text-slate-900 border-slate-400','bg-slate-900 text-white border-slate-900','bg-red-600 text-white border-red-600','bg-blue-600 text-white border-blue-600','bg-yellow-400 text-slate-900 border-yellow-400','bg-emerald-600 text-white border-emerald-600'];
export default function V8TicketList({tickets=[],displayOdds,race,now,blocked=false,rankedRows=null,oddsView=null}) {
  const odds=oddsView || buildTicketOdds({tickets,displayOdds,race,now,blocked});
  if(!tickets.length)return null;
  const unavailable=['UNAVAILABLE','INVALID'].includes(odds.status);
  const quoteLabel=odds.saved?'最終判定時の参考値':odds.historical?'締切前の参考値':odds.stale?'更新待ち・前回取得値':'取得時点の参考値';
  return <div className="space-y-3">
    <div className="rounded-xl border border-sky-200 bg-sky-50/60 px-3 py-3 sm:px-4">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
        <span className="text-xs font-bold text-sky-900">合成オッズ（{tickets.length}点）</span>
        <strong className="text-2xl font-black tabular-nums text-sky-900">{odds.composite==null?'—':odds.composite.toLocaleString('ja-JP',{minimumFractionDigits:2,maximumFractionDigits:2})}{odds.composite!=null&&<span className="ml-1 text-xs font-semibold">倍</span>}</strong>
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] leading-5">
        <span className="font-semibold text-slate-600">{unavailable?'オッズの確認待ち':`${odds.available}/${odds.total}点取得${odds.composite==null?'・全点取得後に計算':''}`}</span>
        {odds.capturedAt&&<span className={odds.stale?'font-semibold text-amber-800':'text-slate-500'}>オッズ取得 {formatTime(odds.capturedAt,true)} · {quoteLabel}</span>}
      </div>
      <p className="mt-2 text-[10px] leading-5 text-slate-500">払戻額をそろえる配分での参考倍率です。検証成績は各買い目100円で計算します。</p>
    </div>
    <ol role="list" aria-label={rankedRows?'推定順位順の最終買い目と取得オッズ':'三連単の買い目と取得オッズ'} className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,14rem),1fr))] gap-2 sm:gap-3">
    {tickets.map((ticket,index)=>{
      const value=String(ticket), boats=value.split('-');
      const valid=/^[1-6]-[1-6]-[1-6]$/.test(value)&&new Set(boats).size===3;
      const ranked=Array.isArray(rankedRows)?rankedRows.find(row=>row.ticket===value):null;
      return <li key={`${value}-${index}`} data-ticket={value} data-rank={ranked?.rank} className="min-w-0 rounded-xl border border-slate-200 bg-white px-3 py-3 text-slate-900 shadow-sm">
        {ranked&&<p className="mb-3 flex items-center justify-between gap-2 text-xs font-bold text-sky-800"><span>推定 {ranked.rank}位</span>{ranked.label&&<span className="text-[10px] font-medium text-slate-500">{ranked.label}</span>}</p>}
        <span className="sr-only">{valid?`${ranked?`推定順位${ranked.rank}位`:`買い目${index+1}`}：${boats.map((boat,position)=>`${position+1}着${boat}号艇`).join('、')}`:`買い目${index+1}：${value}`}</span>
        <div aria-hidden="true" className="flex items-center gap-3">
          {!ranked&&<span className="w-5 shrink-0 pt-5 text-center text-xs font-bold tabular-nums text-slate-500">{String(index+1).padStart(2,'0')}</span>}
          {valid?<div className="grid min-w-0 flex-1 grid-cols-[1fr_auto_1fr_auto_1fr] items-end gap-1">
            {boats.map((boat,position)=><React.Fragment key={position}>
              {position>0&&<span className="pb-2.5 text-sm font-bold text-slate-400">−</span>}
              <div className="flex min-w-0 flex-col items-center gap-1.5">
                <span className="text-[11px] font-semibold text-slate-500">{position+1}着</span>
                <span className={`inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-md border text-xl font-black ${TICKET_COLORS[Number(boat)]}`}>{boat}</span>
              </div>
            </React.Fragment>)}
          </div>:<strong className="min-w-0 break-all text-xl">{value}</strong>}
        </div>
        {ranked?.reason&&<p className="mt-3 text-[11px] leading-5 text-slate-600">{ranked.reason}</p>}
        <div className="mt-3 flex items-center justify-between gap-2 border-t border-slate-100 pt-2 text-xs">
          <span className="text-slate-500">オッズ</span>
          <strong className="tabular-nums text-slate-800">{odds.quotes[value]==null?<span className="font-medium text-slate-400">{unavailable?'確認待ち':'未取得'}</span>:<>{odds.quotes[value].toLocaleString('ja-JP',{minimumFractionDigits:1,maximumFractionDigits:1})}<span className="ml-1 text-[10px] font-medium text-slate-500">倍</span></>}</strong>
        </div>
      </li>;
    })}
    </ol>
  </div>;
}
