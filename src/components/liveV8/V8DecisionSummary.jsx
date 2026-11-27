import React from 'react';
import {ArrowDown, CheckCircle2} from 'lucide-react';
import {formatTime} from '@/components/liveV8/v8Client';
import {finalSelectionView} from '@/components/liveV8/v8FinalTicketsView';

export default function V8DecisionSummary({forecast, savedBuy, view, decision, race, blocked, onShowTickets}) {
  const activeBuy=decision.key==='BUY', saved=finalSelectionView(savedBuy);
  const hasBuyHistory=!blocked && saved.available && saved.plan.status==='BUY' && savedBuy?.decision?.status==='BUY'
    && savedBuy?.stage==='FINAL' && savedBuy?.record_mode!=='REPLAY' && savedBuy?.race_id===race?.id && savedBuy?.race_key===race?.race_key;
  const label=activeBuy?'BUY判定':({WATCH:'保留（WATCH）',SKIP:'見送り（SKIP）'})[decision.key] || decision.label;
  return <section aria-label="BUY判定の概要" className={`mb-4 rounded-xl border-2 p-4 ${activeBuy?'border-decision-buy bg-decision-buy/10':'border-border bg-card'}`}>
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div role="status" aria-live="polite" aria-atomic="true" className="min-w-0 flex-1">
        <p className="text-xs font-bold text-muted-foreground">現在の判定</p>
        <h4 className={`mt-1 flex flex-wrap items-center gap-2 text-xl font-black sm:text-2xl ${activeBuy?'text-decision-buy':'text-card-foreground'}`}>
          {activeBuy&&<CheckCircle2 aria-hidden="true" className="h-6 w-6 shrink-0"/>}{label}{view.available&&<span className="text-base">· {view.count}点</span>}
        </h4>
        <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
          <span>締切 {formatTime(race?.deadline || forecast?.deadline)}</span>
          {forecast&&<span>予想保存 {formatTime(forecast.generated_at,true)}</span>}
          {activeBuy&&<span className="font-bold text-decision-buy">判定有効 {formatTime(view.plan.valid_until)}まで</span>}
        </div>
        <p className="mt-2 text-xs leading-5 text-muted-foreground">{activeBuy?'展示後の条件を満たした最終買い目を保存しました。':decision.detail || (!forecast?'展示情報と最終判定が保存されると、ここにBUYまたは保留を表示します。':'保存した最終買い目と判断理由は、下の詳細で確認できます。')}</p>
        {!activeBuy&&hasBuyHistory&&<p className="mt-2 rounded-lg bg-muted px-3 py-2 text-xs font-semibold leading-5 text-card-foreground">初回のBUY保存：{formatTime(savedBuy.generated_at,true)} · {saved.count}点<span className="block font-normal text-muted-foreground">保存時の判定です。現在の判定は上に表示しています。</span></p>}
      </div>
      {view.available&&<button type="button" onClick={onShowTickets} className={`inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-lg px-4 py-2.5 text-sm font-bold transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 sm:w-auto ${activeBuy?'bg-decision-buy text-decision-buy-foreground hover:opacity-90':'border border-border bg-background text-foreground hover:bg-muted'}`}>
        {activeBuy?'最終買い目を見る':'最新の最終買い目へ'}<ArrowDown aria-hidden="true" className="h-4 w-4"/>
      </button>}
    </div>
  </section>;
}
