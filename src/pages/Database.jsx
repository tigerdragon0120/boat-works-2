import React, { useEffect, useMemo, useState } from 'react';
import { base44 } from '@/api/base44Client';
import PlayerPhoto from '@/components/race/PlayerPhoto';
import { Database as DbIcon, Users, Search, RefreshCw, History } from 'lucide-react';
import { cn } from '@/lib/utils';

const tabs = [
  ['profiles', '選手プロフィール', Users],
  ['terms', '期別成績', History],
];

export default function Database() {
  const [tab, setTab] = useState('profiles');
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [data, setData] = useState({ profiles: [], terms: [] });
  const [meta, setMeta] = useState({ profileRaw: 0, profileUnique: 0, profileDuplicate: 0, termsShown: 0, termsHasMore: false });

  const loadAllProfiles = async () => {
    const all = [];
    const limit = 500;
    for (let skip = 0; skip <= 10000; skip += limit) {
      const rows = await base44.entities.RacerProfile.filter({}, 'registration_number', limit, skip);
      if (!rows?.length) break;
      all.push(...rows);
      if (rows.length < limit) break;
    }

    // 同一登録番号が複数ある場合は updated_at / updated_date が最も新しい1件だけを表示する。
    const byReg = new Map();
    for (const row of all) {
      const reg = String(row.registration_number || '').trim();
      if (!reg) continue;
      const prev = byReg.get(reg);
      const rowTime = String(row.updated_at || row.updated_date || row.created_date || '');
      const prevTime = String(prev?.updated_at || prev?.updated_date || prev?.created_date || '');
      if (!prev || rowTime >= prevTime) byReg.set(reg, row);
    }
    const unique = [...byReg.values()].sort((a, b) => Number(a.registration_number || 0) - Number(b.registration_number || 0));
    return { raw: all, unique };
  };

  const load = async () => {
    setBusy(true);
    setError('');
    try {
      const [profileResult, termRows] = await Promise.all([
        loadAllProfiles(),
        base44.entities.RacerTermStats.filter({}, '-term_year', 501, 0),
      ]);
      const terms = (termRows || []).slice(0, 500);
      setData({ profiles: profileResult.unique, terms });
      setMeta({
        profileRaw: profileResult.raw.length,
        profileUnique: profileResult.unique.length,
        profileDuplicate: Math.max(0, profileResult.raw.length - profileResult.unique.length),
        termsShown: terms.length,
        termsHasMore: (termRows || []).length > 500,
      });
    } catch (e) {
      setError(e?.message || 'DBの読込に失敗しました');
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => { load(); }, []);

  const rows = useMemo(() => {
    const list = data[tab] || [];
    const s = q.trim().toLowerCase();
    if (!s) return list;
    return list.filter(x => JSON.stringify(x).toLowerCase().includes(s));
  }, [data, tab, q]);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl sm:text-2xl font-black text-white flex items-center gap-2">
            <DbIcon className="w-5 h-5 text-[#f9c836]" />BOAT WORKS DATABASE
          </h1>
          <p className="text-xs text-slate-500 mt-1">登録済みの実データを直接表示</p>
        </div>
        <button onClick={load} disabled={busy} className="h-10 px-4 rounded-lg bg-[#f9c836] text-slate-950 font-black text-sm flex items-center gap-2 disabled:opacity-50">
          <RefreshCw className={cn('w-4 h-4', busy && 'animate-spin')} />{busy ? '読込中' : '再読込'}
        </button>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <Summary label="選手プロフィール" value={meta.profileUnique} suffix="人" sub={meta.profileDuplicate > 0 ? `重複 ${meta.profileDuplicate}件は表示上除外` : '重複なし'} />
        <Summary label="期別成績" value={meta.termsShown} suffix={meta.termsHasMore ? '件（最新500件）' : '件'} sub={meta.termsHasMore ? '期別成績は大量のため最新500件を表示' : '全件表示'} />
      </div>

      {error && <div className="rounded-xl border border-rose-500/30 bg-rose-950/40 px-3 py-2 text-sm text-rose-300">{error}</div>}

      <div className="grid grid-cols-2 gap-1 bg-[#161a22] border border-[#2d3748] p-1 rounded-xl">
        {tabs.map(([k, label, Icon]) => (
          <button key={k} onClick={() => setTab(k)} className={cn('h-10 rounded-lg text-xs sm:text-sm font-bold flex items-center justify-center gap-1.5', tab === k ? 'bg-[#f9c836] text-slate-950' : 'text-slate-400')}>
            <Icon className="w-4 h-4" />{label}
          </button>
        ))}
      </div>

      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" />
        <input value={q} onChange={e => setQ(e.target.value)} placeholder="選手名・登録番号・支部・期で検索" className="w-full h-11 pl-10 pr-3 rounded-xl bg-[#161a22] border border-[#2d3748] text-sm outline-none focus:border-blue-500" />
      </div>

      {tab === 'profiles' ? <Profiles rows={rows} /> : <Terms rows={rows} />}
    </div>
  );
}

