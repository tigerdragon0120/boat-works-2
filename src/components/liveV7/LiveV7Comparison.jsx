import React, { useEffect, useState } from 'react';
import { archivedV7, liveV7 } from '@/liveV7/runtime';
import { summarizeUnified } from '@/liveV7/unifiedSummary';
import V7ServerVerification from '@/components/liveV7/V7ServerVerification';

const pct = value => value == null ? '—' : `${(value * 100).toFixed(1)}%`;
const yen = value => value == null ? '—' : `${value.toLocaleString('ja-JP')}円`;

export default function LiveV7Comparison() {
  const [, refresh] = useState(0);
  const [stage, setStage] = useState('FINAL');
  const [mode,setMode] = useState('hit');
  const [ticketCount, setTicketCount] = useState(8);
  useEffect(() => {
    const off = liveV7.subscribe(() => refresh(n => n + 1));
    void liveV7.restore();
    return off;
  }, []);

  async function exportHistory(controller, name) {
    await controller.restore();
    const url = URL.createObjectURL(new Blob([JSON.stringify(controller.export(), null, 2)], { type: 'application/json' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = name;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return <section data-testid="live-v7-comparison" className="my-4 rounded-xl border bg-white p-3 space-y-3 min-w-0">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h2 className="font-bold">V7試験のローカル参考記録</h2>
      <button type="button" className="text-sm underline min-h-11" onClick={() => exportHistory(liveV7, 'boat-v7-unified.json')}>統合V7履歴を書き出す</button>
      <button type="button" className="text-sm underline min-h-11" onClick={() => exportHistory(archivedV7, 'boat-v7-legacy.json')}>同じタブの従来V7履歴を書き出す</button>
    </div>
    <p className="text-sm text-slate-600">締切前の初回予想を、通常戦と女子戦に分けて確定結果と照合します。ブラウザー保存による参考集計です。正式成績比較は未対応です。</p>
    <div className="flex flex-wrap gap-3 items-center text-sm">
      <label>段階 <select className="min-h-11 border rounded px-2" aria-label="V7比較段階" value={stage} onChange={event => setStage(event.target.value)}><option>PRE</option><option>FINAL</option></select></label>
      <label>方式 <select className="min-h-11" value={mode} onChange={e=>setMode(e.target.value)}><option value="hit">的中率優先</option><option value="value">回収率優先</option></select></label>
      <label>点数 <select className="min-h-11 border rounded px-2" aria-label="V7比較点数" value={ticketCount} onChange={event => setTicketCount(Number(event.target.value))}>{[4, 6, 8, 12].map(count => <option key={count} value={count}>{count}点</option>)}</select></label>
    </div>
    {liveV7.resultMonitorError && <p role="alert">{liveV7.resultMonitorError}</p>}
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
      {[{ label: '通常戦', item: summarizeUnified(liveV7, stage, 'OPEN', ticketCount, mode) }, { label: '女子戦', item: summarizeUnified(liveV7, stage, 'WOMENS', ticketCount, mode) }].map(({ label, item }) => (
        <article key={label} className="rounded-lg bg-slate-50 p-3 text-sm space-y-1 min-w-0">
          <h3 className="font-semibold">{label} · {item.n}件</h3>
          <p>対象 {item.eligible}件 · 研究用BUY {item.judgments.BUY} / WATCH {item.judgments.WATCH} / SKIP {item.judgments.SKIP}</p>
          <p>平均予測確率−実測的中率 {item.gap == null ? "—" : (item.gap*100).toFixed(2)+"pt"}</p>
          <p>各着順 {item.rankAccuracy.map((value, i) => `${i + 1}着 ${pct(value)}`).join(' / ')}</p>
          <p>三連単 {item.hits}件 · 的中率 {pct(item.hitRate)}</p>
          <p>仮想投資 {yen(item.stake)} / 払戻 {item.stake && item.payout == null ? '不明' : yen(item.payout)}</p>
          <p>仮想回収率 {pct(item.recovery)}</p>
          {Object.entries(item.references).map(([key,r])=><p key={key}>{key==='baseline'?'旧V7再計算':'旧改善候補再計算'} {r.n}件 · 的中 {pct(r.hitRate)} / 回収 {pct(r.recovery)}</p>)}
          <p>買い目セットのBrierスコア {item.brier == null ? "—" : item.brier.toFixed(4)}</p>
        </article>
      ))}
    </div>
    <p className="text-xs text-slate-600">各組番100円の仮想計算です。確定払戻が欠ける的中は回収率を未算出とし、結果競合は除外します。実投票実績ではありません。</p>
    <V7ServerVerification />
  </section>;
}