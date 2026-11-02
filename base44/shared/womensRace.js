// ============================================================
// 女子戦判定
// 競艇の女子戦は「オールレディース」「ヴィーナスシリーズ」
// 「レディースチャンピオン」などの大会名で開催される。
// 公式番組表の大会名をRace.series_nameへ保存し、この判定でV6.5の対象にする。
// ============================================================

const WOMENS_PATTERN = /女子|レディース|ヴィーナス|クイーンズ|レデイース/i;

export function isWomenSeriesName(name) {
  const text = String(name || "");
  if (!text) return false;
  return WOMENS_PATTERN.test(text);
}

// Raceレコードから女子戦かどうかを判定する。
// is_womens(保存済みフラグ) → 大会名/レース名の順に確認する。
export function isWomensRace(race) {
  if (!race) return false;
  if (race.is_womens === true) return true;
  if (race.is_womens === false && !race.series_name && !race.event_name) return false;
  return isWomenSeriesName([race.series_name, race.event_name, race.race_name].filter(Boolean).join(" "));
}