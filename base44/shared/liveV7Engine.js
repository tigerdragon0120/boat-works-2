// 統合V7の基盤エンジン(サーバー版)。
// ブラウザ版(src/liveV7/engine.js, policy.js, womens.js)と同じ計算を、
// パネルを開かなくても予想を保存できるようサーバー側へ移植したもの。
// 未学習・未校正の試験エンジン。SDK・時計・保存・通信の副作用は持たない。

const finite = (n) => typeof n === "number" && Number.isFinite(n);
const clamp = (v, min, max) => Math.min(max, Math.max(min, v));

export const V7_TRIAL_REVISION = "v7-live-trial-untrained-1";

export const FEATURE_SPECS = [
  { key: "national_win_rate", unit: "rating_points", stages: ["PRE", "FINAL"], range: [0, 10], weight: [1.0, 0.7, 0.6], score: (v) => v / 10 },
  { key: "local_win_rate", unit: "rating_points", stages: ["PRE", "FINAL"], range: [0, 10], weight: [0.6, 0.6, 0.6], score: (v) => v / 10 },
  { key: "avg_st", unit: "seconds", stages: ["PRE", "FINAL"], range: [0, 1], weight: [0.5, 0.3, 0.2], score: (v) => clamp((0.3 - v) / 0.3, 0, 1) },
  { key: "motor_f2_rate", unit: "percent", stages: ["PRE", "FINAL"], range: [0, 100], weight: [0.3, 0.3, 0.3], score: (v) => v / 100 },
  { key: "section_points", unit: "rating_points", stages: ["PRE", "FINAL"], range: [0, 10], weight: [0.4, 0.4, 0.4], score: (v) => v / 10 },
  { key: "exhibition_st", unit: "seconds", stages: ["FINAL"], range: [-1, 1], weight: [0.4, 0.2, 0.2], score: (v) => (v < 0 ? 0 : clamp((0.3 - v) / 0.3, 0, 1)) },
  { key: "exhibition_time", unit: "seconds", stages: ["FINAL"], range: [4, 10], weight: [0.6, 0.5, 0.4], score: (v) => (10 - v) / 6 },
];

// 研究用しきい値。凍結した予想と一緒に版管理する。運用BUY判定には使わない。
export const policy = {
  OPEN: { coverage: 0.8, oddsCoverage: 0.8, hit: 0.065, recovery: 1.12, watchHit: 0.035 },
  WOMENS: { coverage: 0.85, oddsCoverage: 0.85, hit: 0.075, recovery: 1.18, watchHit: 0.04,
    missingShrink: 1, alternativeRatio: 0.5, startDeltaWeight: 0.25 },
};

export function researchJudgment(model, stage, coverage, critical, plan) {
  const p = policy[model];
  if (!critical || coverage < 0.5) return "SKIP";
  const sizeAdjustment = Math.sqrt(plan.tickets.length / 8);
  if (stage === "FINAL" && plan.tickets.length >= 4 && coverage >= p.coverage && plan.oddsCoverage >= p.oddsCoverage &&
      plan.probability >= p.hit * sizeAdjustment && plan.expectedRecovery !== null &&
      plan.expectedRecovery >= p.recovery) return "BUY";
  return plan.probability >= p.watchHit * sizeAdjustment ? "WATCH" : "SKIP";
}

// V6.5由来の勝ち筋カバー。コース効果は未学習のため中立。
export function raceModel(race) {
  const title = [race?.series_name, race?.race_name].filter(Boolean).join(" ").trim();
  const womensTitle = /女子|レディース|ヴィーナス/i.test(title);
  if (race?.is_womens === true) return "WOMENS";
  if (race?.is_womens === false && womensTitle) return "UNKNOWN";
  if (womensTitle) return "WOMENS";
  // 既存Entityはis_womensを既定falseで持つ。タイトルが無い場合はスキーマ既定値の
  // 可能性があるため、判別不能をOPENにしない。
  return race?.is_womens === false && title ? "OPEN" : "UNKNOWN";
}

export function womensTickets(rows, count) {
  const bestByWinner = new Map();
  for (const row of rows) {
    const winner = row.combination.split("-")[0];
    if (!bestByWinner.has(winner)) bestByWinner.set(winner, row);
  }
  // 2人目の勝ち筋は、先頭買い目の確率の半分以上を保つ場合のみ採用する。
  const alternative = [...bestByWinner.values()][1];
  if (!alternative || alternative.probability < rows[0].probability * policy.WOMENS.alternativeRatio) return rows.slice(0, count);
  return [...new Set([...rows.slice(0, count - 1), alternative, ...rows])].slice(0, count);
}

function softmax(a) {
  const m = Math.max(...a);
  const v = a.map((x) => Math.exp(x - m));
  const s = v.reduce((x, y) => x + y, 0);
  return v.map((x) => x / s);
}

