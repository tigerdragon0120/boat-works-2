import React, { useEffect, useState } from "react";
import { importOfficialFile, saveBoatraceData } from "@/lib/dataManagementService";
import { parseBoatraceFile } from "@/lib/boatraceFileParser";
import { getKBatchImportState, startKBatchImport, subscribeKBatchImport, resumeKBatchImport } from "@/lib/kBatchImportManager";
import { FileSpreadsheet, Users, History, Cog, Upload, CheckCircle2, AlertTriangle, Loader2, FileText, Zap, TrendingUp } from "lucide-react";
import { cn } from "@/lib/utils";
import RacerTermImportCard from "@/components/admin/RacerTermImportCard";

export default function FileImportSection() {
  return (
    <div className="space-y-4">
      {/* メイン: 競艇オフィシャルTXT取込 */}
      <div>
        <div className="flex items-center gap-2 mb-2">
          <FileText className="w-5 h-5 text-sky-600" />
          <h2 className="text-lg font-bold text-slate-900">競艇オフィシャルTXT取込</h2>
          <span className="px-2 py-0.5 rounded-full bg-sky-100 text-sky-700 text-[10px] font-bold">B番組表 / K結果 対応</span>
        </div>
        <p className="text-xs text-slate-500 mb-3">公式サイトからDLしたTXTファイルをアップロード。CP932/Shift-JIS対応、B/K自動判定、プレビュー後登録。</p>
        <TxtImportCard />
      </div>

      {/* 選手期別成績取込 */}
      <div className="pt-4 border-t border-slate-200">
        <div className="flex items-center gap-2 mb-2">
          <TrendingUp className="w-5 h-5 text-emerald-600" />
          <h2 className="text-lg font-bold text-slate-900">選手期別成績</h2>
          <span className="px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-700 text-[10px] font-bold">2002年〜現在</span>
        </div>
        <p className="text-xs text-slate-500 mb-3">公式ファン手帳データ（LZH解凍後のTXT）を期別履歴として蓄積。複数ファイル一括投入対応。過去データは絶対削除されません。</p>
        <RacerTermImportCard />
      </div>

      {/* 副次: その他ファイル取込 */}
      <div className="pt-4 border-t border-slate-200">
        <div className="flex items-center gap-2 mb-2">
          <Upload className="w-4 h-4 text-slate-500" />
          <h3 className="text-sm font-bold text-slate-700">最新選手プロフィール(CSV / Excel / JSON)</h3>
        </div>
        <p className="text-[11px] text-slate-400 mb-3">AI抽出による汎用ファイル取込。期別成績ではなく現在のプロフィール更新に使用。</p>
        <div className="grid sm:grid-cols-2 gap-3">
          {importTypes.map((t) => (
            <FileImportCard key={t.key} type={t} />
          ))}
        </div>
      </div>
    </div>
  );
}

