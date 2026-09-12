import React, { useState, useEffect } from "react";
import { base44 } from "@/api/base44Client";
import { getSettings, todayStr, generateAndSavePrediction, saveResultAndVerify, invokeSync } from "@/lib/predictionService";
import { Settings as SettingsIcon, FlaskConical, Save, Plus, Code, ChevronDown, ChevronRight, Zap } from "lucide-react";
import { cn } from "@/lib/utils";

export default function DeveloperTools() {
  const [open, setOpen] = useState(null);
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 mb-1">
        <Code className="w-4 h-4 text-slate-500" />
        <h2 className="text-lg font-bold text-slate-900">開発者向け</h2>
      </div>
      <p className="text-xs text-slate-400 -mt-1">通常運用では使用しません。緊急時・テスト用のツールです。</p>

      <Accordion title="判定しきい値設定" open={open === "settings"} onClick={() => setOpen(open === "settings" ? null : "settings")}>
        <SettingsTab />
      </Accordion>
      <Accordion title="手動結果登録(緊急用)" open={open === "result"} onClick={() => setOpen(open === "result" ? null : "result")}>
        <ResultTab />
      </Accordion>
      <Accordion title="JSON直接取り込み(テスト用)" open={open === "json"} onClick={() => setOpen(open === "json" ? null : "json")}>
        <JsonIngestTab />
      </Accordion>
      <Accordion title="サンプルレース登録(テスト用)" open={open === "seed"} onClick={() => setOpen(open === "seed" ? null : "seed")}>
        <SeedTab />
      </Accordion>
      <Accordion title="枠番過去10走 事前計算" open={open === "lane10"} onClick={() => setOpen(open === "lane10" ? null : "lane10")}>
        <Lane10PrecomputeTab />
      </Accordion>
    </div>
  );
}

function Accordion({ title, open, onClick, children }) {
  return (
    <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
      <button onClick={onClick} className="w-full flex items-center gap-2 px-3 py-2.5 hover:bg-slate-50">
        {open ? <ChevronDown className="w-4 h-4 text-slate-400" /> : <ChevronRight className="w-4 h-4 text-slate-400" />}
        <span className="text-sm font-bold text-slate-700">{title}</span>
      </button>
      {open && <div className="px-3 pb-3">{children}</div>}
    </div>
  );
}

function SettingsTab() {
  const [s, setS] = useState(null);
  const [saved, setSaved] = useState(false);
  useEffect(() => { getSettings().then(setS); }, []);
  if (!s) return <div className="text-center py-4 text-slate-400 text-sm">読み込み中…</div>;
  const num = (k) => (
    <Field label={k}>
      <input type="number" value={s[k] ?? 0} onChange={(e) => setS({ ...s, [k]: Number(e.target.value) })}
        className="w-full h-9 px-2 rounded-lg border border-slate-200 text-sm" />
    </Field>
  );
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3">
        {num("strong_buy_ev_threshold")}{num("buy_ev_threshold")}{num("watch_ev_threshold")}
        {num("min_probability")}{num("min_data_count")}{num("min_confidence")}{num("max_bets")}
      </div>
      <div className="pt-2 border-t border-slate-100">
        <div className="text-xs font-bold text-slate-700 mb-2">スコア重み</div>
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
          {Object.keys(s.weights || {}).map((k) => (
            <Field key={k} label={k}>
              <input type="number" step="0.1" value={s.weights[k]} onChange={(e) => setS({ ...s, weights: { ...s.weights, [k]: Number(e.target.value) } })}
                className="w-full h-9 px-2 rounded-lg border border-slate-200 text-sm" />
            </Field>
          ))}
        </div>
      </div>
      <button onClick={async () => { await base44.entities.AppSettings.update(s.id, s); setSaved(true); setTimeout(() => setSaved(false), 1500); }}
        className="w-full h-10 rounded-xl bg-sky-600 text-white font-semibold text-sm flex items-center justify-center gap-1.5 hover:bg-sky-700">
        <Save className="w-4 h-4" /> {saved ? "保存しました" : "保存"}
      </button>
    </div>
  );
}