export function v7Trial(snapshot, stage) {
  if (!Number.isFinite(Date.parse(snapshot.as_of))) return { status: "UNAVAILABLE", reason: "入力時刻不明" };
  const missing = [];
  const warnings = [];
  const scores = new Map();
  const entries = snapshot.entries || [];
  const active = entries.filter((e) => !e.is_absent && !e.is_scratched && !(snapshot.race.scratched_boats || []).includes(e.boat_number));
  if (!["PRE", "FINAL"].includes(stage) || entries.length !== 6 || new Set(entries.map((e) => e.boat_number)).size !== 6 ||
      entries.some((e) => !Number.isInteger(e.boat_number) || e.boat_number < 1 || e.boat_number > 6) || active.length < 3) {
    return { status: "UNAVAILABLE", reason: "出走表または欠場情報の識別が不足" };
  }
  const courses = new Map();
  for (const e of active) {
    if (stage === "FINAL") {
      const at = snapshot.field_times?.[e.boat_number]?.exhibition_course ?? snapshot.captured_at;
      if (!Number.isFinite(Date.parse(at)) || Date.parse(at) > Date.parse(snapshot.as_of)) {
        return { status: "UNAVAILABLE", reason: "展示進入の時点が不明または未来" };
      }
    }
    const c = stage === "PRE" ? e.boat_number : e.exhibition_course;
    if (!Number.isInteger(c) || c < 1 || c > 6) return { status: "UNAVAILABLE", reason: "展示進入コース不足。FINALを枠番で補完しません" };
    courses.set(e.boat_number, c);
  }
  if (new Set(courses.values()).size !== active.length) return { status: "UNAVAILABLE", reason: "進入コースが重複" };
  let present = 0;
  let expected = 0;
  for (const e of active) {
    let used = 0;
    const logits = [0, 0, 0];
    for (const spec of FEATURE_SPECS) {
      if (!spec.stages.includes(stage)) continue;
      expected++;
      const value = e[spec.key];
      const unit = snapshot.units?.[spec.key];
      const available = snapshot.field_times?.[e.boat_number]?.[spec.key] ?? snapshot.captured_at;
      let reason = null;
      if (!finite(value)) reason = "欠損";
      else if (unit !== spec.unit) reason = "単位未確認";
      else if (value < spec.range[0] || value > spec.range[1]) reason = "範囲外";
      else if (!available || !snapshot.as_of || Date.parse(available) > Date.parse(snapshot.as_of) || !Number.isFinite(Date.parse(available))) reason = "時点不明/未来";
      if (reason) {
        missing.push(`${e.boat_number}号艇 ${spec.key}: ${reason}`);
        continue;
      }
      present++;
      used++;
      const v = spec.score(value);
      for (let i = 0; i < 3; i++) logits[i] += v * spec.weight[i];
      if (spec.key === "exhibition_st" && value < 0) warnings.push(`${e.boat_number}号艇 展示F ${value}秒：速いSTとして加点しません`);
    }
    if (!used) return { status: "UNAVAILABLE", reason: `${e.boat_number}号艇で単位・時点を確認できる評価項目がありません`, missing };
    // 宣言済みの試験プライア。実測統計でも学習係数でもない。
    for (let i = 0; i < 3; i++) logits[i] += [0.5, 0.15, 0.05][i] * (7 - courses.get(e.boat_number)) / 6;
    scores.set(e.boat_number, logits);
  }
  const boats = active.map((e) => e.boat_number).sort();
  const joint = [];
  const marginals = [0, 1, 2].map(() => Object.fromEntries(boats.map((b) => [b, 0])));
  const first = softmax(boats.map((b) => scores.get(b)[0]));
  boats.forEach((a, i) => {
    const seconds = boats.filter((b) => b !== a);
    const p2 = softmax(seconds.map((b) => scores.get(b)[1]));
    seconds.forEach((b, j) => {
      const thirds = boats.filter((c) => c !== a && c !== b);
      const p3 = softmax(thirds.map((c) => scores.get(c)[2]));
      thirds.forEach((c, k) => {
        const probability = first[i] * p2[j] * p3[k];
        const combination = `${a}-${b}-${c}`;
        joint.push({ combination, probability });
        [a, b, c].forEach((n, q) => { marginals[q][n] += probability; });
      });
    });
  });
  joint.sort((a, b) => b.probability - a.probability || a.combination.localeCompare(b.combination));
  const tickets = joint.slice(0, 8).map((r) => r.combination);
  const priced = tickets.map((k) => snapshot.oddsMap?.[k]);
  const hasOdds = priced.every((v) => finite(v) && v > 0);
  const expectedRecovery = hasOdds && stage === "FINAL"
    ? tickets.reduce((s, k, i) => s + joint.find((r) => r.combination === k).probability * priced[i], 0) / tickets.length
    : null;
  return {
    status: "READY", revision: V7_TRIAL_REVISION, method: "UNTRAINED_CONDITIONAL_BASELINE",
    judgment: "SKIP", judgment_reason: "未学習・未校正。既存BUYには使いません",
    combinations: joint, marginals, tickets, coverage: expected ? present / expected : 0, present, expected, missing, warnings, expectedRecovery,
    rank_hits_basis: "JOINT_MARGINAL_ARGMAX", confidence: "実績信頼度は未評価",
    course_basis: stage === "PRE" ? "枠番を用いた事前仮定" : "展示進入", formal_eligible: false,
  };
}