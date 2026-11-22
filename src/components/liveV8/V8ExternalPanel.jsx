import React, {useMemo, useState} from 'react';
import {base44} from '@/api/base44Client';
import {BUTTON_CLASS, FIELD_CLASS, STAGES, formatTime, latestRows, parseTickets, safeURL} from './v8Client';

const INITIAL={source_name:'',forecaster_name:'',source_type:'TRACK_TIPSTER',stage:'FINAL',published_at:'',source_url:'',tickets_text:'',stake_per_ticket:100,information_fee:0,reason_tags_text:'',permission_confirmed:false};
const TYPES={TRACK_TIPSTER:'場内予想屋',OFFICIAL_REPORTER:'公式記者',OTHER:'その他'};
const blankValue=value=>typeof value==='string'?value:'';

export default function V8ExternalPanel({race,rows=[],admin=false,onSaved=()=>{}}) {
  const [form,setForm]=useState(INITIAL),[open,setOpen]=useState(false),[json,setJson]=useState('');
  const [error,setError]=useState(null),[saved,setSaved]=useState(null),[busy,setBusy]=useState(false);
  const records=useMemo(()=>latestRows(rows,row=>`${row.source_name}:${row.forecaster_name}:${row.stage}`).sort((a,b)=>String(b.recorded_at).localeCompare(String(a.recorded_at))),[rows]);
  const set=(name,value)=>setForm(old=>({...old,[name]:value}));
  const loadJSON=text=>{
    try {
      const row=JSON.parse(text);
      if (!row || Array.isArray(row) || typeof row!=='object') throw new Error('予想1件分のJSONオブジェクトを読み込んでください');
      let publication='';
      if (row.published_at && Number.isFinite(Date.parse(row.published_at))) publication=new Date(Date.parse(row.published_at)+9*3600000).toISOString().slice(0,16);
      setForm({source_name:blankValue(row.source_name),forecaster_name:blankValue(row.forecaster_name),source_type:TYPES[row.source_type]?row.source_type:'OTHER',stage:STAGES[row.stage]?row.stage:'FINAL',published_at:publication,source_url:blankValue(row.source_url),tickets_text:Array.isArray(row.tickets)?row.tickets.join(' '):'',stake_per_ticket:Number(row.stake_per_ticket)||100,information_fee:Number(row.information_fee)||0,reason_tags_text:Array.isArray(row.reason_tags)?row.reason_tags.join('、'):'',permission_confirmed:false});
      setError(null); setOpen(true); setSaved('JSONを読み込みました。発表時刻と買い目を確認して保存してください。');
    } catch (problem) {setError(problem.message || 'JSONを読み込めませんでした');}
  };
  const submit=async event=>{
    event.preventDefault(); setBusy(true); setError(null); setSaved(null);
    try {
      if (!race?.id) throw new Error('対象レースが確認できません');
      const tickets=parseTickets(form.tickets_text), published=new Date(`${form.published_at}:00+09:00`);
      if (!Number.isFinite(published.getTime())) throw new Error('発表時刻を日本時間で入力してください');
      if (!safeURL(form.source_url)) throw new Error('出典のURLを確認してください');
      const amount=Number(form.stake_per_ticket);
      if (!Number.isInteger(amount)||amount<100||amount%100!==0) throw new Error('1点の検証額は100円単位で入力してください');
      const informationFee=Number(form.information_fee);
      if (!Number.isFinite(informationFee)||informationFee<0) throw new Error('情報料は0円以上で入力してください');
      if (!form.permission_confirmed) throw new Error('情報を記録できることを確認してください');
      const response=await base44.functions.invoke('v8RecordExternalPrediction',{race_id:race.id,source_name:form.source_name.trim(),forecaster_name:form.forecaster_name.trim(),source_type:form.source_type,stage:form.stage,published_at:published.toISOString(),source_url:form.source_url.trim(),tickets,stake_per_ticket:amount,information_fee:informationFee,reason_tags:form.reason_tags_text.split(/[,、\n]/).map(text=>text.trim()).filter(Boolean),permission_confirmed:true});
      if (response?.data?.ok!==true) throw new Error(response?.data?.message || response?.data?.error || '保存できませんでした');
      setSaved(response.data.records?.[0]?.verification_eligible===false?'履歴資料として保存しました。締切前の成績集計とは分けて表示します。':'予想を記録しました。保存した内容は上書きせず、結果との照合に使います。');
      setForm(INITIAL); setOpen(false); setJson(''); await onSaved();
    } catch(problem) {setError(problem?.response?.data?.message || problem?.message || '保存できませんでした');}
    finally {setBusy(false);}
  };
  return <div className="space-y-4">
    <div className="grid gap-3 sm:grid-cols-2">
      <a href="https://lp.so-da.jp/" target="_blank" rel="noopener noreferrer" className="rounded-xl border border-slate-200 bg-white p-4 transition hover:border-sky-300 hover:bg-sky-50">
        <span className="text-[11px] font-semibold tracking-wider text-sky-700">場内予想屋</span>
        <div className="mt-1 flex items-center justify-between"><h4 className="font-bold text-slate-900">SODA</h4><span aria-hidden="true">↗</span></div>
        <p className="mt-1 text-xs leading-5 text-slate-600">公認予想屋の口上・販売予想を提供元で確認</p>
        <p className="mt-2 text-[11px] text-slate-500">提供元へのリンク・自動取込は未接続</p>
      </a>
      <a href="https://boatrace-tsu.com/modules/other/?page=index_faq" target="_blank" rel="noopener noreferrer" className="rounded-xl border border-slate-200 bg-white p-4 transition hover:border-sky-300 hover:bg-sky-50">
        <span className="text-[11px] font-semibold tracking-wider text-sky-700">公式記者</span>
        <div className="mt-1 flex items-center justify-between"><h4 className="font-bold text-slate-900">ボートレース津</h4><span aria-hidden="true">↗</span></div>
        <p className="mt-1 text-xs leading-5 text-slate-600">前日・展示後の記者予想の公開案内</p>
        <p className="mt-2 text-[11px] text-slate-500">提供元へのリンク・自動取込は未接続</p>
      </a>
    </div>
    {!admin?<p className="rounded-xl bg-slate-50 p-4 text-sm leading-6 text-slate-600">現地予想屋の比較記録は、管理者の研究用として扱います。提供条件を確認できた情報源から接続します。</p>:<>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div><h4 className="font-bold text-slate-900">現地の見解を、独立して記録</h4><p className="mt-1 text-xs text-slate-500">管理者の研究用。買い目の一致だけでBUY判定を変更しません。</p></div>
        <button type="button" onClick={()=>setOpen(!open)} className={BUTTON_CLASS}>{open?'入力を閉じる':'＋ 予想を記録'}</button>
      </div>
      {error&&<p role="alert" className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800">{error}</p>}
      {saved&&<p role="status" className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-900">{saved}</p>}
      {open&&<form onSubmit={submit} className="space-y-4 rounded-xl border border-sky-200 bg-sky-50/40 p-4 sm:p-5">
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="space-y-1 text-xs font-semibold text-slate-600"><span>提供元</span><input required maxLength={80} className={FIELD_CLASS} value={form.source_name} onChange={event=>set('source_name',event.target.value)} placeholder="例：SODA、場公式サイト"/></label>
          <label className="space-y-1 text-xs font-semibold text-slate-600"><span>予想屋・記者名</span><input required maxLength={80} className={FIELD_CLASS} value={form.forecaster_name} onChange={event=>set('forecaster_name',event.target.value)} placeholder="屋号・名前"/></label>
          <label className="space-y-1 text-xs font-semibold text-slate-600"><span>情報の種類</span><select className={FIELD_CLASS} value={form.source_type} onChange={event=>set('source_type',event.target.value)}>{Object.entries(TYPES).map(([key,label])=><option key={key} value={key}>{label}</option>)}</select></label>
          <label className="space-y-1 text-xs font-semibold text-slate-600"><span>予想した段階</span><select className={FIELD_CLASS} value={form.stage} onChange={event=>set('stage',event.target.value)}>{Object.entries(STAGES).map(([key,label])=><option key={key} value={key}>{label}</option>)}</select></label>
          <label className="space-y-1 text-xs font-semibold text-slate-600"><span>発表時刻（日本時間）</span><input required type="datetime-local" className={FIELD_CLASS} value={form.published_at} onChange={event=>set('published_at',event.target.value)}/></label>
          <label className="space-y-1 text-xs font-semibold text-slate-600"><span>1点の検証額</span><div className="flex items-center gap-2"><input type="number" required min="100" step="100" className={FIELD_CLASS} value={form.stake_per_ticket} onChange={event=>set('stake_per_ticket',event.target.value)}/><span>円</span></div></label>
          <label className="space-y-1 text-xs font-semibold text-slate-600"><span>この予想に計上する情報料</span><div className="flex items-center gap-2"><input type="number" required min="0" step="1" className={FIELD_CLASS} value={form.information_fee} onChange={event=>set('information_fee',event.target.value)}/><span>円</span></div></label>
        </div>
        <label className="block space-y-1 text-xs font-semibold text-slate-600"><span>出典URL</span><input required type="url" className={FIELD_CLASS} value={form.source_url} onChange={event=>set('source_url',event.target.value)} placeholder="https://"/></label>
        <label className="block space-y-1 text-xs font-semibold text-slate-600"><span>3連単の買い目</span><textarea required rows={3} className={FIELD_CLASS} value={form.tickets_text} onChange={event=>set('tickets_text',event.target.value)} placeholder="1-2-3 1-3-2 または 1-234-56"/><span className="block font-normal text-slate-500">スペース・改行・読点で区切れます。同じ艇が重なる組み合わせは除きます。</span></label>
        <label className="block space-y-1 text-xs font-semibold text-slate-600"><span>根拠のメモ（短いタグ）</span><input maxLength={400} className={FIELD_CLASS} value={form.reason_tags_text} onChange={event=>set('reason_tags_text',event.target.value)} placeholder="伸び評価、回り足、進入変化"/></label>
        <label className="flex items-start gap-2 text-xs leading-5 text-slate-600"><input required type="checkbox" className="mt-1 h-4 w-4 accent-sky-600" checked={form.permission_confirmed} onChange={event=>set('permission_confirmed',event.target.checked)}/><span>自分が利用・記録できる情報であることを確認しました。管理者の研究用として保存します。</span></label>
        <div className="flex flex-wrap items-center justify-between gap-3"><p className="max-w-lg text-[11px] leading-5 text-slate-500">サーバーの保存時刻を記録します。締切後に入力した予想は履歴資料として扱い、締切前の成績に含めません。</p><button disabled={busy} type="submit" className="rounded-lg bg-sky-700 px-5 py-2.5 text-sm font-bold text-white hover:bg-sky-800 disabled:opacity-50">{busy?'保存中…':'確認して保存'}</button></div>
        <details className="border-t border-sky-100 pt-3"><summary className="cursor-pointer text-xs font-semibold text-slate-600">JSONから入力する</summary><div className="mt-3 space-y-2"><input type="file" accept="application/json,.json" className="max-w-full text-xs" onChange={async event=>{const file=event.target.files?.[0];if(!file)return;if(file.size>200000){setError('JSONは200KB以内にしてください');return;}loadJSON(await file.text());}}/><textarea rows={4} className={FIELD_CLASS} value={json} onChange={event=>setJson(event.target.value)} placeholder={'{"source_name":"…","forecaster_name":"…","stage":"FINAL","published_at":"2026-11-22T12:30:00+09:00","source_url":"https://…","tickets":["1-2-3"]}'}/><button type="button" onClick={()=>loadJSON(json)} className={BUTTON_CLASS}>入力欄へ読み込む</button></div></details>
      </form>}
      {!records.length&&!open&&<div className="rounded-xl border border-dashed border-slate-300 px-4 py-7 text-center"><p className="text-sm font-semibold text-slate-700">このレースの外部予想は、まだ記録されていません</p><p className="mt-1 text-xs leading-5 text-slate-500">提供元・発表時刻・買い目を揃えて、事前予想と独立した比較を始められます。</p></div>}
      <div className="grid gap-3 sm:grid-cols-2">{records.map(row=>{
        const url=safeURL(row.source_url),tickets=row.tickets||[];
        return <article key={row.id} className="rounded-xl border border-slate-200 bg-white p-4">
          <div className="flex items-start justify-between gap-2"><div><p className="text-[11px] text-slate-500">{row.source_name} · {TYPES[row.source_type] || '外部予想'}</p><h5 className="mt-1 font-bold text-slate-900">{row.forecaster_name}</h5></div><span className="shrink-0 rounded-md bg-slate-100 px-2 py-1 text-[11px] font-semibold text-slate-600">{STAGES[row.stage] || '時点未確認'}</span></div>
          <div className="mt-3 flex flex-wrap gap-1.5">{tickets.map(ticket=><span key={ticket} className="rounded-md border border-slate-200 bg-slate-50 px-2 py-1 font-mono text-sm font-semibold text-slate-800">{ticket}</span>)}</div>
          <p className="mt-2 text-xs text-slate-500">{tickets.length}点 · {row.stake_per_ticket || 100}円／点</p>
          {!!row.reason_tags?.length&&<p className="mt-2 text-xs leading-5 text-slate-600">{row.reason_tags.join(' / ')}</p>}
          <dl className="mt-3 space-y-1 border-t border-slate-100 pt-3 text-[11px] text-slate-500"><div className="flex justify-between gap-2"><dt>発表</dt><dd>{formatTime(row.published_at,true)}</dd></div><div className="flex justify-between gap-2"><dt>保存</dt><dd>{formatTime(row.recorded_at || row.created_date,true)}</dd></div></dl>
          <div className="mt-3 flex flex-wrap items-center justify-between gap-2"><span className={`text-[11px] font-semibold ${row.verification_eligible?'text-sky-700':'text-amber-700'}`}>{row.verification_eligible?'締切前の手動記録':'履歴資料・事前成績の対象外'}</span>{url&&<a href={url} rel="noopener noreferrer" target="_blank" className="text-xs font-semibold text-sky-700 underline underline-offset-2">出典を開く ↗</a>}</div>
        </article>;
      })}</div>
    </>}
  </div>;
}
