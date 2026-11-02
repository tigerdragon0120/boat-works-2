// ============================================================
// V6.5 勝率推計 — 予想と確定結果の比較から勝敗確率を出す
//  1. PredictionV65Verification で「予想セット的中率」と「実際の的中/不的中」を突き合わせる
//  2. 予想セット的中率を帯に分け、帯ごとの実測勝率を求める
//     (少数サンプルで0%/100%に振れないようラプラス補正をかける)
//  3. まだ結果が出ていない直近のV6.5予想は、その帯の実測勝率を勝率として推計する
// ============================================================
import { base44 } from "@/api/base44Client";

export const V65_PROBABILITY_BANDS = [
  { key: "b18", label: "〜18%", min: 0, max: 18 },
  { key: "b22", label: "18〜22%", min: 18, max: 22 },
  { key: "b26", label: "22〜26%", min: 22, max: 26 },
  { key: "b30", label: "26〜30%", min: 26, max: 30 },
  { key: "b34", label: "30〜34%", min: 30, max: 34 },
  { key: "b99", label: "34%〜", min: 34, max: 1000 },
];

// 帯の実測勝率を出すのに最低限必要なサンプル数
const MIN_BAND_SAMPLES = 3;

const round1 = (n) => (Number.isFinite(n) ? Math.round(n * 10) / 10 : null);

function bandOf(probability) {
  const p = Number(probability);
  if (!Number.isFinite(p)) return null;
  return V65_PROBABILITY_BANDS.find((b) => p >= b.min && p < b.max) || null;
}

function smoothedRate(hits, count) {
  if (!count) return null;
  return round1(((hits + 1) / (count + 2)) * 100);
}

function dedupeByRace(rows) {
  const seen = new Set();
  return (rows || []).filter((row) => {
    const key = row.race_key || row.race_id || row.id;
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function summarize(rows) {
  const count = rows.length;
  if (!count) return { count: 0, hits: 0, measured_rate: null, avg_predicted: null, calibration: null };
  const hits = rows.filter((r) => r.v65_recommended_hit === true).length;
  const avgPredicted = round1(rows.reduce((s, r) => s + Number(r.v65_set_probability || 0), 0) / count);
  const measured = round1((hits / count) * 100);
  return {
    count,
    hits,
    measured_rate: measured,
    avg_predicted: avgPredicted,
    calibration: avgPredicted > 0 ? Math.round((measured / avgPredicted) * 100) / 100 : null,
  };
}

function parseRaceKey(raceKey) {
  const parts = String(raceKey || "").split("_");
  return {
    race_date: /^\d{4}-\d{2}-\d{2}$/.test(parts[0] || "") ? parts[0] : "",
    venue_code: parts[1] || "",
    race_number: Number(parts[2] || 0),
  };
}

function todayJST() {
  return new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Tokyo" });
}

// periodDays=0 は全期間
export async function getV65WinProbability(periodDays = 90) {
  const query = periodDays
    ? { race_date: { $gte: new Date(Date.now() - periodDays * 86400000).toISOString().slice(0, 10) } }
    : {};

  const [verifications, pendingRows] = await Promise.all([
    base44.entities.PredictionV65Verification.filter(query, "-race_date", 1000).catch(() => []),
    base44.entities.PredictionV6.filter(
      { prediction_version: "v6.5", stage: "FINAL", status: "COMPLETED" }, "-computed_at", 80,
    ).catch(() => []),
  ]);

  const resolved = dedupeByRace(verifications).filter(
    (r) => typeof r.v65_recommended_hit === "boolean" && Number.isFinite(Number(r.v65_set_probability)),
  );
  const verifiedKeys = new Set(resolved.map((r) => String(r.race_key || r.race_id)));

  const bands = V65_PROBABILITY_BANDS.map((band) => {
    const rows = resolved.filter((r) => bandOf(r.v65_set_probability)?.key === band.key);
    const hits = rows.filter((r) => r.v65_recommended_hit === true).length;
    const rate = smoothedRate(hits, rows.length);
    const avgPredicted = rows.length
      ? round1(rows.reduce((s, r) => s + Number(r.v65_set_probability || 0), 0) / rows.length)
      : null;
    return {
      key: band.key,
      label: band.label,
      count: rows.length,
      hits,
      measured_rate: rate,
      avg_predicted: avgPredicted,
      gap: rate != null && avgPredicted != null ? round1(rate - avgPredicted) : null,
      reliable: rows.length >= MIN_BAND_SAMPLES,
    };
  });

  const buyRows = resolved.filter((r) => r.v65_final_judgment === "BUY");
  const overall = summarize(resolved);

  // 結果待ちのV6.5予想は、予想確率が入る帯の実測勝率で勝敗確率を推計する
  const today = todayJST();
  const pending = dedupeByRace(pendingRows)
    .filter((r) => {
      const key = String(r.race_key || "");
      return key && !verifiedKeys.has(key) && key.slice(0, 10) >= today;
    })
    .slice(0, 12)
    .map((r) => {
      const band = bands.find((b) => b.key === bandOf(r.set_probability)?.key);
      const estimated = band?.reliable ? band.measured_rate : round1(Number(r.set_probability));
      const parsed = parseRaceKey(r.race_key);
      return {
        id: r.id,
        race_key: r.race_key,
        ...parsed,
        judgment: r.final_judgment || null,
        set_probability: Number.isFinite(Number(r.set_probability)) ? round1(Number(r.set_probability)) : null,
        estimated_rate: estimated,
        estimate_source: band?.reliable ? `実測(${band.label}帯 ${band.count}R)` : "予想値",
        top_trifecta: r.top_trifecta || (r.selected_trifectas || [])[0] || null,
        selected_trifectas: r.selected_trifectas || [],
        ticket_count: r.ticket_count || null,
      };
    });

  const recent = resolved
    .slice()
    .sort((a, b) => String(b.race_date || "").localeCompare(String(a.race_date || "")))
    .slice(0, 10)
    .map((r) => ({
      id: r.id,
      race_date: r.race_date || parseRaceKey(r.race_key).race_date,
      venue_code: r.venue_code || parseRaceKey(r.race_key).venue_code,
      race_number: r.race_number || parseRaceKey(r.race_key).race_number,
      judgment: r.v65_final_judgment || null,
      set_probability: round1(Number(r.v65_set_probability)),
      predicted: r.v65_final_prediction || (r.v65_selected_trifectas || [])[0] || null,
      actual: r.actual_result || null,
      hit: r.v65_recommended_hit === true,
      ticket_count: r.v65_ticket_count || null,
    }));

  return {
    period_days: periodDays,
    total: resolved.length,
    overall,
    buy: summarize(buyRows),
    watch: summarize(resolved.filter((r) => r.v65_final_judgment === "WATCH")),
    skip: summarize(resolved.filter((r) => r.v65_final_judgment === "SKIP")),
    bands,
    pending,
    recent,
    sample_warning: resolved.length < 30,
  };
}