const clamp = (n, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, Number.isFinite(n) ? n : lo));
const num = (v, fallback = null) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};
const pct = (v, fallback = 50) => {
  const n = num(v);
  if (n == null) return fallback;
  return clamp(n <= 1 ? n * 100 : n);
};
const grade = (v) => ({ A1: 100, A2: 80, B1: 58, B2: 35 }[String(v || "").toUpperCase()] || 52);
const stScore = (v) => {
  const n = num(v);
  return n == null ? 50 : clamp(82 - (n - 0.10) * 260, 15, 100);
};
const softmax = (rows, temperature = 16) => {
  const max = Math.max(...rows.map(x => x.score));
  const exps = rows.map(x => Math.exp((x.score - max) / temperature));
  const sum = exps.reduce((a, b) => a + b, 0) || 1;
  const raw = exps.map(x => x / sum * 100);
  const rounded = raw.map(Math.round);
  const diff = 100 - rounded.reduce((a, b) => a + b, 0);
  if (rounded.length) rounded[raw.indexOf(Math.max(...raw))] += diff;
  return rows.map((x, i) => ({ ...x, probability: rounded[i] }));
};

function normalizeEntries(entries = [], activePred) {
  const rawScores = activePred?.boat_scores || [];
  return [1, 2, 3, 4, 5, 6].map(boat => {
    const e = entries.find(x => Number(x.boat_number) === boat) || {};
    const s = rawScores.find(x => Number(x.boat_number) === boat) || {};
    const cls = e.player_class || e.grade_class;
    const avgSt = num(e.section_st, num(e.avg_st));
    const exSt = num(e.exhibition_st);
    const motor = pct(e.motor_f2_rate ?? e.motor_2rate, 45);
    const national = clamp((num(e.national_win_rate, 5) || 5) * 10);
    const local = clamp((num(e.local_win_rate, 5) || 5) * 10);
    const laneWin = pct(e._laneRecent?.win_rate ?? e.lane_recent_win_rate, boat === 1 ? 52 : 12);
    const finalScore = num(s.final_score, num(s.pre_score, 50));
    const firstScore = num(s.first_score, finalScore);
    const recentScore = num(s.recent_score, 50);
    const todayScore = num(s.today_score, finalScore);
    const exhibitionRank = num(e.exhibition_rank);
    const exhibition = exhibitionRank != null ? clamp(108 - exhibitionRank * 13) : 50;
    return {
      boat, entry: e, cls, avgSt, exSt, motor, national, local, laneWin,
      finalScore, firstScore, recentScore, todayScore, exhibition,
      start: stScore(exSt ?? avgSt),
      isOuterA1: boat >= 4 && String(cls || "").toUpperCase() === "A1",
    };
  });
}

