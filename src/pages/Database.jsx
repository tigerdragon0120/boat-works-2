import React, { useEffect, useMemo, useState } from 'react';
import { base44 } from '@/api/base44Client';
import PlayerPhoto from '@/components/race/PlayerPhoto';
import { Database as DbIcon, Users, Search, RefreshCw, History } from 'lucide-react';
import { cn } from '@/lib/utils';

const tabs = [
  ['profiles', '選手プロフィール', Users],
  ['terms', '期別成績', History],
];

const PAGE_SIZE = 200;

async function loadPaged(entity, sort, maxPages = 40) {
  const all = [];
  for (let page = 0; page < maxPages; page++) {
    const rows = await entity.filter({}, sort, 500, page * 500);
    if (!rows?.length) break;
    all.push(...rows);
    if (rows.length < 500) break;
  }
  return all;
}

export default function Database() {
  const [tab, setTab] = useState('profiles');
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [profiles, setProfiles] = useState([]);
  const [terms, setTerms] = useState([]);
  const [termKeys, setTermKeys] = useState([]);
  const [selectedTerm, setSelectedTerm] = useState('');
  const [page, setPage] = useState(1);
  const [meta, setMeta] = useState({ profileRaw: 0, profileUnique: 0, profileDuplicate: 0, termTotal: 0 });

  const load = async () => {
    setBusy(true);
    setError('');
    try {
      const [profileRows, termRows] = await Promise.all([
        loadPaged(base44.entities.RacerProfile, 'registration_number', 30),
        loadPaged(base44.entities.RacerTermStats, '-term_year', 120),
      ]);

      const byReg = new Map();
      for (const row of profileRows) {
        const reg = String(row.registration_number || '').trim();
        if (!reg) continue;
        const prev = byReg.get(reg);
        const rowTime = String(row.updated_at || row.updated_date || row.created_date || '');
        const prevTime = String(prev?.updated_at || prev?.updated_date || prev?.created_date || '');
        if (!prev || rowTime >= prevTime) byReg.set(reg, row);
      }
      const uniqueProfiles = [...byReg.values()].sort((a, b) => Number(a.registration_number || 0) - Number(b.registration_number || 0));

      const keys = [...new Set(termRows.map(r => r.term_key).filter(Boolean))].sort().reverse();
      const nextSelected = selectedTerm && keys.includes(selectedTerm) ? selectedTerm : (keys[0] || '');

      setProfiles(uniqueProfiles);
      setTerms(termRows);
      setTermKeys(keys);
      setSelectedTerm(nextSelected);
      setMeta({
        profileRaw: profileRows.length,
        profileUnique: uniqueProfiles.length,
        profileDuplicate: Math.max(0, profileRows.length - uniqueProfiles.length),
        termTotal: termRows.length,
      });
      setPage(1);
    } catch (e) {
      setError(e?.message || 'DBの読込に失敗しました');
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => { load(); }, []);
  useEffect(() => { setPage(1); }, [tab, q, selectedTerm]);

  const rows = useMemo(() => {
    const s = q.trim().toLowerCase();
    let list = tab === 'profiles' ? profiles : terms.filter(r => !selectedTerm || r.term_key === selectedTerm);
    if (s) {
      list = list.filter(x => {
        const hay = [
          x.racer_name, x.player_name, x.registration_number, x.branch_name, x.branch,
          x.player_class, x.grade_class, x.term_key, x.source_file
        ].filter(v => v != null).join(' ').toLowerCase();
        return hay.includes(s);
      });
    }
    return list;
  }, [profiles, terms, tab, q, selectedTerm]);

  const totalPages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const visibleRows = rows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl sm:text-2xl font-black text-white flex items-center gap-2">
            <DbIcon className="w-5 h-5 text-[#f9c836]" />BOAT WORKS DATABASE
          </h1>
          <p className="text-xs text-slate-500 mt-1">登録済みの実データを全件検索</p>
        </div>
        <button onClick={load} disabled={busy} className="h-10 px-4 rounded-lg bg-[#f9c836] text-slate-950 font-black text-sm flex items-center gap-2 disabled:opacity-50">
          <RefreshCw className={cn('w-4 h-4', busy && 'animate-spin')} />{busy ? '読込中' : '再読込'}
        </button>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <Summary label="選手プロフィール" value={meta.profileUnique} suffix="人" sub={meta.profileDuplicate > 0 ? `重複 ${meta.profileDuplicate}件は表示上除外` : '重複なし'} />
        <Summary label="期別成績" value={selectedTerm ? terms.filter(r => r.term_key === selectedTerm).length : meta.termTotal} suffix="人" sub={selectedTerm ? `${selectedTerm} の全選手` : `全期 ${meta.termTotal}件`} />
      </div>

      {error && <div className="rounded-xl border border-rose-500/30 bg-rose-950/40 px-3 py-2 text-sm text-rose-300">{error}</div>}

      <div className="grid grid-cols-2 gap-1 bg-[#161a22] border border-[#2d3748] p-1 rounded-xl">
        {tabs.map(([k, label, Icon]) => (
          <button key={k} onClick={() => setTab(k)} className={cn('h-10 rounded-lg text-xs sm:text-sm font-bold flex items-center justify-center gap-1.5', tab === k ? 'bg-[#f9c836] text-slate-950' : 'text-slate-400')}>
            <Icon className="w-4 h-4" />{label}
          </button>
        ))}
      </div>

      {tab === 'terms' && (
        <select value={selectedTerm} onChange={e => setSelectedTerm(e.target.value)} className="w-full h-11 px-3 rounded-xl bg-[#161a22] border border-[#2d3748] text-sm text-slate-200 outline-none focus:border-blue-500">
          {termKeys.map(k => <option key={k} value={k}>{k}</option>)}
        </select>
      )}

      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" />
        <input value={q} onChange={e => setQ(e.target.value)} placeholder="選手名・登録番号・支部・級別・期・元ファイル名で検索" className="w-full h-11 pl-10 pr-3 rounded-xl bg-[#161a22] border border-[#2d3748] text-sm outline-none focus:border-blue-500" />
      </div>

      <div className="flex items-center justify-between text-[11px] text-slate-500 px-1">
        <span>{rows.length}件中 {rows.length ? (page - 1) * PAGE_SIZE + 1 : 0}〜{Math.min(page * PAGE_SIZE, rows.length)}件を表示</span>
        <div className="flex items-center gap-2">
          <button disabled={page <= 1} onClick={() => setPage(p => Math.max(1, p - 1))} className="px-3 h-8 rounded-lg border border-[#3a404c] disabled:opacity-30">前へ</button>
          <span>{page}/{totalPages}</span>
          <button disabled={page >= totalPages} onClick={() => setPage(p => Math.min(totalPages, p + 1))} className="px-3 h-8 rounded-lg border border-[#3a404c] disabled:opacity-30">次へ</button>
        </div>
      </div>

      {tab === 'profiles' ? <Profiles rows={visibleRows} /> : <Terms rows={visibleRows} />}
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
