import React, {useState} from 'react';
import V8Verification from '@/components/liveV8/V8Verification';
import V8PatternLab from '@/components/liveV7/V8PatternLab';
import V8TheoryLab from '@/components/liveV7/V8TheoryLab';

// V8自身の保存買い目を検証し、V8の詳細台帳は展開時に読み込む。
export default function Verification() {
  const [showDetails,setShowDetails]=useState(false);
  return (
    <main className="mx-auto w-full max-w-7xl space-y-5 pb-12">
      <header className="rounded-2xl border border-slate-200 bg-white p-4 sm:p-6">
        <p className="text-xs font-bold tracking-widest text-sky-700">BOAT WORKS 2</p>
        <h1 className="mt-1 text-xl font-black text-slate-900 sm:text-2xl">V8の買い目と結果の検証</h1>
        <p className="mt-2 text-sm leading-6 text-slate-600">
          前日・当日の展示前・展示後に保存したV8の買い目を、確定結果と照合します。
          締切前に保存した予想と、締切後に補完した予想の成績を分けて表示します。
          外部予想は管理者専用の比較枠で確認できます。目標と実績を分けて表示します。
        </p>
      </header>
      <V8Verification />
      <details className="rounded-2xl border border-slate-200 bg-white p-4" onToggle={event=>setShowDetails(event.currentTarget.open)}>
        <summary className="cursor-pointer font-bold text-slate-700">V8の理論別・レース傾向の検証</summary>
        {showDetails && <div className="mt-4 space-y-5">
      <V8TheoryLab />
      <V8PatternLab />
        </div>}
      </details>
    </main>
  );
}

