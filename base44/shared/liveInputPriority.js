// Live input collection helpers. These select work and describe saved evidence;
// they do not create predictions or decide BUY eligibility.
import { platformUtc, timeMs } from './liveV7Time.js';

const finiteNumber = value => {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string' || !/^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(value.trim())) return null;
  const parsed = Number(value.trim());
  return Number.isFinite(parsed) ? parsed : null;
};
const boatNumber = value => {
  const number = finiteNumber(value);
  return Number.isInteger(number) && number >= 1 && number <= 6 ? number : null;
};
const deadlineTime = value => typeof value === 'string'
  ? timeMs(platformUtc(value.trim())) : null;

/** Select only still-actionable races, nearest deadline first, without mutating input. */
export function selectLiveInputRaces(races, nowMs, { horizonMinutes = 60, cutoffMs = 90000 } = {}) {
  if (!Array.isArray(races) || !Number.isFinite(nowMs)
    || !Number.isFinite(horizonMinutes) || horizonMinutes <= 0
    || !Number.isFinite(cutoffMs) || cutoffMs < 0) return [];
  const cutoff = nowMs + cutoffMs, horizon = nowMs + horizonMinutes * 60000;
  return races.map((race, index) => ({ race, index, deadline: deadlineTime(race?.deadline) }))
    .filter(({ race, deadline }) => race && !['finished', 'cancelled'].includes(race.status)
      && deadline != null && deadline > cutoff && deadline <= horizon)
    .sort((a, b) => a.deadline - b.deadline || a.index - b.index)
    .map(({ race }) => race);
}

function hasObservedStart(entry) {
  const value = [entry.exhibition_st_raw, entry.exhibition_st]
    .find(item => item != null && !(typeof item === 'string' && !item.trim()));
  if (finiteNumber(value) != null) return true; // Includes exact zero and signed F values.
  if (typeof value !== 'string') return false;
  // L is an observed late start, not missing evidence. The forecast engine can
  // still hold the prediction; this helper must not convert L to a numeric ST.
  const text = value.trim();
  return /^L$/i.test(text) || /^F(?:\d+(?:\.\d+)?|\.\d+)$/i.test(text);
}

/**
 * Check the actual persisted rows after writes have been confirmed.
 * Do not pass freshly parsed source rows when their database write failed.
 * Every non-scratched boat must exist exactly once and have all three fields.
 */
export function isSavedExhibitionComplete(entries, scratchedBoats = []) {
  if (!Array.isArray(entries) || !Array.isArray(scratchedBoats)) return false;
  const excluded = new Set();
  for (const value of scratchedBoats) {
    const boat = boatNumber(value);
    if (boat == null) return false;
    excluded.add(boat);
  }
  const byBoat = new Map();
  for (const entry of entries) {
    const boat = boatNumber(entry?.boat_number);
    if (boat == null || byBoat.has(boat)) return false;
    byBoat.set(boat, entry);
    if (entry.is_absent || entry.is_scratched) excluded.add(boat);
  }
  const active = [1, 2, 3, 4, 5, 6].filter(boat => !excluded.has(boat));
  if (!active.length) return false;
  const courses = new Set();
  for (const boat of active) {
    const entry = byBoat.get(boat);
    if (!entry || !(finiteNumber(entry.exhibition_time) > 0) || !hasObservedStart(entry)) return false;
    const course = boatNumber(entry.exhibition_course);
    if (course == null || courses.has(course)) return false;
    courses.add(course);
  }
  return true;
}
