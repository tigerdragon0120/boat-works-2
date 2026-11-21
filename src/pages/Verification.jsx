import React from 'react';
import V7ServerVerification from '@/components/liveV7/V7ServerVerification';
import V7FactorCandidates from '@/components/liveV7/V7FactorCandidates';

// 検証ページはV7専用。旧V1〜V6.5の履歴・エンジンは削除せず、
// この画面での表示と旧集計の読込だけを外す。
export default function Verification() {
  return (
    <main className="mx-auto w-full max-w-7xl space-y-5 pb-12">
      <header className="rounded-2xl border border-slate-200 bg-white p-4 sm:p-6">
        <p className="text-xs font-bold tracking-widest text-sky-700">BOAT WORKS 2</p>
        <h1 className="mt-1 text-xl font-black text-slate-900 sm:text-2xl">V7 検証ダッシュボード</h1>
        <p className="mt-2 text-sm leading-6 text-slate-600">
          これからはV7の結果だけを詳しく確認できます。
          全端末共通のサーバー保存記録を使い、事前・直前予想、一般戦・女子戦、
          BUY判定、4・6・8・12点の的中率・回収率を表示します。
        </p>
      </header>
      <V7FactorCandidates />
      <V7ServerVerification />
    </main>
  );
}
