// 生成直前専用。古いRaceへのフォールバックはしない。
import { timeMs } from './liveV7Time.js';

export async function refreshRaceForGeneration(sr, expected, timeoutMs = 10000) {
  let timer;
  try {
    const race = await Promise.race([
      sr.Race.get(expected.id),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('race_refresh_timeout')), timeoutMs);
      }),
    ]);
    if (!race || Array.isArray(race) || race.id !== expected.id || race.race_key !== expected.race_key) {
      return { status: 'UNKNOWN', reason: 'race_refresh_empty_or_invalid' };
    }
    const deadline = timeMs(race.deadline);
    if (deadline == null || !['scheduled', 'pre', 'final', 'finished', 'cancelled'].includes(race.status)) {
      return { status: 'UNKNOWN', reason: 'race_refresh_metadata_invalid' };
    }
    if (deadline <= Date.now()) return { status: 'BLOCKED', reason: 'deadline_passed', race };
    if (['finished', 'cancelled'].includes(race.status)) return { status: 'BLOCKED', reason: 'race_closed', race };
    return { status: 'READY', race };
  } catch (error) {
    return { status: 'UNKNOWN', reason: error?.message === 'race_refresh_timeout' ? 'race_refresh_timeout' : 'race_refresh_failed' };
  } finally {
    clearTimeout(timer);
  }
}