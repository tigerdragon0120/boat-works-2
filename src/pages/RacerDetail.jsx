import React, { useState, useEffect } from "react";
import { useParams, Link } from "react-router-dom";
import { getRacerDetailData } from "@/lib/dataManagementService";
import { ArrowLeft, Loader2, TrendingUp, TrendingDown, Minus, Award, Gauge, MapPin, Calendar } from "lucide-react";
import { cn } from "@/lib/utils";
import { LineChart, Line, XAxis, YAxis, ResponsiveContainer, Tooltip, ReferenceLine } from "recharts";

export default function RacerDetail() {
  const { reg } = useParams();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!reg) return;
    setLoading(true);
    getRacerDetailData(reg).then((d) => { setData(d); setLoading(false); }).catch(() => setLoading(false));
  }, [reg]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="w-8 h-8 animate-spin text-slate-400" />
      </div>
    );
  }

  if (!data || (!data.profile && !data.termStats.length)) {
    return (
      <div className="text-center py-20 space-y-3">
        <p className="text-slate-500">選手データが見つかりません: {reg}</p>
        <Link to="/admin" className="text-sky-600 text-sm">← 管理画面へ</Link>
      </div>
    );
  }

  const { profile, termStats, rollingStats, history } = data;
  const ts = rollingStats?.trend_scores || {};
  const currentTerm = rollingStats?.current_term || {};

  return (
    <div className="max-w-4xl mx-auto space-y-4 pb-8">
      {/* 戻る */}
      <Link to="/admin" className="inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-700">
        <ArrowLeft className="w-4 h-4" /> 管理画面へ
      </Link>

      {/* ヘッダー */}
      <div className="bg-white rounded-xl border border-slate-200 p-4">
        <div className="flex items-start justify-between flex-wrap gap-3">
          <div>
            <h1 className="text-xl font-bold text-slate-900">{profile?.racer_name || termStats[0]?.racer_name || "不明"}</h1>
            <div className="flex items-center gap-3 mt-1 text-sm text-slate-500">
              <span className="font-mono">登録番号: {reg}</span>
              {currentTerm.player_class && <span className={cn("px-2 py-0.5 rounded text-xs font-bold", classColor(currentTerm.player_class))}>{currentTerm.player_class}</span>}
              {profile?.branch_name && <span className="flex items-center gap-0.5"><MapPin className="w-3 h-3" />{profile.branch_name}</span>}
            </div>
          </div>
          {currentTerm.term_key && (
            <div className="text-right">
              <div className="text-xs text-slate-400">最新期</div>
              <div className="font-bold text-slate-700">{termLabel(currentTerm.term_key)}</div>
            </div>
          )}
        </div>
      </div>

      {/* トレンドスコア */}
      {rollingStats && (
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
          <TrendCard label="総合選手力" value={ts.racer_power_score} icon={Award} />
          <TrendCard label="直近調子" value={ts.recent_form_score} icon={TrendingUp} />
          <TrendCard label="ST推移" value={ts.st_trend_score} icon={Gauge} />
          <TrendCard label="級別推移" value={ts.class_trend_score} icon={Award} />
          <TrendCard label="コース成長" value={ts.course_trend_score} icon={TrendingUp} />
          <TrendCard label="総合成績推移" value={ts.performance_trend} icon={Calendar} />
        </div>
      )}

      {/* ローリング統計 */}
      {rollingStats && (
        <div className="bg-white rounded-xl border border-slate-200 p-4">
          <h2 className="text-sm font-bold text-slate-700 mb-3">期間別統計</h2>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            <PeriodStat label="直近6か月" stats={rollingStats.stats_6m} />
            <PeriodStat label="直近1年" stats={rollingStats.stats_1y} />
            <PeriodStat label="直近3年" stats={rollingStats.stats_3y} />
            <PeriodStat label="全期間" stats={rollingStats.stats_all} />
          </div>
        </div>
      )}

      {/* 勝率推移グラフ */}
      {termStats.length >= 2 && (
        <div className="bg-white rounded-xl border border-slate-200 p-4">
          <h2 className="text-sm font-bold text-slate-700 mb-3">勝率推移</h2>
          <ResponsiveContainer width="100%" height={200}>
            <LineChart data={termStats.map((t) => ({ term: termLabel(t.term_key), 勝率: t.win_rate }))}>
              <XAxis dataKey="term" tick={{ fontSize: 10 }} angle={-30} textAnchor="end" height={50} />
              <YAxis tick={{ fontSize: 10 }} domain={[0, "auto"]} />
              <Tooltip />
              <Line type="monotone" dataKey="勝率" stroke="#0ea5e9" strokeWidth={2} dot={{ r: 3 }} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* ST推移グラフ */}
      {termStats.length >= 2 && (
        <div className="bg-white rounded-xl border border-slate-200 p-4">
          <h2 className="text-sm font-bold text-slate-700 mb-3">平均ST推移</h2>
          <ResponsiveContainer width="100%" height={200}>
            <LineChart data={termStats.map((t) => ({ term: termLabel(t.term_key), ST: t.avg_st }))}>
              <XAxis dataKey="term" tick={{ fontSize: 10 }} angle={-30} textAnchor="end" height={50} />
              <YAxis tick={{ fontSize: 10 }} domain={[0, "auto"]} reversed />
              <Tooltip />
              <Line type="monotone" dataKey="ST" stroke="#8b5cf6" strokeWidth={2} dot={{ r: 3 }} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* 級別推移 */}
      {rollingStats?.class_history?.length >= 2 && (
        <div className="bg-white rounded-xl border border-slate-200 p-4">
          <h2 className="text-sm font-bold text-slate-700 mb-3">級別推移</h2>
          <div className="flex flex-wrap gap-1.5">
            {rollingStats.class_history.map((c, i) => (
              <div key={i} className="flex items-center gap-1">
                {i > 0 && <span className="text-slate-300 text-xs">→</span>}
                <span className={cn("px-2 py-1 rounded text-xs font-bold", classColor(c.player_class))}>
                  {c.player_class || "—"}
                </span>
                <span className="text-[10px] text-slate-400">{termLabel(c.term_key)}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 期別成績一覧 */}
      <div className="bg-white rounded-xl border border-slate-200 p-4">
        <h2 className="text-sm font-bold text-slate-700 mb-3">期別成績一覧 ({termStats.length}期)</h2>
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-slate-200 text-slate-500">
                <th className="text-left py-1.5 px-2">期</th>
                <th className="text-center py-1.5 px-2">級</th>
                <th className="text-right py-1.5 px-2">勝率</th>
                <th className="text-right py-1.5 px-2">2連率</th>
                <th className="text-right py-1.5 px-2">出走</th>
                <th className="text-right py-1.5 px-2">1着</th>
                <th className="text-right py-1.5 px-2">2着</th>
                <th className="text-right py-1.5 px-2">ST</th>
                <th className="text-right py-1.5 px-2">F</th>
              </tr>
            </thead>
            <tbody>
              {[...termStats].reverse().map((t) => (
                <tr key={t.id} className="border-b border-slate-100 hover:bg-slate-50">
                  <td className="py-1.5 px-2 font-medium text-slate-700">{termLabel(t.term_key)}</td>
                  <td className="py-1.5 px-2 text-center"><span className={cn("px-1.5 py-0.5 rounded text-[10px] font-bold", classColor(t.player_class))}>{t.player_class || "—"}</span></td>
                  <td className="py-1.5 px-2 text-right font-mono">{t.win_rate ?? "—"}</td>
                  <td className="py-1.5 px-2 text-right font-mono">{t.fukusho_rate != null ? `${t.fukusho_rate}%` : "—"}</td>
                  <td className="py-1.5 px-2 text-right font-mono">{t.race_count ?? "—"}</td>
                  <td className="py-1.5 px-2 text-right font-mono">{t.first_count ?? "—"}</td>
                  <td className="py-1.5 px-2 text-right font-mono">{t.second_count ?? "—"}</td>
                  <td className="py-1.5 px-2 text-right font-mono">{t.avg_st ?? "—"}</td>
                  <td className="py-1.5 px-2 text-right font-mono">{t.f_count ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function TrendCard({ label, value, icon: Icon }) {
  const v = value ?? 50;
  const color = v >= 65 ? "text-emerald-600" : v >= 45 ? "text-sky-600" : v >= 25 ? "text-amber-600" : "text-rose-600";
  const TrendIcon = v >= 55 ? TrendingUp : v <= 45 ? TrendingDown : Minus;
  return (
    <div className="bg-white rounded-xl border border-slate-200 p-3">
      <div className="flex items-center justify-between mb-1">
        <Icon className="w-3.5 h-3.5 text-slate-400" />
        <TrendIcon className={cn("w-3.5 h-3.5", color)} />
      </div>
      <div className={cn("text-lg font-bold", color)}>{v.toFixed(1)}</div>
      <div className="text-[10px] text-slate-500">{label}</div>
    </div>
  );
}

function PeriodStat({ label, stats }) {
  if (!stats || !stats.race_count) {
    return (
      <div className="bg-slate-50 rounded-lg p-2 text-center">
        <div className="text-[10px] text-slate-400 mb-1">{label}</div>
        <div className="text-xs text-slate-400">データ不足</div>
      </div>
    );
  }
  return (
    <div className="bg-slate-50 rounded-lg p-2 space-y-1">
      <div className="text-[10px] text-slate-500 text-center">{label}</div>
      <div className="grid grid-cols-2 gap-x-2 gap-y-0.5 text-[11px]">
        <div className="text-slate-500">出走</div><div className="text-right font-mono font-bold">{stats.race_count}</div>
        <div className="text-slate-500">勝率</div><div className="text-right font-mono">{stats.win_rate ?? "—"}%</div>
        <div className="text-slate-500">2連率</div><div className="text-right font-mono">{stats.top2_rate ?? "—"}%</div>
        <div className="text-slate-500">3連率</div><div className="text-right font-mono">{stats.top3_rate ?? "—"}%</div>
        <div className="text-slate-500">ST</div><div className="text-right font-mono">{stats.avg_st ?? "—"}</div>
      </div>
    </div>
  );
}

function termLabel(key) {
  if (!key) return "—";
  const [y, h] = key.split("_");
  return `${y}${h === "FIRST" ? "前期" : "後期"}`;
}

function classColor(cls) {
  const c = String(cls || "").toUpperCase();
  if (c === "A1") return "bg-rose-100 text-rose-700";
  if (c === "A2") return "bg-orange-100 text-orange-700";
  if (c === "B1") return "bg-sky-100 text-sky-700";
  if (c === "B2") return "bg-slate-100 text-slate-600";
  return "bg-slate-100 text-slate-500";
}