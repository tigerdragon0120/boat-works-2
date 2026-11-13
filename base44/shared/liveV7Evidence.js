// 統合V7の追加証拠(サーバー版)。ブラウザ版(src/liveV7/evidence.js)と同じ計算。
// 時点付き証拠のみを使う。コース別着順はそのコースでの着順回数、枠番過去10走は確定着順の配列。
import { timeMs } from "./liveV7Time.js";
import { policy } from "./liveV7Engine.js";

const fraction = (value) => Number.isFinite(value) && value >= 0 && value <= 100;

export function extraEvidence(snapshot, stage, model) {
  const scores = new Map();
  const missing = [];
  for (const row of snapshot.entries) {
    if (row.is_absent || row.is_scratched || snapshot.race.scratched_boats?.includes(row.boat_number)) continue;
    const evidence = row.v7_evidence;
    const at = timeMs(evidence?.acquired_at);
    const valid = at !== null && at <= timeMs(snapshot.as_of) && evidence.race_key === snapshot.race.race_key &&
      typeof evidence.source_ref === "string" && !!evidence.source_ref.trim();
    const course = stage === "PRE" ? row.boat_number : row.exhibition_course;
    const sample = valid && evidence.course?.number === course && evidence.course;
    const counts = sample && Number.isInteger(sample.n) && sample.n > 0 && Array.isArray(sample.rank_counts) &&
      sample.rank_counts.length === 3 && sample.rank_counts.every((x) => Number.isInteger(x) && x >= 0) &&
      sample.rank_counts.reduce((a, b) => a + b, 0) <= sample.n ? sample.rank_counts : null;
    const lane = valid && evidence.lane?.number === row.boat_number && evidence.lane.finishes;
    const form = Array.isArray(lane) && lane.length > 0 && lane.length <= 10 && lane.every((x) => Number.isInteger(x) && x >= 1 && x <= 6)
      ? lane.reduce((a, x) => a + (3.5 - x) / 5, 0) / (lane.length + 10) : null;
    const section = valid && evidence.section?.scale === "points_0_10" && Number.isFinite(evidence.section.points) &&
      evidence.section.points >= 0 && evidence.section.points <= 10 && Number.isInteger(snapshot.race.series_day) &&
      snapshot.race.series_day > 1 ? (evidence.section.points - 5) / 10 : null;
    const stTime = timeMs(snapshot.field_times?.[row.boat_number]?.exhibition_st ?? snapshot.captured_at);
    const start = model === "WOMENS" && stage === "FINAL" && stTime !== null && stTime <= timeMs(snapshot.as_of) &&
      snapshot.units?.avg_st === "seconds" && snapshot.units?.exhibition_st === "seconds" &&
      [row.avg_st, row.exhibition_st].every((x) => Number.isFinite(x) && x >= 0 && x <= 1)
      ? Math.max(-0.1, Math.min(0.1, row.avg_st - row.exhibition_st)) * policy.WOMENS.startDeltaWeight : 0;
    for (const [label, value] of [["コース別着順", counts], ["枠番過去10走", form], ["節間得点率", section], ["ボート2連率", fraction(row.boat_f2_rate) ? row.boat_f2_rate : null]]) {
      if (value === null) missing.push(`${row.boat_number}号艇 ${label}：確認できる入力なし`);
    }
    scores.set(row.boat_number, [0, 1, 2].map((rank) =>
      (counts ? 0.3 * (counts[rank] - sample.n / 6) / (sample.n + 24) : 0) +
      (form ?? 0) * 0.12 + (section ?? 0) * 0.12 + (fraction(row.boat_f2_rate) ? (row.boat_f2_rate - 50) / 100 * 0.12 : 0) + start / (rank + 1)));
  }
  return { missing, logit: (boat, rank) => scores.get(boat)?.[rank] ?? 0 };
}