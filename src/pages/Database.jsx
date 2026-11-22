import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { base44 } from '@/api/base44Client';
import PlayerPhoto from '@/components/race/PlayerPhoto';
import { Database as DbIcon, Users, Search, RefreshCw, History } from 'lucide-react';
import { cn } from '@/lib/utils';

const PAGE_SIZE=100;
const tabs=[['profiles','選手プロフィール',Users],['terms','期別成績',History]];
const SYNC_LABELS={idle:'確認待ち',checking:'公開期を確認中',importing:'取込中',ready:'更新済み',error:'更新エラー'};
const SYNC_TONES={idle:'bg-slate-100 text-slate-600',checking:'bg-sky-50 text-sky-800',importing:'bg-sky-50 text-sky-800',ready:'bg-emerald-50 text-emerald-800',error:'bg-rose-50 text-rose-800'};
const invoke=async(body)=>{const response=await base44.functions.invoke('getDatabasePage',body);return response?.data||response;};
const count=value=>value!=null&&value!==''&&Number.isFinite(Number(value))?Number(value).toLocaleString('ja-JP'):'—';
const termLabel=value=>{const match=/^(\d{4})_(FIRST|SECOND)$/.exec(String(value||''));return match?`${match[1]}年${match[2]==='FIRST'?'前期':'後期'}`:value||'確認中';};
function displayDate(value){const match=/^(\d{4})-(\d{2})-(\d{2})/.exec(String(value||''));return match?`${match[1]}/${match[2]}/${match[3]}`:'未確認';}
function displayTime(value){
 if(typeof value!=='string'||!value.trim())return '未確認';
 let text=value.trim().replace(/(\.\d{3})\d+/,'$1');
 if(!/[zZ]$|[+-]\d{2}:?\d{2}$/.test(text))text+='Z';
 const parsed=Date.parse(text);
 return Number.isFinite(parsed)?new Intl.DateTimeFormat('ja-JP',{timeZone:'Asia/Tokyo',month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'}).format(parsed):'未確認';
}
function safeSourceUrl(value){try{const url=new URL(value);return ['https:','http:'].includes(url.protocol)?url.href:null;}catch{return null;}}
function availableTerms(data){return [...new Set([...(data?.available_terms||[]).map(item=>typeof item==='string'?item:item?.term_key),data?.latest_term].filter(value=>typeof value==='string'&&/^\d{4}_(FIRST|SECOND)$/.test(value)))].sort((a,b)=>b.localeCompare(a));}

export default function Database(){
 const [tab,setTab]=useState('profiles'),[q,setQ]=useState(''),[search,setSearch]=useState('');
 const [rows,setRows]=useState([]),[total,setTotal]=useState(0),[page,setPage]=useState(1),[selectedTerm,setSelectedTerm]=useState('');
 const [summary,setSummary]=useState(null),[summaryBusy,setSummaryBusy]=useState(false),[rowsBusy,setRowsBusy]=useState(false),[rowRevision,setRowRevision]=useState(0);
 const [summaryError,setSummaryError]=useState(''),[rowsError,setRowsError]=useState(''),[syncError,setSyncError]=useState(''),[syncNotice,setSyncNotice]=useState(''),[syncBusy,setSyncBusy]=useState(false);
 const sequence=useRef(0),summarySequence=useRef(0),latestSummary=useRef(null),listTopRef=useRef(null);
 const termKeys=useMemo(()=>availableTerms(summary),[summary]);
 const automatic=summary?.latest_racer_sync||null;
 const updating=automatic?.status==='checking'||automatic?.status==='importing';
 const busy=summaryBusy||rowsBusy;
 const requestedTerm=tab==='terms'?selectedTerm:'';
 const loadSummary=useCallback(async()=>{
  const request=++summarySequence.current;setSummaryBusy(true);setSummaryError('');
  try{
   const data=await invoke({mode:'summary'});
   if(!data?.ok)throw new Error(data?.error||'集計の読込に失敗しました');
   if(request!==summarySequence.current)return;
   const previous=latestSummary.current;
   latestSummary.current=data;setSummary(data);
   setSelectedTerm(current=>current||data.latest_term||availableTerms(data)[0]||'');
   if(previous&&data.latest_racer_sync?.status==='ready'&&(previous.latest_racer_sync?.status!=='ready'||previous.latest_racer_sync?.last_success_at!==data.latest_racer_sync.last_success_at)){
    setRowRevision(value=>value+1);setSyncNotice('更新状況を確認しました。保存済みの最新データを表示しています。');
   }
  }catch(error){if(request===summarySequence.current)setSummaryError(error?.message||'集計の読込に失敗しました');}
  finally{if(request===summarySequence.current)setSummaryBusy(false);}
 },[]);
 useEffect(()=>{void loadSummary();return()=>{summarySequence.current++;};},[loadSummary]);
 useEffect(()=>{const timer=setTimeout(()=>{setSearch(q);setPage(1);},300);return()=>clearTimeout(timer);},[q]);
 useEffect(()=>{
  if(tab==='terms'&&!requestedTerm){setRows([]);setTotal(0);return;}
  const request=++sequence.current;setRowsBusy(true);setRowsError('');
  invoke({mode:tab,term_key:requestedTerm,q:search,page,page_size:PAGE_SIZE}).then(data=>{
   if(!data?.ok)throw new Error(data?.error||'DBの読込に失敗しました');
   if(request===sequence.current){setRows(data.rows||[]);setTotal(data.total||0);}
  }).catch(error=>{if(request===sequence.current){setRows([]);setTotal(0);setRowsError(error?.message||'DBの読込に失敗しました');}}).finally(()=>{if(request===sequence.current)setRowsBusy(false);});
  return()=>{sequence.current++;};
 },[tab,requestedTerm,search,page,rowRevision]);
 useEffect(()=>{
  if(!updating&&!syncBusy)return;
  const timer=setInterval(()=>{if(!document.hidden)void loadSummary();},15000);
  return()=>clearInterval(timer);
 },[updating,syncBusy,loadSummary]);
 const reload=async()=>{await loadSummary();setPage(1);setRowRevision(value=>value+1);};
 const checkAndUpdate=async()=>{
  setSyncBusy(true);setSyncError('');setSyncNotice('');
  try{
   const response=await base44.functions.invoke('syncLatestRacerStats',{force:true});
   const result=response?.data||response;
   if(result?.ok===false&&!result?.processing)throw new Error(result?.error_message||result?.error||'最新公開期の確認に失敗しました');
   setSyncNotice('更新を受け付けました。処理状況はこの画面で確認できます。');
   await loadSummary();setRowRevision(value=>value+1);
  }catch(error){setSyncError(error?.response?.data?.error_message||error?.message||'最新公開期の確認に失敗しました');}
  finally{setSyncBusy(false);}
 };
 const pages=Math.max(1,Math.ceil(total/PAGE_SIZE));
 const changePage=(nextPage,scrollToList=false)=>{
  const target=Math.min(pages,Math.max(1,nextPage));
  if(busy||target===page)return;
  setRowsBusy(true);setPage(target);
  if(scrollToList)requestAnimationFrame(()=>{listTopRef.current?.focus({preventScroll:true});listTopRef.current?.scrollIntoView({block:'start',behavior:'auto'});});
 };
 return <div className="space-y-3">
  <div className="flex flex-wrap items-center justify-between gap-3"><div><h1 className="flex items-center gap-2 text-xl font-black text-slate-900 sm:text-2xl"><DbIcon className="h-5 w-5 text-amber-500"/>BOAT WORKS DATABASE</h1><p className="mt-1 text-xs text-slate-500">選手プロフィールと公式の期別成績</p></div><button type="button" onClick={()=>void reload()} disabled={busy} className="flex h-10 items-center gap-2 rounded-lg bg-[#f9c836] px-4 text-sm font-black text-slate-950 disabled:opacity-50"><RefreshCw className={cn('h-4 w-4',busy&&'animate-spin')}/>{busy?'読込中':'再読込'}</button></div>
  <AutoUpdateCard summary={summary} sync={automatic} busy={syncBusy} onUpdate={checkAndUpdate} notice={syncNotice} error={syncError}/>
  <div className="grid grid-cols-2 gap-2"><Summary label="選手プロフィール" value={summary?summary.profile_count:null} suffix="人" sub="最新の取込済み期から集計"/><Summary label={tab==='terms'?'選択した期の成績':'最新期の成績'} value={tab==='terms'?total:summary?.latest_term_count} suffix="人" sub={termLabel(tab==='terms'?selectedTerm:summary?.latest_term)}/></div>
  {(summaryError||rowsError)&&<div role="alert" className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800">{summaryError||rowsError}</div>}
  <div className="grid grid-cols-2 gap-1 rounded-xl border border-slate-200 bg-white p-1">{tabs.map(([key,label,Icon])=><button type="button" key={key} onClick={()=>{setTab(key);setPage(1);}} className={cn('flex h-10 items-center justify-center gap-1.5 rounded-lg text-xs font-bold sm:text-sm',tab===key?'bg-[#f9c836] text-slate-950':'text-slate-600')}><Icon className="h-4 w-4"/>{label}</button>)}</div>
  {tab==='terms'&&<label className="block"><span className="mb-1 block text-[11px] font-semibold text-slate-500">保存されている期を選択</span><select value={selectedTerm} onChange={event=>{setSelectedTerm(event.target.value);setPage(1);}} className="h-11 w-full rounded-xl border border-slate-200 bg-white px-3 text-sm text-slate-900">{!termKeys.length&&<option value="">取得済みの期を確認中</option>}{termKeys.map(key=><option key={key} value={key}>{termLabel(key)}（{key}）</option>)}</select></label>}
  <div className="relative"><Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500"/><input value={q} onChange={event=>setQ(event.target.value)} placeholder="選手名・登録番号・支部・級別・元ファイル名で検索" aria-label="選手データを検索" className="h-11 w-full rounded-xl border border-slate-200 bg-white pl-10 pr-3 text-sm text-slate-900 outline-none focus:border-blue-500"/></div>
  <div ref={listTopRef} tabIndex={-1} className="scroll-mt-28 focus:outline-none"><DatabasePagination total={total} page={page} pages={pages} busy={busy} onPageChange={changePage} label="一覧上部のページ切り替え"/></div>
  {tab==='profiles'?<Profiles rows={rows} busy={rowsBusy}/>:<Terms rows={rows} busy={rowsBusy}/>}
  <div className="pb-3"><DatabasePagination total={total} page={page} pages={pages} busy={busy} onPageChange={nextPage=>changePage(nextPage,true)} label="一覧下部のページ切り替え"/></div>
 </div>;
}

function DatabasePagination({total,page,pages,busy,onPageChange,label}){
 return <nav aria-label={label} className="flex flex-wrap items-center justify-between gap-2 px-1 text-xs text-slate-500">
  <span>{count(total)}件中 {total?((page-1)*PAGE_SIZE+1):0}〜{Math.min(page*PAGE_SIZE,total)}件</span>
  <div className="flex items-center gap-2">
   <button type="button" disabled={page<=1||busy} onClick={()=>onPageChange(page-1)} className="min-h-11 min-w-20 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-semibold text-slate-700 disabled:opacity-30">前へ</button>
   <span aria-label={`全${pages}ページ中${page}ページ`} className="min-w-12 text-center tabular-nums">{page}/{pages}</span>
   <button type="button" disabled={page>=pages||busy} onClick={()=>onPageChange(page+1)} className="min-h-11 min-w-20 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-semibold text-slate-700 disabled:opacity-30">次へ</button>
  </div>
 </nav>;
}

function AutoUpdateCard({summary,sync,busy,onUpdate,notice,error}){
 const state=sync?.status||'idle',updating=state==='checking'||state==='importing';
 const latestTerm=sync?.latest_term||summary?.latest_term,sourceUrl=safeSourceUrl(sync?.source_url);
 const issue=error||(state==='error'?sync?.error_message:'');
 const imported=Number(sync?.imported_count),pending=Number(sync?.pending_count);
 const hasProgress=(state==='importing'||pending>0)&&sync?.imported_count!=null&&sync?.pending_count!=null&&Number.isFinite(imported)&&Number.isFinite(pending)&&imported>=0&&pending>=0;
 const progress=hasProgress&&imported+pending>0?Math.min(100,Math.round(imported/(imported+pending)*100)):null;
 return <section aria-label="公式選手データの自動更新" className="overflow-hidden rounded-2xl border border-sky-200 bg-white">
  <div className="flex flex-wrap items-start justify-between gap-3 border-b border-sky-100 bg-gradient-to-r from-sky-50 to-white p-4"><div className="min-w-0"><h2 className="text-base font-black text-slate-900">公式選手データの自動更新</h2><p className="mt-1 text-xs leading-5 text-slate-600">最新公開期の公式データを定期確認します。</p></div><span role="status" className={cn('inline-flex shrink-0 items-center gap-1.5 rounded-full px-3 py-1.5 text-[11px] font-bold',SYNC_TONES[state]||SYNC_TONES.idle)}>{updating&&<RefreshCw className="h-3 w-3 animate-spin"/>}{summary?(state==='idle'&&pending>0?'取込再開待ち':SYNC_LABELS[state]||'状況確認中'):'状況確認中'}</span></div>
  <div className="space-y-3 p-4">
   <div className="grid grid-cols-2 gap-2"><Summary label="最新公開期" value={termLabel(latestTerm)} sub={sync?.calculation_start&&sync?.calculation_end?`集計期間 ${displayDate(sync.calculation_start)}〜${displayDate(sync.calculation_end)}`:'集計期間を確認中'}/><Summary label="取込済みの選手" value={sync?.record_count??summary?.latest_term_count} suffix="人" sub="最新公開期の成績レコード"/></div>
   <p className="text-[11px] leading-5 text-slate-500">期別成績は上記の集計期間のデータです。日々のレース成績とは更新時点が異なります。</p>
   {hasProgress&&<div className="rounded-lg border border-sky-100 bg-sky-50 p-3"><div className="flex flex-wrap justify-between gap-1 text-xs font-semibold text-sky-900"><span>取込 {count(imported)}件 / 残り {count(pending)}件</span>{progress!=null&&<span>{progress}%</span>}</div>{progress!=null&&<progress aria-label="最新期の取込進捗" max="100" value={progress} className="mt-2 h-2 w-full accent-sky-600"/>}<p className="mt-1 text-[10px] leading-5 text-slate-500">未完了分は次回の自動確認で再開します。「確認して更新」から再確認もできます。</p></div>}
   <dl className="grid gap-2 text-xs sm:grid-cols-2"><div className="min-w-0"><dt className="text-[10px] text-slate-500">公式ファイル</dt><dd className="mt-1 break-all font-semibold text-slate-800">{sourceUrl?<a href={sourceUrl} target="_blank" rel="noopener noreferrer" className="text-sky-700 underline decoration-sky-200 underline-offset-2">{sync?.source_file||'公式公開元を見る'}</a>:sync?.source_file||'未確認'}</dd></div><div><dt className="text-[10px] text-slate-500">自動確認</dt><dd className="mt-1 font-semibold text-slate-800">{sync?.enabled===true?'有効':sync?.enabled===false?'自動更新を設定中':'状況確認中'}{sync?.next_check_at&&<span className="ml-2 font-normal text-slate-500">次回 {displayTime(sync.next_check_at)}</span>}{sync?.schedule_label&&<span className="mt-1 block text-[10px] font-normal leading-5 text-slate-500">{sync.schedule_label}</span>}</dd></div><div><dt className="text-[10px] text-slate-500">最終確認</dt><dd className="mt-1 font-semibold text-slate-800">{displayTime(sync?.last_checked_at)}</dd></div><div><dt className="text-[10px] text-slate-500">更新成功</dt><dd className="mt-1 font-semibold text-slate-800">{displayTime(sync?.last_success_at)}</dd></div></dl>
   {sync?.prediction_connected===true&&<p className="rounded-lg bg-slate-50 px-3 py-2 text-[11px] leading-5 text-slate-600"><strong className="text-slate-800">予想への反映：</strong>コース別の1〜3着成績・進入数を参照。全国成績・平均STは出走表を優先します。</p>}
   {issue&&<p role="alert" className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs leading-5 text-rose-800">{issue}</p>}
   {notice&&!issue&&<p role="status" className="text-[11px] leading-5 text-slate-600">{notice}</p>}
   <div className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-100 pt-3"><p className="text-[10px] leading-5 text-slate-500">過去の期のデータは、下の「期別成績」から確認できます。</p><button type="button" onClick={()=>void onUpdate()} disabled={busy||updating||!summary} className="inline-flex min-h-10 items-center gap-2 rounded-lg border border-sky-200 bg-sky-50 px-3 py-2 text-xs font-bold text-sky-800 disabled:opacity-50"><RefreshCw className={cn('h-4 w-4',busy&&'animate-spin')}/>{busy?'確認中…':'確認して更新'}</button></div>
  </div>
 </section>;
}
function Summary({label,value,suffix,sub}){const shown=typeof value==='string'?value:count(value);return <div className="min-w-0 rounded-xl border border-slate-200 bg-white p-3"><div className="text-[10px] text-slate-500">{label}</div><div className="mt-1 break-words text-lg font-black text-slate-900 sm:text-xl">{shown}{suffix&&<span className="ml-1 text-[10px] font-medium text-slate-500">{suffix}</span>}</div><div className="mt-1 text-[10px] leading-5 text-slate-500">{sub}</div></div>;}
function Card({children}){return <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">{children}</div>;}
function Profiles({rows,busy}){return <Card><div className="divide-y divide-slate-100">{rows.map(row=><div key={row.id||`${row.registration_number}_${row.term_key}`} className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-3 gap-y-2 p-3 sm:grid-cols-[auto_minmax(0,1fr)_auto]"><PlayerPhoto src={row.photo_url} registrationNumber={row.registration_number} alt={row.racer_name} size="sm"/><div className="min-w-0"><div className="truncate font-bold text-slate-900">{row.racer_name||'—'} <span className="text-[10px] font-normal text-slate-500">#{row.registration_number}</span></div><div className="text-[10px] leading-5 text-slate-500">{row.player_class||'—'} ・ {row.branch_name||'—'} ・ {row.age??'—'}歳 ・ {row.weight??'—'}kg</div></div><div className="col-span-2 grid grid-cols-3 gap-4 rounded-lg bg-slate-50 px-3 py-2 sm:col-span-1 sm:bg-transparent sm:p-0"><Stat label="勝率" value={num(row.win_rate,2)}/><Stat label="2連率" value={pct(row.fukusho_rate)}/><Stat label="平均ST" value={num(row.avg_st,2)}/></div></div>)}</div>{!rows.length&&<Empty busy={busy}/>}</Card>;}
function Terms({rows,busy}){return <Card><div className="divide-y divide-slate-100">{rows.map(row=><div key={row.id} className="space-y-2 p-3 sm:flex sm:items-center sm:justify-between sm:gap-3 sm:space-y-0"><div className="min-w-0"><div className="truncate font-bold text-slate-900">{row.racer_name||'—'} <span className="text-[10px] font-normal text-slate-500">#{row.registration_number}</span></div><div className="break-words text-[10px] leading-5 text-slate-500">{termLabel(row.term_key)} ・ {row.player_class||'—'} ・ {row.branch_name||'—'} ・ {row.source_file||'—'}</div></div><div className="grid shrink-0 grid-cols-4 gap-3 rounded-lg bg-slate-50 px-3 py-2 sm:bg-transparent sm:p-0"><Stat label="出走" value={row.race_count??0}/><Stat label="勝率" value={num(row.win_rate,2)}/><Stat label="2連率" value={pct(row.fukusho_rate)}/><Stat label="平均ST" value={num(row.avg_st,2)}/></div></div>)}</div>{!rows.length&&<Empty busy={busy}/>}</Card>;}
function Stat({label,value}){return <div className="text-right"><div className="text-[9px] text-slate-500">{label}</div><div className="text-sm font-black text-slate-900">{value??'—'}</div></div>;}
function Empty({busy}){return <div className="p-10 text-center text-sm text-slate-500">{busy?'データを読み込んでいます。':'表示できるデータがありません。'}</div>;}
function num(value,digits=1){return value==null||!Number.isFinite(Number(value))?'—':Number(value).toFixed(digits);}
function pct(value){return value==null||!Number.isFinite(Number(value))?'—':`${Number(value).toFixed(1)}%`;}
