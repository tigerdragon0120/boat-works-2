// ============================================================
// V6.5 キャリブレーション — 日次検証の結果を予想へ還元する
//
// 1. PredictionV65Verification から「予想セット的中率」と「実際の的中/不的中」を集計
// 2. 予想セット的中率を帯に分け、帯ごとの実測勝率を求める(ラプラス補正つき)
// 3. 次回の予想では、判定に使うセット的中率を帯の実測勝率へ半分だけ寄せる
//    (急に判定が振れないよう50%ブレンド、サンプル不足の帯は補正しない)
// ============================================================

export const V65_BANDS = [
  { key: "b18", label: "〜18%", min: 0, max: 18 },
  { key: "b22", label: "18〜22%", min: 18, max: 22 },
  { key: "b26", label: "22〜26%", min: 22, max: 26 },
  { key: "b30", label: "26〜30%", min: 26, max: 30 },
  { key: "b34", label: "30〜34%", min: 30, max: 34 },
  { key: "b99", label: "34%〜", min: 34, max: 1000 },
];

// 帯の実測勝率を補正に使うのに必要な最低サンプル数
const MIN_BAND_SAMPLES = 5;
// 実測へ寄せる割合(0.5 = 半分)
const BLEND = 0.5;
const CACHE_TTL_MS = 5 * 60 * 1000;

const round1 = (n) => (Number.isFinite(n) ? Math.round(n * 10) / 10 : null);
const round2 = (n) => (Number.isFinite(n) ? Math.round(n * 100) / 100 : null);

export function bandOf(probability) {
  const p = Number(probability);
  if (!Number.isFinite(p)) return null;
  return V65_BANDS.find((b) => p >= b.min && p < b.max) || null;
}

function smoothedRate(hits, count) {
  if (!count) return null;
  return round1(((hits + 1) / (count + 2)) * 100);
}

function dedupeByRace(rows) {
  const seen = new Set();
  const out = [];
  for (const row of rows || []) {
    const key = row?.race_key || row?.race_id || row?.id;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
}

// ============================================================
// 検証データから補正値を計算(純粋関数)
// ============================================================
export function buildCalibrationStats(rows) {
  const resolved = dedupeByRace(rows).filter(
    (r) => typeof r?.v65_recommended_hit === "boolean" && Number.isFinite(Number(r?.v65_set_probability)),
  );

  const bands = V65_BANDS.map((band) => {
    const list = resolved.filter((r) => bandOf(r.v65_set_probability)?.key === band.key);
    const hits = list.filter((r) => r.v65_recommended_hit === true).length;
    return {
      key: band.key,
      label: band.label,
      count: list.length,
      hits,
      measured_rate: smoothedRate(hits, list.length),
      avg_predicted: list.length
        ? round1(list.reduce((s, r) => s + Number(r.v65_set_probability || 0), 0) / list.length)
        : null,
      reliable: list.length >= MIN_BAND_SAMPLES,
    };
  });

  const total = resolved.length;
  const hits = resolved.filter((r) => r.v65_recommended_hit === true).length;
  const avgPredicted = total
    ? round1(resolved.reduce((s, r) => s + Number(r.v65_set_probability || 0), 0) / total)
    : null;
  const measured = total ? round1((hits / total) * 100) : null;

  return {
    sample_count: total,
    hits,
    measured_rate: measured,
    avg_predicted: avgPredicted,
    calibration_factor: avgPredicted ? round2(measured / avgPredicted) : null,
    bands,
  };
}

// ============================================================
// 判定に使うセット的中率を補正する
// ============================================================
export function calibrateSetProbability(value, calibration) {
  const raw = Number(value);
  if (!Number.isFinite(raw)) return { value: null, raw: null, applied: false, band: null };
  const band = bandOf(raw);
  const row = (calibration?.bands || []).find((b) => b.key === band?.key);
  if (!band || !row || !row.reliable || row.measured_rate == null) {
    return { value: raw, raw, applied: false, band: band?.label ?? null };
  }
  const blended = round1(raw * (1 - BLEND) + row.measured_rate * BLEND);
  return {
    value: blended,
    raw,
    applied: true,
    band: row.label,
    measured_rate: row.measured_rate,
    sample_count: row.count,
  };
}

// ============================================================
// 最新の補正値を取得(予想生成時に使う・5分キャッシュ)
// ============================================================
let cache = { at: 0, value: null };

export async function loadV65Calibration(client, { force = false } = {}) {
  if (!force && cache.value && Date.now() - cache.at < CACHE_TTL_MS) return cache.value;
  try {
    const rows = await client.asServiceRole.entities.EngineCalibration.filter(
      { engine: "v6.5" }, "-computed_at", 1,
    );
    cache = { at: Date.now(), value: rows?.[0] || null };
    return cache.value;
  } catch (e) {
    console.error("[V6.5 CALIBRATION] load failed:", e?.message || e);
    return cache.value || null;
  }
}

// ============================================================
// 検証結果から補正値を再計算して保存
// ============================================================
export async function rebuildV65Calibration(client, { lookbackDays = 90 } = {}) {
  const sr = client.asServiceRole.entities;
  const since = new Date(Date.now() - lookbackDays * 86400000).toISOString().slice(0, 10);
  const rows = await sr.PredictionV65Verification.filter(
    { race_date: { $gte: since } }, "-race_date", 1000,
  ).catch(() => []);

  const stats = buildCalibrationStats(rows);
  const doc = {
    engine: "v6.5",
    ...stats,
    lookback_days: lookbackDays,
    computed_at: new Date().toISOString(),
  };

  const existing = await sr.EngineCalibration.filter({ engine: "v6.5" }, "-computed_at", 1).catch(() => []);
  const saved = existing?.[0]
    ? await sr.EngineCalibration.update(existing[0].id, doc)
    : await sr.EngineCalibration.create(doc);

  cache = { at: Date.now(), value: saved || doc };
  return { ...stats, id: saved?.id || null, lookback_days: lookbackDays };
}