export function buildV5ScenarioForecast(entries = [], activePred = null) {
  const b = normalizeEntries(entries, activePred);
  const one = b[0];
  const innerWall = (b[1].start + b[2].start + b[1].finalScore + b[2].finalScore) / 4;
  const insideDefense = clamp(
    one.laneWin * 0.24 + one.firstScore * 0.20 + one.start * 0.14 +
    one.motor * 0.10 + one.exhibition * 0.10 + grade(one.cls) * 0.12 +
    innerWall * 0.10
  );

  const outside = b.slice(3).map(x => {
    const lanePenalty = { 4: 5, 5: 13, 6: 21 }[x.boat] || 0;
    const a1Bonus = x.isOuterA1 ? 7 : 0;
    const weakness = clamp(100 - insideDefense);
    const attack = clamp(
      x.firstScore * 0.18 + x.start * 0.18 + x.motor * 0.11 +
      x.exhibition * 0.12 + x.recentScore * 0.12 + x.todayScore * 0.12 +
      grade(x.cls) * 0.09 + weakness * 0.16 + a1Bonus - lanePenalty
    );
    return { ...x, attack };
  });
  const outsideAttack = Math.max(...outside.map(x => x.attack), 0);
  const strongestOuter = outside.sort((a, b2) => b2.attack - a.attack)[0];

  const s = [];
  s.push({
    key: "1_ESCAPE", label: "1号艇 逃げ", score: insideDefense + 12,
    followers: [2, 3, 4],
    reason: `イン防御${insideDefense.toFixed(0)}。1号艇の枠実績・ST・内側の壁を総合`,
  });

  const two = b[1], three = b[2], four = b[3], five = b[4], six = b[5];
  const innerWeakness = clamp(100 - insideDefense);
  const attackBase = x => x.firstScore * 0.22 + x.start * 0.22 + x.todayScore * 0.16 + x.recentScore * 0.12 + innerWeakness * 0.18 + grade(x.cls) * 0.10;

  s.push({ key: "2_SASHI", label: "2号艇 差し", score: attackBase(two) + 4, followers: [1, 4, 3], reason: "2号艇の差し残り。1号艇残しと4号艇追走を優先" });
  s.push({ key: "2_MAKURI", label: "2号艇 直まくり", score: attackBase(two) + (two.start - one.start) * 0.32 - 3, followers: [4, 3, 5], reason: "2号艇のST優位から2-4・4-2筋を評価" });

  const pressure34 = ((three.start + four.start) / 2) - ((three.firstScore + four.firstScore) / 2);
  s.push({
    key: "2_LATE_SASHI", label: "2号艇 遅れ差し", score: attackBase(two) + clamp(pressure34, -12, 12) + five.todayScore * 0.05 - 5,
    followers: [5, 1, 4], reason: "3・4号艇の攻め不発時に2号艇が差し、5号艇が展開を拾う2-5・5-2筋",
  });

  s.push({ key: "3_MAKURI", label: "3号艇 まくり", score: attackBase(three) + (three.start - two.start) * 0.22 - 2, followers: [4, 5, 1], reason: "3号艇の攻めに4号艇が追走" });
  s.push({ key: "3_MAKURIZASHI", label: "3号艇 まくり差し", score: attackBase(three) + three.recentScore * 0.06, followers: [1, 4, 5], reason: "3号艇が内を差し、1号艇が残る筋" });

  [
    [four, 4], [five, 5], [six, 6],
  ].forEach(([x, lane]) => {
    const outer = outside.find(o => o.boat === lane);
    const extremeWeakBonus = insideDefense < 48 ? (48 - insideDefense) * 0.8 : -(insideDefense - 48) * 0.45;
    const gradeText = x.isOuterA1 ? "外枠A1。ただし級別だけでは頭固定しない" : "外枠攻撃力を評価";
    s.push({
      key: `${lane}_MAKURI`, label: `${lane}号艇 まくり`,
      score: outer.attack + extremeWeakBonus - (lane === 4 ? 2 : lane === 5 ? 8 : 15),
      followers: lane === 4 ? [5, 6, 1] : lane === 5 ? [6, 1, 2] : [1, 2, 5],
      reason: `${gradeText}。イン防御${insideDefense.toFixed(0)}対外攻撃${outer.attack.toFixed(0)}`,
    });
    s.push({
      key: `${lane}_MAKURIZASHI`, label: `${lane}号艇 まくり差し`,
      score: outer.attack + extremeWeakBonus - (lane === 4 ? 1 : lane === 5 ? 6 : 12),
      followers: lane === 4 ? [1, 5, 2] : lane === 5 ? [1, 6, 2] : [1, 2, 5],
      reason: `${gradeText}。内艇を残す外攻め筋`,
    });
  });

  const scenarios = softmax(s).sort((a, b2) => b2.probability - a.probability);
  const outerA1 = b.filter(x => x.isOuterA1).map(x => x.boat);
  const verdict = outsideAttack >= insideDefense + 8
    ? `外攻め優勢（${strongestOuter.boat}号艇）`
    : insideDefense >= outsideAttack + 8
      ? "イン逃げ優勢"
      : "イン逃げと外攻めが拮抗";

  return {
    scenarios,
    insideDefense: Math.round(insideDefense),
    outsideAttack: Math.round(outsideAttack),
    strongestOuter: strongestOuter?.boat || null,
    outerA1,
    verdict,
    note: outerA1.length
      ? `${outerA1.join("・")}号艇にA1配置。番組意図を検知したが、イン弱化と展示裏付けがある時だけ外頭を上げる`
      : "外枠A1の特別配置なし",
  };
}
