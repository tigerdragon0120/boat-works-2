import React from 'react';
import { cn } from '@/lib/utils';
import { Users, MapPin, Gauge, Database, CheckCircle, AlertCircle, Loader2, Calendar, TrendingUp } from 'lucide-react';

function fmtDate(v) {
  if (!v) return '—';
  const s = String(v).slice(0, 10);
  return s.replace(/-/g, '/');
}
function fmtDateTime(v) {
  if (!v) return '—';
  try { return new Date(v).toLocaleString('ja-JP', { month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit' }); } catch { return String(v); }
}

export default function DatabaseStatusPanel({ status, loading }) {
  const isRunning = status?.status === 'running';
  const items = [
    { label: '選手DB', value: status?.racers ?? '—', icon: Users, suffix: '人' },
    { label: '選手×場DB', value: status?.racer_venues ?? '—', icon: Users, suffix: '件' },
    { label: 'モーターDB', value: status?.motors ?? '—', icon: Gauge, suffix: '件' },
    { label: 'レース場DB', value: status?.venues ?? '—', icon: MapPin, suffix: '場' },
    { label: 'レースDB', value: status?.races ?? '—', icon: Database, suffix: '件' },
    { label: '結果取得済', value: status?.result_count ?? '—', icon: CheckCircle, suffix: '件' },
    { label: '結果取得率', value: status?.result_coverage_rate != null ? `${Number(status.result_coverage_rate).toFixed(1)}%` : '—', icon: TrendingUp },
    { label: '最古データ', value: fmtDate(status?.oldest_race_date), icon: Calendar },
    { label: '最新データ', value: fmtDate(status?.newest_race_date), icon: Calendar },
  ];

  const statusBadge = isRunning
    ? { text: '更新中', cls: 'bg-blue-500/20 text-blue-300 border-blue-400/40', Icon: Loader2 }
    : status?.status === 'success'
    ? { text: '正常', cls: 'bg-emerald-500/20 text-emerald-300 border-emerald-400/40', Icon: CheckCircle }
    : status?.status === 'failed'
    ? { text: 'エラー', cls: 'bg-rose-500/20 text-rose-300 border-rose-400/40', Icon: AlertCircle }
    : { text: '未構築', cls: 'bg-slate-600/40 text-slate-400 border-slate-500/40', Icon: AlertCircle };

  return (
    <div className="bg-[#1e232d] border border-[#3a404c] rounded-xl p-3 sm:p-4">
      <div className="flex items-center justify-between mb-3">
        <div className="text-xs font-bold text-slate-400">DBステータス</div>
        <div className="flex items-center gap-2">
          {status?.message && <span className="hidden sm:inline text-[10px] text-slate-500 truncate max-w-[280px]">{status.message}</span>}
          <span className={cn('inline-flex items-center gap-1 px-2 h-6 rounded-full text-[10px] font-bold border', statusBadge.cls)}>
            <statusBadge.Icon className={cn('w-3 h-3', isRunning && 'animate-spin')} />
            {statusBadge.text}
          </span>
        </div>
      </div>
      {/* モバイル: 2列カード / タブレット以上: 横並び */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-9 gap-2">
        {items.map((it) => (
          <div key={it.label} className="bg-[#161a22] rounded-lg p-2 sm:p-2.5 border border-[#2c3546]">
            <div className="flex items-center gap-1 text-[9px] sm:text-[10px] text-slate-500 mb-1">
              <it.icon className="w-3 h-3 shrink-0" />
              <span className="truncate">{it.label}</span>
            </div>
            <div className="font-black text-white text-sm sm:text-base leading-tight">
              {it.value}
              {it.suffix && <span className="text-[9px] sm:text-[10px] font-bold text-slate-500 ml-0.5">{typeof it.value === 'number' ? it.suffix : ''}</span>}
            </div>
          </div>
        ))}
      </div>
      <div className="mt-2.5 flex items-center justify-between text-[10px] text-slate-500">
        <span>最終DB更新: {loading ? '…' : fmtDateTime(status?.updated_at)}</span>
        {status?.message && <span className="sm:hidden truncate ml-2">{status.message}</span>}
      </div>
    </div>
  );
}