// === 競艇オフィシャルTXT取込カード ===
function TxtImportCard() {
  const [file, setFile] = useState(null);
  const initialBatch = getKBatchImportState();
  const [files, setFiles] = useState([]);
  const [batchMode, setBatchMode] = useState(!!initialBatch.running || (initialBatch.total || 0) > 0);
  const [batchProgress, setBatchProgress] = useState({ current: initialBatch.current, total: initialBatch.total, file: initialBatch.file });
  const [batchResults, setBatchResults] = useState(initialBatch.results || []);
  const [backgroundRunning, setBackgroundRunning] = useState(!!initialBatch.running);
  const [dragOver, setDragOver] = useState(false);
  const [parsing, setParsing] = useState(false);
  const [preview, setPreview] = useState(null);
  const [parseError, setParseError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState(null);
  const [saveError, setSaveError] = useState(null);

  useEffect(() => {
    // 画面遷移から戻った時にサーバー側ジョブのポーリングを再開する
    resumeKBatchImport();
    return subscribeKBatchImport((s) => {
      setBackgroundRunning(!!s.running);
      if (s.running || (s.total || 0) > 0) setBatchMode(true);
      setBatchProgress({ current: s.current || 0, total: s.total || 0, file: s.file || "" });
      setBatchResults(s.results || []);
    });
  }, []);

  const handleFile = async (f) => {
    if (!f) return;
    setFile(f); setPreview(null); setParseError(null); setResult(null); setSaveError(null);
    setParsing(true);
    try {
      const arrayBuffer = await f.arrayBuffer();
      const parsed = parseBoatraceFile(arrayBuffer, f.name);
      if (parsed.ok) setPreview(parsed);
      else setParseError(parsed.errors.join("\n"));
      if (parsed.warnings.length && parsed.ok) setPreview({ ...parsed, warnings: parsed.warnings });
    } catch (e) {
      setParseError(e.message);
    }
    setParsing(false);
  };

  const handleSave = async () => {
    if (!preview) return;
    setSaving(true); setSaveError(null); setResult(null);
    try {
      const r = await saveBoatraceData(preview.data.type, preview.data, file.name);
      const d = r.data;
      setResult(d);
      // 不完全取込はファイル/プレビューを残し、原因を確認して再実行できるようにする。
      if (d?.ok !== false) { setPreview(null); setFile(null); }
    } catch (e) {
      setSaveError(e?.response?.data?.error || e.message);
    }
    setSaving(false);
  };

  const handleBatchFiles = (selectedFiles) => {
    const list = Array.from(selectedFiles || []).filter(f => /\.txt$/i.test(f.name));
    if (!list.length) return;
    setFiles(list); setBatchMode(true); setBatchResults([]); setResult(null); setPreview(null); setParseError(null); setSaveError(null);
  };

  const handleBatchSave = async () => {
    if (!files.length || backgroundRunning) return;
    setSaveError(null);
    try {
      await startKBatchImport(files);
    } catch (e) {
      setSaveError(e?.message || "バックグラウンド取込を開始できませんでした");
    }
  };

  return (
    <div className="bg-white rounded-xl border-2 border-sky-300 p-4 space-y-3">
      <div className="flex gap-2">
        <button type="button" onClick={() => { setBatchMode(false); setFiles([]); setBatchResults([]); }} className={cn("px-3 py-1.5 rounded-lg text-xs font-bold", !batchMode ? "bg-sky-600 text-white" : "bg-slate-100 text-slate-600")}>B/K 1ファイル</button>
        <button type="button" onClick={() => { setBatchMode(true); setFile(null); setPreview(null); }} className={cn("px-3 py-1.5 rounded-lg text-xs font-bold", batchMode ? "bg-amber-500 text-white" : "bg-slate-100 text-slate-600")}>K過去結果 一括取込</button>
      </div>

      {/* ドロップゾーン */}
      <div
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => { e.preventDefault(); setDragOver(false); batchMode ? handleBatchFiles(e.dataTransfer.files) : (e.dataTransfer.files[0] && handleFile(e.dataTransfer.files[0])); }}
        onClick={() => document.getElementById(batchMode ? "txt-batch-input" : "txt-file-input").click()}
        className={cn(
          "border-2 border-dashed rounded-xl p-6 text-center cursor-pointer transition-colors",
          dragOver ? "border-sky-500 bg-sky-50" : "border-slate-300 bg-slate-50 hover:border-sky-400 hover:bg-sky-50/50"
        )}
      >
        <input id="txt-file-input" type="file" className="hidden" accept=".txt,.TXT" onChange={(e) => e.target.files[0] && handleFile(e.target.files[0])} />
        <input id="txt-batch-input" type="file" multiple className="hidden" accept=".txt,.TXT" onChange={(e) => handleBatchFiles(e.target.files)} />
        {batchMode && files.length > 0 ? (
          <div className="space-y-1">
            <History className="w-8 h-8 text-amber-500 mx-auto" />
            <div className="text-sm font-bold text-slate-800">Kファイル {files.length}件選択済み</div>
            <div className="text-[11px] text-slate-500">{files.slice(0, 3).map(f => f.name).join(" / ")}{files.length > 3 ? ` ほか${files.length - 3}件` : ""}</div>
          </div>
        ) : file ? (
          <div className="space-y-1">
            <FileText className="w-8 h-8 text-sky-600 mx-auto" />
            <div className="text-sm font-bold text-slate-800">{file.name}</div>
            <div className="text-[11px] text-slate-500">{(file.size / 1024).toFixed(1)}KB</div>
          </div>
        ) : (
          <div className="space-y-1">
            <Upload className="w-8 h-8 text-slate-400 mx-auto" />
            <div className="text-sm font-semibold text-slate-600">{batchMode ? "Kファイルをまとめてドロップ or 複数選択" : "TXTファイルをドロップ or クリックして選択"}</div>
            <div className="text-[11px] text-slate-400">{batchMode ? "過去結果Kファイル専用・複数ファイルを順番に登録" : "Bファイル(番組表) / Kファイル(結果) 自動判定"}</div>
          </div>
        )}
      </div>

      {batchMode && (files.length > 0 || backgroundRunning || batchProgress.total > 0) && (
        <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 space-y-2">
          <div className="flex items-center justify-between text-xs font-bold text-amber-800">
            <span>過去Kファイル一括取込</span><span>{backgroundRunning || batchProgress.total > 0 ? batchProgress.total : files.length}ファイル</span>
          </div>
          {backgroundRunning && <div className="text-xs text-amber-700 flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin" /> バックグラウンド取込中 {batchProgress.current}/{batchProgress.total} — {batchProgress.file}</div>}
          {backgroundRunning && <div className="text-[10px] text-amber-700 bg-white/70 rounded p-2">この管理画面から別ページへ移動しても取込は続きます。戻ると進捗を再表示します。</div>}
          <button onClick={handleBatchSave} disabled={backgroundRunning || files.length === 0} className="w-full h-10 rounded-lg bg-amber-500 text-white text-sm font-bold hover:bg-amber-600 disabled:opacity-50">
            {backgroundRunning ? `バックグラウンド取込中 ${batchProgress.current}/${batchProgress.total}` : files.length > 0 ? `${files.length}件のKファイルを一括登録` : "新しいKファイルを選択してください"}
          </button>
          {batchResults.length > 0 && (
            <div className="max-h-48 overflow-y-auto bg-white rounded-lg p-2 space-y-1">
              {batchResults.map((r, i) => (
                <div key={i} className={cn("text-[10px] border-b border-slate-100 last:border-0 py-1", r.ok ? "text-emerald-700" : "text-rose-700")}>
                  <div className="flex justify-between gap-2"><span>{r.ok ? "✓" : "⚠"} {r.file}</span><span>新{r.created}/更{r.updated}/飛{r.skipped}/エ{r.errors}</span></div>
                  <div className="text-[9px] text-slate-500">艇解析 {r.parsed_entries} / 履歴DB確認 {r.history_verified}/{r.history_target}</div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* パース中 */}
      {!batchMode && parsing && (
        <div className="flex items-center gap-2 text-sm text-sky-600">
          <Loader2 className="w-4 h-4 animate-spin" /> ファイル解析中…
        </div>
      )}

      {/* パースエラー */}
      {!batchMode && parseError && (
        <div className="bg-rose-50 border border-rose-200 rounded-lg p-3 flex items-start gap-2">
          <AlertTriangle className="w-4 h-4 text-rose-500 mt-0.5 shrink-0" />
          <div className="text-xs text-rose-700 whitespace-pre-line">{parseError}</div>
        </div>
      )}

      {/* プレビュー */}
      {!batchMode && preview && (
        <div className="bg-sky-50 border border-sky-200 rounded-xl p-3 space-y-2">
          <div className="flex items-center gap-1.5 text-sm font-bold text-sky-800">
            <CheckCircle2 className="w-4 h-4" /> 解析成功 — プレビュー
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-center">
            <PreviewStat label="ファイル種別" v={preview.preview.type} />
            <PreviewStat label="開催日" v={preview.preview.race_date || "—"} />
            <PreviewStat label="開催場数" v={preview.preview.venue_count || "—"} />
            <PreviewStat label="Race数" v={preview.preview.race_count} />
          </div>
          <div className="grid grid-cols-1 gap-2 text-center">
            <PreviewStat label={preview.data.type === "B" ? "RaceEntry数" : "結果艇数"} v={preview.preview.entry_count} />
          </div>
          {preview.preview.venues?.length > 0 && (
            <div className="bg-white rounded-lg p-2 space-y-1">
              <div className="text-[10px] font-bold text-slate-500 mb-1">会場別内訳</div>
              {preview.preview.venues.map((v, i) => (
                <div key={i} className="flex items-center justify-between text-[11px] py-0.5 border-b border-slate-100 last:border-0">
                  <span className="font-semibold text-slate-700">{v.venue_name}({v.venue_code})</span>
                  <span className="text-slate-500">{v.race_count}R / {v.entry_count}艇</span>
                </div>
              ))}
            </div>
          )}
          {preview.warnings?.length > 0 && (
            <div className="text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded p-2">
              ⚠ {preview.warnings.join(" / ")}
            </div>
          )}
          <button
            onClick={handleSave}
            disabled={saving}
            className="w-full h-10 rounded-lg bg-sky-600 text-white text-sm font-bold flex items-center justify-center gap-1.5 hover:bg-sky-700 disabled:opacity-50"
          >
            {saving ? <><Loader2 className="w-4 h-4 animate-spin" /> 登録中…</> : <><Zap className="w-4 h-4" /> DBへ登録</>}
          </button>
        </div>
      )}

      {/* 保存結果 */}
      {result && (
        <div className={cn("rounded-lg border p-3 space-y-1", result.ok === false ? "bg-rose-50 border-rose-200" : "bg-emerald-50 border-emerald-200")}>
          <div className={cn("flex items-center gap-1.5 text-sm font-bold", result.ok === false ? "text-rose-700" : "text-emerald-700")}>
            {result.ok === false ? <AlertTriangle className="w-4 h-4" /> : <CheckCircle2 className="w-4 h-4" />} {result.message || (result.ok === false ? "取込不完全" : "取込完了")}
          </div>
          <div className="grid grid-cols-4 gap-1 text-center text-[10px]">
            <div><div className="font-bold text-emerald-700 text-sm">{result.created}</div><div className="text-slate-500">新規</div></div>
            <div><div className="font-bold text-sky-700 text-sm">{result.updated}</div><div className="text-slate-500">更新</div></div>
            <div><div className="font-bold text-slate-600 text-sm">{result.skipped}</div><div className="text-slate-500">スキップ</div></div>
            <div><div className="font-bold text-rose-600 text-sm">{result.errors}</div><div className="text-slate-500">エラー</div></div>
          </div>
          {result.data_type === "K" && (
            <div className="grid grid-cols-4 gap-1 text-center text-[10px] pt-2 border-t border-slate-200">
              <div><div className="font-bold text-slate-800 text-sm">{result.total ?? 0}</div><div className="text-slate-500">結果R</div></div>
              <div><div className="font-bold text-slate-800 text-sm">{result.parsed_entries ?? 0}</div><div className="text-slate-500">解析艇数</div></div>
              <div><div className="font-bold text-sky-700 text-sm">{result.history_saved ?? 0}</div><div className="text-slate-500">保存処理</div></div>
              <div><div className={cn("font-bold text-sm", result.history_verified === result.history_target ? "text-emerald-700" : "text-rose-600")}>{result.history_verified ?? 0}/{result.history_target ?? 0}</div><div className="text-slate-500">DB実在確認</div></div>
            </div>
          )}
          {result.errorDetails?.length > 0 && (
            <div className="mt-2 pt-2 border-t border-emerald-200">
              <div className="text-[10px] font-bold text-rose-600 mb-1">エラー詳細(最大20件)</div>
              <div className="max-h-32 overflow-y-auto space-y-0.5">
                {result.errorDetails.slice(0, 20).map((e, i) => (
                  <div key={i} className="text-[10px] text-rose-700">{e}</div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
      {saveError && (
        <div className="bg-rose-50 border border-rose-200 rounded-lg p-2 flex items-start gap-1.5">
          <AlertTriangle className="w-4 h-4 text-rose-500 mt-0.5 shrink-0" />
          <span className="text-xs text-rose-700 break-all">{saveError}</span>
        </div>
      )}
    </div>
  );
}

function PreviewStat({ label, v }) {
  return (
    <div className="bg-white rounded-lg p-1.5">
      <div className="font-bold text-slate-800 text-sm">{v}</div>
      <div className="text-[10px] text-slate-500">{label}</div>
    </div>
  );
}

// === その他ファイル取込(AI抽出) ===
const importTypes = [
  { key: "race_card", label: "出走表", desc: "CSV/Excel/JSON", icon: FileSpreadsheet, accent: "sky" },
  { key: "racer_data", label: "選手データ", desc: "CSV/Excel/JSON", icon: Users, accent: "emerald" },
  { key: "past_results", label: "過去成績", desc: "CSV/Excel/JSON", icon: History, accent: "amber" },
  { key: "motor_boat", label: "モーター/ボート", desc: "CSV/Excel/JSON", icon: Cog, accent: "purple" },
];

const accentMap = {
  sky: "border-sky-200 bg-sky-50/50 text-sky-700",
  emerald: "border-emerald-200 bg-emerald-50/50 text-emerald-700",
  amber: "border-amber-200 bg-amber-50/50 text-amber-700",
  purple: "border-purple-200 bg-purple-50/50 text-purple-700",
};

function FileImportCard({ type }) {
  const { key, label, desc, icon: Icon, accent } = type;
  const [file, setFile] = useState(null);
  const [dragOver, setDragOver] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);

  const handleFile = (f) => { setFile(f); setResult(null); setError(null); };
  const handleImport = async () => {
    if (!file) return;
    setBusy(true); setResult(null); setError(null);
    try {
      const r = await importOfficialFile(key, file);
      setResult(r.data); setFile(null);
    } catch (e) { setError(e?.response?.data?.error || e.message); }
    setBusy(false);
  };

  return (
    <div className={cn("rounded-xl border p-3 space-y-2", accentMap[accent])}>
      <div className="flex items-center gap-2">
        <Icon className="w-4 h-4" />
        <div>
          <div className="font-bold text-xs">{label}</div>
          <div className="text-[10px] text-slate-500">{desc}</div>
        </div>
      </div>
      <div
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => { e.preventDefault(); setDragOver(false); if (e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]); }}
        onClick={() => document.getElementById(`file-${key}`).click()}
        className={cn("border-2 border-dashed rounded-lg p-2.5 text-center cursor-pointer transition-colors",
          dragOver ? "border-sky-400 bg-sky-50" : "border-slate-300 bg-white hover:border-slate-400")}
      >
        <input id={`file-${key}`} type="file" className="hidden" accept=".csv,.xlsx,.xls,.json,.html,.htm,.pdf" onChange={(e) => e.target.files[0] && handleFile(e.target.files[0])} />
        {file ? <div className="text-[11px] text-slate-700 font-medium truncate">{file.name}</div> : <div className="text-[11px] text-slate-400">ドロップ or 選択</div>}
      </div>
      <button onClick={handleImport} disabled={!file || busy} className="w-full h-8 rounded-lg bg-slate-900 text-white text-xs font-semibold flex items-center justify-center gap-1 hover:bg-slate-800 disabled:opacity-40">
        {busy ? <><Loader2 className="w-3.5 h-3.5 animate-spin" /> 取込中</> : <><Upload className="w-3.5 h-3.5" /> 取込</>}
      </button>
      {result && (
        <div className="bg-emerald-50 border border-emerald-200 rounded p-1.5 text-[10px] text-emerald-700">
          新{result.created} / 更{result.updated} / エラー{result.errors}
        </div>
      )}
      {error && <div className="text-[10px] text-rose-600 break-all">{error}</div>}
    </div>
  );
}