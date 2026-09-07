import React, { useState, useEffect } from "react";
import { base44 } from "@/api/base44Client";
import { getSettings, invokeSync, getSyncStatus, listTodayRaceStatus, todayStr } from "@/lib/predictionService";
import { RefreshCw, Database, CloudDownload, AlertTriangle, CheckCircle2, XCircle, ChevronDown, ChevronRight, Link2 } from "lucide-react";
import { cn } from "@/lib/utils";

const stateInfo = {
  "no-data": { label: "データ未取得", cls: "bg-slate-100 text-slate-500" },
  pending: { label: "予想未実行", cls: "bg-amber-100 text-amber-700" },
  pre: { label: "PRE済", cls: "bg-sky-100 text-sky-700" },
  final: { label: "FINAL済", cls: "bg-emerald-100 text-emerald-700" },
  finished: { label: "確定", cls: "bg-slate-200 text-slate-600" },
};

export default function SyncPanel() {
  const [settings, setSettings] = useState(null);
  const [status, setStatus] = useState(null);
  const [races, setRaces] = useState([]);
  const [manifest, setManifest] = useState(null);
  const [profileStats, setProfileStats] = useState(null);
  const [busy, setBusy] = useState(false);
  const [jsonText, setJsonText] = useState("");
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");
  const [expandedErrors, setExpandedErrors] = useState({});

  const load = async () => {
    const s = await getSettings();
    setSettings(s);
    setStatus(await getSyncStatus());
    setRaces(await listTodayRaceStatus());
    // BOAT WORKS側のmanifestを取得(開催場・Race数)
    try {
      const mres = await invokeSync("api", { date: todayStr(), manifest: true });
      setManifest(mres.data || mres || null);
    } catch { setManifest(null); }
    // プロフィール接続状況
    try {
      const [entries, profiles] = await Promise.all([
        base44.entities.RaceEntry.filter({ race_date: todayStr() }, "boat_number", 5000),
        base44.entities.RacerPerformanceProfile.list("registration_number", 5000),
      ]);
      const profileRegs = new Set((profiles || []).map(p => p.registration_number));
      const connected = (entries || []).filter(e => {
        const reg = String(e.registration_number || e.register_number || "").trim();
        return reg && profileRegs.has(reg);
      }).length;
      setProfileStats({ total_entries: entries?.length || 0, connected, total_profiles: profiles?.length || 0 });
    } catch { setProfileStats(null); }
  };
  useEffect(() => { load(); }, []);

  const runApi = async () => {
    setBusy(true); setMsg(""); setErr("");
    try {
      // 全場一括取得: 1回のAPI呼び出しで全データを取得(Rate limit回避)
      setMsg("BOAT WORKSから全開催データを取得中…");
      const res = await invokeSync("api", { date: todayStr() });
      const sum = res.data?.summary || res.summary || {};
      const totalRaces = sum.races_upserted || 0;
      const totalPre = sum.pre_generated || 0;
      const totalFinal = sum.final_generated || 0;
      const totalErrors = (sum.errors?.length || 0);
      if (totalErrors > 0) {
        setErr(`${totalErrors}件のエラー — 詳細は下のエラー一覧を参照`);
        setMsg(`同期完了(エラーあり): ${totalRaces}レース / PRE ${totalPre} / FINAL ${totalFinal}`);
      } else {
        setMsg(`同期完了: ${totalRaces}レース / PRE ${totalPre} / FINAL ${totalFinal}`);
      }
      await load();
    } catch (e) { setErr(e?.response?.data?.message || e.message || JSON.stringify(e)); }
    setBusy(false);
  };

  const runIngest = async () => {
    setBusy(true); setMsg(""); setErr("");
    try {
      const data = JSON.parse(jsonText);
      const res = await invokeSync("ingest", { data, date: todayStr() });
      const sum = res.data?.summary || res.summary || {};
      setMsg(`取り込み完了: ${sum.races_upserted || 0}レース / PRE ${sum.pre_generated || 0} / FINAL ${sum.final_generated || 0}`);
      if (sum.errors?.length) setErr(`${sum.errors.length}件のエラー`);
      await load();
    } catch (e) { setErr(e?.response?.data?.message || e.message || JSON.stringify(e)); }
    setBusy(false);
  };

  if (!settings) return <div className="text-center py-10 text-slate-400 text-sm">読み込み中…</div>;

  const counts = races.reduce((a, r) => {
    a.total++; if (r.complete) a.complete++; if (r.exhibition_ready) a.exhibition++; if (r.has_pre) a.pre++; if (r.has_final) a.final++; if (r.status === "finished") a.finished++;
    return a;
  }, { total: 0, complete: 0, exhibition: 0, pre: 0, final: 0, finished: 0 });

  // BOAT WORKS側のデータ
  const bwVenues = manifest?.venue_codes?.length || 0;
  const bwRaces = manifest?.race_count || 0;
  // BOAT WORKS 2側のデータ
  const bw2Venues = new Set(races.map(r => r.venue_code).filter(Boolean)).size;
  const bw2Races = counts.total;
  const bw2Entries = races.reduce((a, r) => a + (r.entries || 0), 0);
  // 同期判定
  const allSynced = bwRaces > 0 && bw2Races === bwRaces && counts.complete === bw2Races && (profileStats?.connected || 0) === bw2Entries;
  const syncLabel = allSynced ? "SYNCED" : (bw2Races > 0 ? "PARTIAL" : "NO_DATA");
  const syncCls = allSynced ? "bg-emerald-100 text-emerald-700" : (bw2Races > 0 ? "bg-amber-100 text-amber-700" : "bg-slate-100 text-slate-500");

  return (
    <div className="space-y-4">
      {/* BOAT WORKS vs BOAT WORKS 2 比較 */}
      <div className="bg-white rounded-2xl border border-slate-100 p-4">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <Database className="w-4 h-4 text-sky-600" />
            <h3 className="font-bold text-sm text-slate-900">同期状態</h3>
          </div>
          <span className={cn("px-2.5 h-7 rounded-md font-bold text-xs flex items-center gap-1", syncCls)}>
            {allSynced ? <CheckCircle2 className="w-3.5 h-3.5" /> : <AlertTriangle className="w-3.5 h-3.5" />}{syncLabel}
          </span>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div className="bg-sky-50 rounded-xl p-3">
            <div className="text-[10px] font-bold text-sky-700 mb-2">BOAT WORKS (正本)</div>
            <div className="space-y-1">
              <Stat2 label="開催場" v={bwVenues} />
              <Stat2 label="Race" v={bwRaces} />
            </div>
          </div>
          <div className="bg-slate-50 rounded-xl p-3">
            <div className="text-[10px] font-bold text-slate-700 mb-2">BOAT WORKS 2</div>
            <div className="space-y-1">
              <Stat2 label="開催場" v={bw2Venues} tone={bw2Venues === bwVenues ? "text-emerald-600" : "text-rose-600"} />
              <Stat2 label="Race" v={bw2Races} tone={bw2Races === bwRaces ? "text-emerald-600" : "text-rose-600"} />
            </div>
          </div>
        </div>
        <div className="grid grid-cols-3 sm:grid-cols-6 gap-2 text-center mt-3">
          <Stat label="6艇揃い" v={counts.complete} tone="text-sky-600" />
          <Stat label="展示取得済" v={counts.exhibition} tone="text-amber-600" />
          <Stat label="PRE" v={`${counts.pre}/${bw2Races}`} tone="text-sky-600" />
          <Stat label="FINAL" v={`${counts.final}/${counts.exhibition}`} tone="text-emerald-600" />
          <Stat label="確定" v={counts.finished} tone="text-slate-500" />
          <Stat label="ERROR" v={status?.error_count || 0} tone={(status?.error_count || 0) > 0 ? "text-rose-600" : "text-slate-500"} />
        </div>
        {/* プロフィール接続 */}
        {profileStats && (
          <div className="mt-3 flex items-center gap-2 text-xs">
            <Link2 className="w-3.5 h-3.5 text-sky-600" />
            <span className="text-slate-600">選手プロフィール接続:</span>
            <span className={cn("font-bold", profileStats.connected === profileStats.total_entries ? "text-emerald-600" : "text-amber-600")}>
              {profileStats.connected} / {profileStats.total_entries}艇
            </span>
            <span className="text-slate-400">(全プロファイル {profileStats.total_profiles}件)</span>
          </div>
        )}
        <div className="mt-2 flex items-center gap-2 text-xs">
          {status ? (
            <>
              <span className="text-slate-400">最終同期: {status.last_sync_at ? new Date(status.last_sync_at).toLocaleString("ja-JP") : "—"}</span>
              <span className="text-slate-400">モード: {status.mode}</span>
            </>
          ) : <span className="text-slate-400">同期履歴なし</span>}
        </div>
      </div>

      {/* API同期実行 */}
      <div className="bg-white rounded-2xl border border-slate-100 p-4 space-y-3">
        <div className="flex items-center gap-2">
          <CloudDownload className="w-4 h-4 text-sky-600" />
          <h3 className="font-bold text-sm text-slate-900">BOAT WORKS 実データ同期</h3>
        </div>
        <p className="text-[11px] text-slate-500">接続先URLと認証キーはフロント画面に保存せず、サーバー側Secretだけで管理します。BOAT WORKS側は読み取り専用です。</p>
        <button onClick={runApi} disabled={busy} className="w-full h-9 rounded-lg bg-sky-600 text-white text-sm font-semibold flex items-center justify-center gap-1.5 hover:bg-sky-700 disabled:opacity-50">
          <RefreshCw className={cn("w-4 h-4", busy && "animate-spin")} /> BOAT WORKSから今日の実データを同期
        </button>
      </div>

      {/* JSON取り込み(テスト/手動) */}
      <div className="bg-white rounded-2xl border border-slate-100 p-4 space-y-2">
        <div className="flex items-center gap-2">
          <Database className="w-4 h-4 text-slate-600" />
          <h3 className="font-bold text-sm text-slate-900">JSON直接取り込み(テスト用)</h3>
        </div>
        <p className="text-[11px] text-slate-500">BOAT WORKS形式のJSON({`{ races, entries, series, results, odds }`})を直接取り込んで同期+予想を実行します。</p>
        <textarea value={jsonText} onChange={(e) => setJsonText(e.target.value)} placeholder='{"races":[...],"entries":[...],"series":[...],"results":[...],"odds":[...]}' rows={4} className="w-full p-2 rounded-lg border border-slate-200 text-xs font-mono" />
        <button onClick={runIngest} disabled={busy || !jsonText} className="w-full h-9 rounded-lg bg-slate-900 text-white text-sm font-semibold flex items-center justify-center gap-1.5 hover:bg-slate-800 disabled:opacity-50">
          <RefreshCw className={cn("w-4 h-4", busy && "animate-spin")} /> 取り込んで予想実行
        </button>
      </div>

      {msg && <div className="text-xs text-emerald-600 bg-emerald-50 rounded-lg p-2">{msg}</div>}
      {err && <div className="text-xs text-rose-600 bg-rose-50 rounded-lg p-2 flex items-start gap-1"><AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" /><span className="break-all">{err}</span></div>}

      {/* レース別状態 */}
      <div className="bg-white rounded-2xl border border-slate-100 p-4">
        <h3 className="font-bold text-sm text-slate-900 mb-3">今日のレース別状態</h3>
        {races.length === 0 ? (
          <div className="text-center py-6 text-slate-400 text-sm">今日のレースデータがありません。同期を実行してください。</div>
        ) : (
          <div className="space-y-1.5">
            {races.map((r) => {
              const si = stateInfo[r.state] || stateInfo["no-data"];
              return (
                <div key={r.id} className="flex items-center gap-2 text-xs py-1.5 border-b border-slate-50 last:border-0">
                  <span className="font-mono text-slate-400 w-16 truncate">{r.race_key || "—"}</span>
                  <span className="font-semibold text-slate-700 w-24 truncate">{r.venue} {r.race_number}R</span>
                  <span className="text-slate-400">{r.entries}/6艇</span>
                  <span className={cn("px-2 h-5 rounded text-[10px] font-bold flex items-center", si.cls)}>{si.label}</span>
                  {r.exhibition_ready && <span className="text-[10px] text-amber-600">展示済</span>}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* エラー一覧(展開可能) */}
      {status?.errors?.length > 0 && (
        <div className="bg-white rounded-2xl border border-rose-100 p-4">
          <div className="flex items-center gap-2 mb-2"><XCircle className="w-4 h-4 text-rose-500" /><h3 className="font-bold text-sm text-rose-700">同期エラー({status.errors.length}件)</h3></div>
          <div className="space-y-1 max-h-60 overflow-y-auto">
            {status.errors.map((e, i) => {
              const key = `${i}_${e.race_key || ""}`;
              const expanded = expandedErrors[key];
              const parts = String(e.race_key || "").split("_");
              const raceNo = parts.length >= 3 ? parts[parts.length - 1] : "—";
              const venueCode = parts.length >= 3 ? parts[parts.length - 2] : "—";
              const raceDate = parts.length >= 3 ? parts.slice(0, -2).join("_") : "—";
              return (
                <div key={i} className="border border-rose-100 rounded-lg overflow-hidden">
                  <button onClick={() => setExpandedErrors(prev => ({ ...prev, [key]: !prev[key] }))}
                    className="w-full flex items-center gap-2 px-2 py-1.5 text-left hover:bg-rose-50">
                    {expanded ? <ChevronDown className="w-3 h-3 text-rose-400 shrink-0" /> : <ChevronRight className="w-3 h-3 text-rose-400 shrink-0" />}
                    <span className="font-mono text-[11px] text-rose-700 shrink-0">{e.race_key || "—"}</span>
                    <span className="text-[11px] text-rose-500 truncate flex-1">{e.message}</span>
                  </button>
                  {expanded && (
                    <div className="px-3 py-2 bg-rose-50/50 text-[11px] space-y-1 border-t border-rose-100">
                      <ErrRow label="発生時刻" v={status.last_sync_at ? new Date(status.last_sync_at).toLocaleString("ja-JP") : "—"} />
                      <ErrRow label="raceKey" v={e.race_key || "—"} />
                      <ErrRow label="raceDate" v={raceDate} />
                      <ErrRow label="venueCode" v={venueCode} />
                      <ErrRow label="raceNo" v={raceNo} />
                      <ErrRow label="Function" v="syncAndPredict" />
                      <ErrRow label="エラー内容" v={e.message} />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

function Stat({ label, v, tone }) {
  return (
    <div className="bg-slate-50 rounded-lg py-2">
      <div className={cn("font-display font-bold text-lg leading-none", tone || "text-slate-900")}>{v}</div>
      <div className="text-[10px] text-slate-400 mt-0.5">{label}</div>
    </div>
  );
}

function Stat2({ label, v, tone }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-[11px] text-slate-500">{label}</span>
      <span className={cn("font-bold text-sm", tone || "text-slate-900")}>{v}</span>
    </div>
  );
}

function ErrRow({ label, v }) {
  return (
    <div className="flex gap-2">
      <span className="text-slate-400 w-16 shrink-0">{label}</span>
      <span className="text-slate-700 font-mono break-all">{v}</span>
    </div>
  );
}

function Field({ label, children }) {
  return (
    <label className="block">
      <span className="text-[11px] text-slate-500 font-medium block mb-1">{label}</span>
      {children}
    </label>
  );
}