import React, { useState } from "react";
import { importOfficialFile, saveBoatraceData } from "@/lib/dataManagementService";
import { parseBoatraceFile } from "@/lib/boatraceFileParser";
import { FileSpreadsheet, Users, History, Cog, Upload, CheckCircle2, AlertTriangle, Loader2, FileText, Zap } from "lucide-react";
import { cn } from "@/lib/utils";

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

      {/* 副次: その他ファイル取込 */}
      <div className="pt-4 border-t border-slate-200">
        <div className="flex items-center gap-2 mb-2">
          <Upload className="w-4 h-4 text-slate-500" />
          <h3 className="text-sm font-bold text-slate-700">その他ファイル取込(CSV / Excel / JSON)</h3>
        </div>
        <p className="text-[11px] text-slate-400 mb-3">AI抽出による汎用ファイル取込。競艇TXT以外のデータに使用。</p>
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
  const [dragOver, setDragOver] = useState(false);
  const [parsing, setParsing] = useState(false);
  const [preview, setPreview] = useState(null);
  const [parseError, setParseError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState(null);
  const [saveError, setSaveError] = useState(null);

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
      setResult(r.data);
      setPreview(null); setFile(null);
    } catch (e) {
      setSaveError(e?.response?.data?.error || e.message);
    }
    setSaving(false);
  };

  return (
    <div className="bg-white rounded-xl border-2 border-sky-300 p-4 space-y-3">
      {/* ドロップゾーン */}
      <div
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => { e.preventDefault(); setDragOver(false); if (e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]); }}
        onClick={() => document.getElementById("txt-file-input").click()}
        className={cn(
          "border-2 border-dashed rounded-xl p-6 text-center cursor-pointer transition-colors",
          dragOver ? "border-sky-500 bg-sky-50" : "border-slate-300 bg-slate-50 hover:border-sky-400 hover:bg-sky-50/50"
        )}
      >
        <input id="txt-file-input" type="file" className="hidden" accept=".txt,.TXT" onChange={(e) => e.target.files[0] && handleFile(e.target.files[0])} />
        {file ? (
          <div className="space-y-1">
            <FileText className="w-8 h-8 text-sky-600 mx-auto" />
            <div className="text-sm font-bold text-slate-800">{file.name}</div>
            <div className="text-[11px] text-slate-500">{(file.size / 1024).toFixed(1)}KB</div>
          </div>
        ) : (
          <div className="space-y-1">
            <Upload className="w-8 h-8 text-slate-400 mx-auto" />
            <div className="text-sm font-semibold text-slate-600">TXTファイルをドロップ or クリックして選択</div>
            <div className="text-[11px] text-slate-400">Bファイル(番組表) / Kファイル(結果) 自動判定</div>
          </div>
        )}
      </div>

      {/* パース中 */}
      {parsing && (
        <div className="flex items-center gap-2 text-sm text-sky-600">
          <Loader2 className="w-4 h-4 animate-spin" /> ファイル解析中…
        </div>
      )}

      {/* パースエラー */}
      {parseError && (
        <div className="bg-rose-50 border border-rose-200 rounded-lg p-3 flex items-start gap-2">
          <AlertTriangle className="w-4 h-4 text-rose-500 mt-0.5 shrink-0" />
          <div className="text-xs text-rose-700 whitespace-pre-line">{parseError}</div>
        </div>
      )}

      {/* プレビュー */}
      {preview && (
        <div className="bg-sky-50 border border-sky-200 rounded-xl p-3 space-y-2">
          <div className="flex items-center gap-1.5 text-sm font-bold text-sky-800">
            <CheckCircle2 className="w-4 h-4" /> 解析成功 — プレビュー
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-center">
            <PreviewStat label="ファイル種別" v={preview.preview.type} />
            <PreviewStat label="開催日" v={preview.preview.race_date || "—"} />
            <PreviewStat label="場" v={preview.preview.venue || "—"} />
            <PreviewStat label="Race数" v={preview.preview.race_count} />
          </div>
          <div className="grid grid-cols-2 gap-2 text-center">
            <PreviewStat label={preview.data.type === "B" ? "RaceEntry数" : "結果艇数"} v={preview.preview.entry_count} />
            <PreviewStat label="想定" v={preview.data.type === "B" ? "12R / 72艇" : "12R結果"} />
          </div>
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
        <div className="bg-emerald-50 border border-emerald-200 rounded-lg p-3 space-y-1">
          <div className="flex items-center gap-1.5 text-sm font-bold text-emerald-700">
            <CheckCircle2 className="w-4 h-4" /> {result.message || "取込完了"}
          </div>
          <div className="grid grid-cols-4 gap-1 text-center text-[10px]">
            <div><div className="font-bold text-emerald-700 text-sm">{result.created}</div><div className="text-slate-500">新規</div></div>
            <div><div className="font-bold text-sky-700 text-sm">{result.updated}</div><div className="text-slate-500">更新</div></div>
            <div><div className="font-bold text-slate-600 text-sm">{result.skipped}</div><div className="text-slate-500">スキップ</div></div>
            <div><div className="font-bold text-rose-600 text-sm">{result.errors}</div><div className="text-slate-500">エラー</div></div>
          </div>
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