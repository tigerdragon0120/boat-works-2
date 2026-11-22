import React, {useState} from 'react';
import V8Verification from '@/components/liveV8/V8Verification';
import V7ServerVerification from '@/components/liveV7/V7ServerVerification';
import V7FactorCandidates from '@/components/liveV7/V7FactorCandidates';
import V7WeatherLab from '@/components/liveV7/V7WeatherLab';
import V8PatternLab from '@/components/liveV7/V8PatternLab';
import V8TheoryLab from '@/components/liveV7/V8TheoryLab';

// V8の保存予想と初回BUYを先に検証し、既存の詳細台帳は展開時に読み込む。
export default function Verification() {
  const [showDetails,setShowDetails]=useState(false);
  return (
    <main className="mx-auto w-full max-w-7xl space-y-5 pb-12">
      <header className="rounded-2xl border border-slate-200 bg-white p-4 sm:p-6">
        <p className="text-xs font-bold tracking-widest text-sky-700">BOAT WORKS 2</p>
        <h1 className="mt-1 text-xl font-black text-slate-900 sm:text-2xl">予想とBUYの検証</h1>
        <p className="mt-2 text-sm leading-6 text-slate-600">
          締切前に保存した前日・展示前・展示後の予想と、最初に出したBUYを結果と照合します。
          外部予想は管理者専用の比較枠で確認できます。目標と実績を分けて表示します。
        </p>
      </header>
      <V8Verification />
      <details className="rounded-2xl border border-slate-200 bg-white p-4" onToggle={event=>setShowDetails(event.currentTarget.open)}>
        <summary className="cursor-pointer font-bold text-slate-700">理論別・水面・V7の詳細検証</summary>
        {showDetails && <div className="mt-4 space-y-5">
      <V8TheoryLab />
      <V8PatternLab />
      <V7WeatherLab />
      <V7FactorCandidates />
      <V7ServerVerification />
        </div>}
      </details>
    </main>
  );
}