function ResultTab() {
  const [races, setRaces] = useState([]);
  const [sel, setSel] = useState("");
  const [result, setResult] = useState("");
  const [payout, setPayout] = useState("");
  const [done, setDone] = useState(false);
  useEffect(() => {
    base44.entities.Race.filter({ race_date: todayStr() }, "-deadline", 50).then((r) => { setRaces(r || []); if (r && r[0]) setSel(r[0].id); });
  }, []);
  const submit = async () => {
    if (!sel || !result) return;
    await saveResultAndVerify(sel, result, Number(payout) || 0, result.split("-").map(Number));
    setDone(true); setResult(""); setPayout("");
    setTimeout(() => setDone(false), 1500);
  };
  return (
    <div className="space-y-3">
      <Field label="レース">
        <select value={sel} onChange={(e) => setSel(e.target.value)} className="w-full h-9 px-2 rounded-lg border border-slate-200 text-sm">
          {races.map((r) => <option key={r.id} value={r.id}>{r.venue} {r.race_number}R</option>)}
        </select>
      </Field>
      <Field label="実際の3連単 (例 1-3-5)">
        <input value={result} onChange={(e) => setResult(e.target.value)} placeholder="1-3-5" className="w-full h-9 px-2 rounded-lg border border-slate-200 text-sm font-mono" />
      </Field>
      <Field label="払戻(100円あたり)">
        <input type="number" value={payout} onChange={(e) => setPayout(e.target.value)} className="w-full h-9 px-2 rounded-lg border border-slate-200 text-sm" />
      </Field>
      <button onClick={submit} className="w-full h-10 rounded-xl bg-sky-600 text-white font-semibold text-sm flex items-center justify-center gap-1.5 hover:bg-sky-700">
        <Save className="w-4 h-4" /> {done ? "登録・照合しました" : "結果登録して照合"}
      </button>
    </div>
  );
}

function JsonIngestTab() {
  const [jsonText, setJsonText] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");
  const run = async () => {
    setBusy(true); setMsg(""); setErr("");
    try {
      const data = JSON.parse(jsonText);
      const res = await invokeSync("ingest", { data, date: todayStr() });
      const sum = res.data?.summary || res.summary || {};
      setMsg(`取り込み完了: ${sum.races_upserted || 0}レース / PRE ${sum.pre_generated || 0} / FINAL ${sum.final_generated || 0}`);
    } catch (e) { setErr(e?.response?.data?.message || e.message); }
    setBusy(false);
  };
  return (
    <div className="space-y-2">
      <p className="text-[11px] text-slate-500">BOAT WORKS形式のJSON({`{ races, entries, series, results, odds }`})を直接取り込みます。</p>
      <textarea value={jsonText} onChange={(e) => setJsonText(e.target.value)} placeholder='{"races":[...],"entries":[...]}' rows={4} className="w-full p-2 rounded-lg border border-slate-200 text-xs font-mono" />
      <button onClick={run} disabled={busy || !jsonText} className="w-full h-9 rounded-lg bg-slate-900 text-white text-sm font-semibold flex items-center justify-center gap-1.5 disabled:opacity-50">
        {busy ? "取り込み中…" : "取り込んで予想実行"}
      </button>
      {msg && <div className="text-xs text-emerald-600 bg-emerald-50 rounded-lg p-2">{msg}</div>}
      {err && <div className="text-xs text-rose-600 bg-rose-50 rounded-lg p-2 break-all">{err}</div>}
    </div>
  );
}

