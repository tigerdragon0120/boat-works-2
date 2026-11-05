import { policy } from './policy.js';
// V6.5-inspired coverage of likely winners. Course effects are neutral until fitted.
export function raceModel(race) {
  const title = [race?.series_name, race?.race_name].filter(Boolean).join(' ').trim();
  const womensTitle = /女子|レディース|ヴィーナス/i.test(title);
  if (race?.is_womens === true) return 'WOMENS';
  if (race?.is_womens === false && womensTitle) return 'UNKNOWN';
  if (womensTitle) return 'WOMENS';
  // The legacy Entity supplies false by default. Without a title it may only
  // be the schema default, so a missing classification cannot become OPEN.
  return race?.is_womens === false && title ? 'OPEN' : 'UNKNOWN';
}

export function womensTickets(rows, count) {
  const bestByWinner = new Map();
  for (const row of rows) {
    const winner = row.combination.split('-')[0];
    if (!bestByWinner.has(winner)) bestByWinner.set(winner, row);
  }
  // Reserve a second winner only if its best ticket retains at least half the
  // leading ticket's probability. This is an experimental selection rule.
  const alternative = [...bestByWinner.values()][1];
  if (!alternative || alternative.probability < rows[0].probability * policy.WOMENS.alternativeRatio) return rows.slice(0, count);
  return [...new Set([...rows.slice(0, count - 1), alternative, ...rows])].slice(0, count);
}