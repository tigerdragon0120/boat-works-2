import React, { useState } from "react";
import { importOfficialFile } from "@/lib/dataManagementService";
import { FileSpreadsheet, Users, History, Cog, Upload, CheckCircle2, AlertTriangle, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

const importTypes = [
  { key: "race_card", label: "出走表", desc: "開催日・場・レース番号・選手・モーター・成績", icon: FileSpreadsheet, accent: "sky" },
  { key: "racer_data", label: "選手データ", desc: "登録番号・級別・支部・成績・ST・F/L", icon: Users, accent: "emerald" },
  { key: "past_results", label: "過去成績", desc: "レース結果・着順・決まり手・ST・履歴蓄積", icon: History, accent: "amber" },
  { key: "motor_boat", label: "モーター/ボート", desc: "モーター番号・2連率・3連率・使用履歴", icon: Cog, accent: "purple" },
];

const accentMap = {
  sky: "border-sky-200 bg-sky-50/50 text-sky-700",
  emerald: "border-emerald-200 bg-emerald-50/50 text-emerald-700",
  amber: "border-amber-200 bg-amber-50/50 text-amber-700",
  purple: "border-purple-200 bg-purple-50/50 text-purple-700",
};

export default function FileImportSection() {
  return (
    <div className="space-y-3">
      <div>
        <h2 className="text-lg font-bold text-slate-900">公式ファイル取込</h2>
        <p className="text-xs text-slate-500 mt-0.5">オフィシャルサイトから取得したファイルをアップロードしてDBに展開します。CSV / Excel / JSON / HTML / PDF に対応。</p>
      </div>
      <div className="grid sm:grid-cols-2 gap-3">
        {importTypes.map((t) => (
          <FileImportCard key={t.key} type={t} />
        ))}
      </div>
    </div>
  );
}

function FileImportCard({ type }) {
  const { key, label, desc, icon: Icon, accent } = type;
  const [file, setFile] = useState(null);
  const [dragOver, setDragOver] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);

  const handleFile = (f) => {
    setFile(f);
    setResult(null);
    setError(null);
  };

  const handleImport = async () => {
    if (!file) return;
    setBusy(true); setResult(null); setError(null);
    try {
      const r = await importOfficialFile(key, file);
      setResult(r.data);
      setFile(null);
    } catch (e) {
      setError(e?.response?.data?.error || e.message);
    }
    setBusy(false);
  };

  return (
    <div className={cn("rounded-xl border p-3 space-y-2", accentMap[accent])}>
      <div className="flex items-center gap-2">
        <Icon className="w-5 h-5" />
        <div>
          <div className="font-bold text-sm">{label}ファイル取込</div>
          <div className="text-[10px] text-slate-500">{desc}</div>
        </div>
      </div>

      {/* ドロップゾーン */}
      <div
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => { e.preventDefault(); setDragOver(false); if (e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]); }}
        onClick={() => document.getElementById(`file-${key}`).click()}
        className={cn(
          "border-2 border-dashed rounded-lg p-3 text-center cursor-pointer transition-colors",
          dragOver ? "border-sky-400 bg-sky-50" : "border-slate-300 bg-white hover:border-slate-400"
        )}
      >
        <input id={`file-${key}`} type="file" className="hidden" accept=".csv,.xlsx,.xls,.json,.html,.htm,.pdf,.txt" onChange={(e) => e.target.files[0] && handleFile(e.target.files[0])} />
        {file ? (
          <div className="text-xs text-slate-700 font-medium truncate">{file.name}</div>
        ) : (
          <div className="text-xs text-slate-400">ファイルを選択またはドラッグ&ドロップ</div>
        )}
      </div>

      <button
        onClick={handleImport}
        disabled={!file || busy}
        className="w-full h-9 rounded-lg bg-slate-900 text-white text-sm font-semibold flex items-center justify-center gap-1.5 hover:bg-slate-800 disabled:opacity-40 disabled:cursor-not-allowed"
      >
        {busy ? <><Loader2 className="w-4 h-4 animate-spin" /> 取込中…</> : <><Upload className="w-4 h-4" /> 取込開始</>}
      </button>

      {/* 結果表示 */}
      {result && (
        <div className="bg-emerald-50 border border-emerald-200 rounded-lg p-2 space-y-1">
          <div className="flex items-center gap-1.5 text-xs font-bold text-emerald-700">
            <CheckCircle2 className="w-4 h-4" /> 取込完了
          </div>
          <div className="grid grid-cols-4 gap-1 text-center text-[10px]">
            <div><div className="font-bold text-emerald-700 text-sm">{result.created}</div><div className="text-slate-500">新規</div></div>
            <div><div className="font-bold text-sky-700 text-sm">{result.updated}</div><div className="text-slate-500">更新</div></div>
            <div><div className="font-bold text-slate-600 text-sm">{result.skipped}</div><div className="text-slate-500">スキップ</div></div>
            <div><div className="font-bold text-rose-600 text-sm">{result.errors}</div><div className="text-slate-500">エラー</div></div>
          </div>
          {result.message && <div className="text-[10px] text-slate-600">{result.message}</div>}
        </div>
      )}
      {error && (
        <div className="bg-rose-50 border border-rose-200 rounded-lg p-2 flex items-start gap-1.5">
          <AlertTriangle className="w-4 h-4 text-rose-500 mt-0.5 shrink-0" />
          <span className="text-xs text-rose-700 break-all">{error}</span>
        </div>
      )}
    </div>
  );
}