function SeedTab() {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const seed = async () => {
    setBusy(true); setMsg("");
    try {
      const today = todayStr();
      const deadline = new Date(); deadline.setHours(deadline.getHours() + 3, 0, 0, 0);
      const race = await base44.entities.Race.create({
        venue: "平和島", race_number: 7, race_date: today, deadline: deadline.toISOString(),
        race_type: "一般", grade: "一般", weather: "晴", wind_dir: "向かい", wind_speed: 4, wave_height: 3, water_temp: 22, air_temp: 24,
        status: "scheduled", has_pre: false, has_final: false,
      });
      const players = [
        ["1","山田太郎","4321","A1",6.8,7.2,58,78,62,80,0.14,1,0,52,70,48,65,1.41,1,0.12,1,8.5,"1.3.2.1.4",0.13,70,"逃げ",40],
        ["2","佐藤次郎","3382","A2",6.2,6.0,52,70,50,72,0.15,2,1,48,62,45,60,1.43,3,0.14,2,6.2,"2.4.3.2.5",0.15,60,"差し",30],
        ["3","鈴木三郎","2910","B1",5.5,5.8,45,62,48,66,0.16,0,0,42,55,50,58,1.45,2,0.13,3,4.0,"3.5.4.3.2",0.14,55,"まくり",50],
        ["4","高橋四郎","5021","A1",6.5,6.8,55,72,58,75,0.13,0,0,50,65,40,52,1.42,4,0.15,4,7.1,"4.2.1.4.3",0.12,68,"差し",35],
        ["5","田中五郎","4190","B1",5.0,5.2,40,58,42,60,0.17,2,0,38,52,55,62,1.46,5,0.16,5,3.5,"5.6.5.6.4",0.16,45,"追い込み",20],
        ["6","渡辺六郎","3655","B2",4.5,4.8,35,52,38,55,0.18,1,0,35,48,60,65,1.44,6,0.17,6,2.8,"6.5.6.6.5",0.17,40,"追い込み",15],
      ];
      const docs = players.map((p) => ({
        race_id: race.id, boat_number: Number(p[0]), player_name: p[1], register_number: p[2], registration_number: p[2], player_class: p[3],
        national_win_rate: p[4], local_win_rate: p[5], national_f2_rate: p[6], national_f3_rate: p[7],
        local_f2_rate: p[8], local_f3_rate: p[9], avg_st: p[10], f_count: p[11], l_count: p[12],
        motor_f2_rate: p[13], motor_f3_rate: p[14], boat_f2_rate: p[15], boat_f3_rate: p[16],
        exhibition_time: p[17], exhibition_rank: p[18], exhibition_st: p[19], exhibition_course: p[20],
        section_points: p[21], section_finishes: p[22], section_st: p[23], section_momentum: p[24],
        program_intent: p[25], gamble_level: p[26], is_absent: false,
      }));
      await base44.entities.RaceEntry.bulkCreate(docs);
      const settings = await getSettings();
      await generateAndSavePrediction(race, docs, settings, "PRE", {});
      await generateAndSavePrediction({ ...race, id: race.id }, docs, settings, "FINAL", {});
      setMsg("サンプルレース(平和島7R)を登録し、PRE/FINAL予想を生成しました。");
    } catch (e) { setMsg("エラー: " + e.message); }
    setBusy(false);
  };
  return (
    <div className="space-y-2">
      <p className="text-[11px] text-slate-500">6艇のサンプルデータを生成し、PRE/FINAL予想を即時実行します。</p>
      <button onClick={seed} disabled={busy} className="w-full h-10 rounded-xl bg-slate-900 text-white font-semibold text-sm flex items-center justify-center gap-1.5 disabled:opacity-50">
        <Plus className="w-4 h-4" /> {busy ? "生成中…" : "サンプル登録して予想実行"}
      </button>
      {msg && <div className="text-xs text-sky-600 bg-sky-50 rounded-lg p-2">{msg}</div>}
    </div>
  );
}

function Lane10PrecomputeTab() {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [mode, setMode] = useState("all");

  const run = async () => {
    setBusy(true); setMsg("");
    try {
      const res = await base44.functions.invoke("precomputeLanePast10Stats", { mode, force: false });
      const d = res?.data || {};
      setMsg(`完了: ${d.processed || 0}R処理 / ${d.skipped || 0}Rスキップ / 残り${d.remaining || 0}R${d.errors?.length ? ` / エラー${d.errors.length}件` : ""}`);
    } catch (e) {
      setMsg("エラー: " + (e?.message || e));
    }
    setBusy(false);
  };

  const forceRun = async () => {
    setBusy(true); setMsg("");
    try {
      const res = await base44.functions.invoke("precomputeLanePast10Stats", { mode, force: true });
      const d = res?.data || {};
      setMsg(`強制再計算完了: ${d.processed || 0}R処理 / ${d.skipped || 0}Rスキップ`);
    } catch (e) {
      setMsg("エラー: " + (e?.message || e));
    }
    setBusy(false);
  };

  return (
    <div className="space-y-2">
      <p className="text-[11px] text-slate-500">出走表全レースの枠番過去10走を事前計算しキャッシュ保存します。タブ表示時に即表示されます。</p>
      <Field label="対象">
        <select value={mode} onChange={(e) => setMode(e.target.value)} className="w-full h-9 px-2 rounded-lg border border-slate-200 text-sm">
          <option value="all">当日+翌日</option>
          <option value="today">当日のみ</option>
          <option value="tomorrow">翌日のみ</option>
        </select>
      </Field>
      <div className="flex gap-2">
        <button onClick={run} disabled={busy} className="flex-1 h-9 rounded-lg bg-sky-600 text-white text-sm font-semibold flex items-center justify-center gap-1.5 disabled:opacity-50">
          <Zap className="w-4 h-4" /> {busy ? "実行中…" : "事前計算実行"}
        </button>
        <button onClick={forceRun} disabled={busy} className="flex-1 h-9 rounded-lg bg-slate-900 text-white text-sm font-semibold flex items-center justify-center gap-1.5 disabled:opacity-50">
          {busy ? "実行中…" : "強制再計算"}
        </button>
      </div>
      {msg && <div className="text-xs text-sky-600 bg-sky-50 rounded-lg p-2">{msg}</div>}
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