function Summary({ label, value, suffix, sub }) {
  return <div className="bg-[#1e232d] border border-[#3a404c] rounded-xl p-3"><div className="text-[10px] text-slate-500">{label}</div><div className="text-xl font-black text-white mt-1">{value}<span className="text-[10px] text-slate-500 ml-1">{suffix}</span></div>{sub && <div className="text-[9px] text-slate-500 mt-1">{sub}</div>}</div>;
}

function Card({ children }) { return <div className="bg-[#1e232d] border border-[#3a404c] rounded-xl overflow-hidden">{children}</div>; }

function Profiles({ rows }) {
  return <Card><div className="divide-y divide-[#303743]">
    {rows.map(r => <div key={r.id || r.registration_number} className="p-3 flex items-center gap-3">
      <PlayerPhoto src={r.photo_url} registrationNumber={r.registration_number} alt={r.racer_name || r.player_name} size="sm" />
      <div className="min-w-0 flex-1">
        <div className="font-bold text-white truncate">{r.racer_name || r.player_name || '—'} <span className="text-[10px] text-slate-500">#{r.registration_number}</span></div>
        <div className="text-[10px] text-slate-500">{r.grade_class || r.player_class || '—'} ・ {r.branch_name || r.branch || '支部不明'} ・ {r.age ?? '—'}歳 ・ {r.weight ?? '—'}kg</div>
      </div>
      <Stat label="勝率" value={num(r.national_win_rate, 2)} />
      <Stat label="2連率" value={pct(r.national_2rate)} />
      <Stat label="平均ST" value={num(r.avg_st, 2)} />
    </div>)}
  </div>{!rows.length && <Empty />}</Card>;
}

function Terms({ rows }) {
  return <Card><div className="divide-y divide-[#303743]">
    {rows.map(r => <div key={r.id} className="p-3">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="font-bold text-white truncate">{r.racer_name || '—'} <span className="text-[10px] text-slate-500">#{r.registration_number}</span></div>
          <div className="text-[10px] text-slate-500">{termLabel(r)} ・ {r.player_class || '—'} ・ {r.branch_name || '—'} ・ 元ファイル {r.source_file || '—'}</div>
        </div>
        <div className="grid grid-cols-4 gap-3 shrink-0">
          <Stat label="出走" value={r.race_count ?? 0} />
          <Stat label="勝率" value={num(r.win_rate, 2)} />
          <Stat label="2連率" value={pct(r.fukusho_rate)} />
          <Stat label="平均ST" value={num(r.avg_st, 2)} />
        </div>
      </div>
    </div>)}
  </div>{!rows.length && <Empty />}</Card>;
}

function termLabel(r) {
  if (r.term_key) return r.term_key;
  const half = r.term_half === 'FIRST' ? '前期' : r.term_half === 'SECOND' ? '後期' : (r.term_half || '');
  return `${r.term_year || '—'} ${half}`.trim();
}
function Stat({ label, value }) { return <div className="text-right"><div className="text-[9px] text-slate-500">{label}</div><div className="text-xs sm:text-sm font-black text-slate-200">{value ?? '—'}</div></div>; }
function Empty() { return <div className="p-10 text-center text-slate-500 text-sm">表示できるデータがありません。</div>; }
function num(v, d = 1) { return v == null ? '—' : Number(v).toFixed(d); }
function pct(v) { return v == null ? '—' : `${Number(v).toFixed(1)}%`; }
