import React, { useState, useCallback, useEffect } from "react";
import { parseRacerTermFileForPreview, rebuildRollingStats } from "@/lib/dataManagementService";
import { getRacerTermImportState, startRacerTermImport, subscribeRacerTermImport } from "@/lib/racerTermImportManager";
import { Users, Upload, CheckCircle2, AlertTriangle, Loader2, Zap, RefreshCw, FileText, TrendingUp } from "lucide-react";
import { cn } from "@/lib/utils";

export default function RacerTermImportCard() {
  const [files, setFiles] = useState([]);
  const [dragOver, setDragOver] = useState(false);
  const [parsing, setParsing] = useState(false);
  const [previews, setPreviews] = useState([]);
  const [parseErrors, setParseErrors] = useState([]);
  const initialImport = getRacerTermImportState();
  const [saving, setSaving] = useState(!!initialImport.running);
  const [progress, setProgress] = useState(initialImport.running ? { current: initialImport.current, total: initialImport.total, file: initialImport.file } : null);
  const [results, setResults] = useState(initialImport.results || []);
  const [rollingBusy, setRollingBusy] = useState(false);
  const [rollingResult, setRollingResult] = useState(null);

  const handleFiles = useCallback(async (fileList) => {
    const arr = Array.from(fileList).filter((f) => /\.(txt|csv|TXT|CSV)$/.test(f.name));
    if (!arr.length) return;
    setFiles(arr);
    setPreviews([]);
    setParseErrors([]);
    setResults([]);
    setParsing(true);

    const pv = [];
    const errs = [];
    for (const f of arr) {
      try {
        const r = await parseRacerTermFileForPreview(f);
        if (r.ok) {
          pv.push({ file: f, preview: r.preview, data: r.data, warnings: r.warnings || [] });
        } else {
          errs.push({ file: f.name, errors: r.errors });
        }
      } catch (e) {
        errs.push({ file: f.name, errors: [e.message] });
      }
    }
    setPreviews(pv);
    setParseErrors(errs);
    setParsing(false);
  }, []);

  useEffect(() => subscribeRacerTermImport((s) => {
    setSaving(!!s.running);
    setProgress(s.running || s.total ? { current: s.current, total: s.total, file: s.file } : null);
    setResults(s.results || []);
  }), []);

  const handleSave = async () => {
    if (!previews.length) return;
    setResults([]);
    try {
      await startRacerTermImport(previews);
      setPreviews([]);
      setFiles([]);
    } catch (e) {
      setResults([{ file: "期別成績一括取込", ok: false, error: e.message }]);
    }
  };

  const handleRebuildRolling = async () => {
    setRollingBusy(true);
    setRollingResult(null);
    try {
      const r = await rebuildRollingStats((p) => setProgress(p));
      setRollingResult(r);
    } catch (e) {
      setRollingResult({ ok: false, error: e.message });
    }
    setRollingBusy(false);
  };

  return (
    <div className="space-y-4">
      {/* アップロード */}
      <div
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => { e.preventDefault(); setDragOver(false); if (e.dataTransfer.files.length) handleFiles(e.dataTransfer.files); }}
        onClick={() => document.getElementById("term-file-input").click()}
        className={cn(
          "border-2 border-dashed rounded-xl p-6 text-center cursor-pointer transition-colors",
          dragOver ? "border-emerald-500 bg-emerald-50" : "border-slate-300 bg-slate-50 hover:border-emerald-400 hover:bg-emerald-50/50"
        )}
      >
        <input
          id="term-file-input"
          type="file"
          multiple
          className="hidden"
          accept=".txt,.TXT,.csv,.CSV"
          onChange={(e) => e.target.files.length && handleFiles(e.target.files)}
        />
        <Upload className="w-8 h-8 text-emerald-600 mx-auto mb-2" />
        <div className="text-sm font-bold text-slate-700">期別成績ファイルを一括ドロップ（複数可）</div>
        <div className="text-[11px] text-slate-500 mt-1">CP932/Shift-JIS対応・LZH解凍後のTXTファイル</div>
        <div className="text-[10px] text-slate-400 mt-0.5">2002年〜現在まで前期・後期ごとに投入可能</div>
      </div>

      {/* ファイルリスト */}
      {files.length > 0 && (
        <div className="bg-white rounded-lg border border-slate-200 p-3 space-y-1">
          <div className="text-xs font-bold text-slate-700 mb-1">選択ファイル ({files.length}件)</div>
          {files.map((f, i) => (
            <div key={i} className="flex items-center gap-2 text-xs text-slate-600">
              <FileText className="w-3.5 h-3.5 text-slate-400 shrink-0" />
              <span className="truncate">{f.name}</span>
              <span className="text-slate-400 shrink-0">{(f.size / 1024).toFixed(0)}KB</span>
            </div>
          ))}
        </div>
      )}

      {parsing && (
        <div className="flex items-center gap-2 text-sm text-emerald-600">
          <Loader2 className="w-4 h-4 animate-spin" /> パース中…
        </div>
      )}

      {/* パースエラー */}
      {parseErrors.length > 0 && (
        <div className="bg-rose-50 border border-rose-200 rounded-lg p-3 space-y-1">
          {parseErrors.map((e, i) => (
            <div key={i} className="flex items-start gap-1.5">
              <AlertTriangle className="w-3.5 h-3.5 text-rose-500 mt-0.5 shrink-0" />
              <div className="text-xs text-rose-700"><span className="font-bold">{e.file}:</span> {e.errors.join(", ")}</div>
            </div>
          ))}
        </div>
      )}

      {/* プレビュー */}
      {previews.length > 0 && (
        <div className="space-y-2">
          {previews.map((p, i) => (
            <div key={i} className="bg-emerald-50 border border-emerald-200 rounded-xl p-3 space-y-2">
              <div className="flex items-center gap-1.5 text-sm font-bold text-emerald-800">
                <CheckCircle2 className="w-4 h-4" /> {p.file.name}
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-center">
                <Stat label="選手数" v={p.preview.racer_count} />
                <Stat label="期" v={p.preview.terms_found.join(", ")} />
                <Stat label="文字コード" v={p.preview.encoding} />
                <Stat label="警告" v={p.preview.warnings} highlight={p.preview.warnings > 0} />
              </div>
              {p.preview.sample.length > 0 && (
                <div className="bg-white rounded-lg p-2 space-y-0.5">
                  <div className="text-[10px] font-bold text-slate-500 mb-1">サンプル（先頭3件）</div>
                  {p.preview.sample.map((s, j) => (
                    <div key={j} className="text-[10px] text-slate-600 flex gap-2">
                      <span className="font-mono">{s.registration_number}</span>
                      <span>{s.racer_name}</span>
                      <span className="text-slate-400">{s.term_key}</span>
                      <span className="text-slate-400">{s.player_class}</span>
                      <span className="text-slate-400">勝率{s.win_rate}</span>
                      <span className="text-slate-400">ST{s.avg_st}</span>
                    </div>
                  ))}
                </div>
              )}
              {p.warnings.length > 0 && (
                <div className="text-[10px] text-amber-700 bg-amber-50 border border-amber-200 rounded p-1.5">
                  ⚠ {p.warnings.slice(0, 3).join(" / ")}{p.warnings.length > 3 ? ` ...他${p.warnings.length - 3}件` : ""}
                </div>
              )}
            </div>
          ))}
          <button
            onClick={handleSave}
            disabled={saving}
            className="w-full h-11 rounded-lg bg-emerald-600 text-white text-sm font-bold flex items-center justify-center gap-1.5 hover:bg-emerald-700 disabled:opacity-50"
          >
            {saving ? <><Loader2 className="w-4 h-4 animate-spin" /> DBへ登録中…</> : <><Zap className="w-4 h-4" /> 全ファイル一括登録</>}
          </button>
        </div>
      )}

      {/* 保存結果 */}
      {results.length > 0 && (
        <div className="space-y-2">
          {results.map((r, i) => (
            <div key={i} className={cn("rounded-lg border p-3", r.ok ? "bg-emerald-50 border-emerald-200" : "bg-rose-50 border-rose-200")}>
              <div className="flex items-center gap-1.5 text-sm font-bold">
                {r.ok ? <CheckCircle2 className="w-4 h-4 text-emerald-600" /> : <AlertTriangle className="w-4 h-4 text-rose-500" />}
                <span className={r.ok ? "text-emerald-700" : "text-rose-700"}>{r.file}</span>
              </div>
              {r.ok ? (
                <div className="grid grid-cols-4 gap-1 text-center text-[10px] mt-1">
                  <div><div className="font-bold text-emerald-700 text-sm">{r.created}</div><div className="text-slate-500">新規</div></div>
                  <div><div className="font-bold text-sky-700 text-sm">{r.updated}</div><div className="text-slate-500">更新</div></div>
                  <div><div className="font-bold text-rose-600 text-sm">{r.errors}</div><div className="text-slate-500">エラー</div></div>
                  <div><div className="font-bold text-slate-600 text-sm">{r.total}</div><div className="text-slate-500">総数</div></div>
                </div>
              ) : (
                <div className="text-xs text-rose-600 mt-1">{r.error}</div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* ローリング統計再計算 */}
      <div className="pt-3 border-t border-slate-200">
        <div className="flex items-center gap-2 mb-2">
          <TrendingUp className="w-4 h-4 text-sky-600" />
          <h3 className="text-sm font-bold text-slate-700">ローリング統計再計算</h3>
        </div>
        <p className="text-[11px] text-slate-500 mb-2">全選手の6か月・1年・3年・全期間統計＋トレンドスコアを再計算します。</p>
        <button
          onClick={handleRebuildRolling}
          disabled={rollingBusy}
          className="w-full h-10 rounded-lg bg-sky-600 text-white text-sm font-bold flex items-center justify-center gap-1.5 hover:bg-sky-700 disabled:opacity-50"
        >
          {rollingBusy ? <><Loader2 className="w-4 h-4 animate-spin" /> 計算中… {progress ? `${progress.processed}/${progress.total}` : ""}</> : <><RefreshCw className="w-4 h-4" /> ローリング統計再計算</>}
        </button>
        {rollingResult && (
          <div className={cn("mt-2 rounded-lg border p-2 text-xs", rollingResult.ok ? "bg-sky-50 border-sky-200 text-sky-700" : "bg-rose-50 border-rose-200 text-rose-700")}>
            {rollingResult.ok
              ? `計算完了: ${rollingResult.computed}選手 / 新規${rollingResult.created} / 更新${rollingResult.updated}`
              : `エラー: ${rollingResult.error}`}
          </div>
        )}
      </div>
    </div>
  );
}

function Stat({ label, v, highlight }) {
  return (
    <div className={cn("bg-white rounded-lg p-1.5", highlight && "ring-1 ring-amber-300")}>
      <div className="font-bold text-slate-800 text-sm truncate">{v ?? "—"}</div>
      <div className="text-[10px] text-slate-500">{label}</div>
    </div>
  );
}