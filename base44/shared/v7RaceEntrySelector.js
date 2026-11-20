// 重複したRaceEntryを予想生成時だけ6艇に整理する。
// 元のRaceEntryは一切変更しない。艇の人物識別が矛盾すれば予想生成を見送る。
// 同じ艇の複数行は更新時刻が最も新しい行を使い、古い展示値の混入を防ぐ。
const timestamp = (value) => {
  if (typeof value !== 'string' || !value) return -Infinity;
  const normalized = /(Z|[+-]\d{2}:?\d{2})$/.test(value) ? value : value + 'Z';
  const ms = Date.parse(normalized);
  return Number.isFinite(ms) ? ms : -Infinity;
};
const regNo = (r) => String(r.register_number || r.registration_number || '').trim();

export function selectV7RaceEntries(entries, race) {
  if (!race?.id || !race?.race_key || !Array.isArray(entries)) {
    return { entries: [], reason: 'entry_source_unknown' };
  }
  const groups = new Map();
  for (const row of entries) {
    if (!row || row.race_id !== race.id || (row.race_key && row.race_key !== race.race_key)) continue;
    const boat = Number(row.boat_number);
    if (!Number.isInteger(boat) || boat < 1 || boat > 6) {
      return { entries: [], reason: 'invalid_boat_number' };
    }
    const list = groups.get(boat) || [];
    list.push(row);
    groups.set(boat, list);
  }
  if (groups.size !== 6) return { entries: [], reason: 'entry_incomplete' };
  const selected = [];
  for (let boat = 1; boat <= 6; boat++) {
    const list = groups.get(boat) || [];
    if (!list.length) return { entries: [], reason: 'entry_incomplete' };
    const distinct = new Set(list.map(regNo).filter(Boolean));
    if (distinct.size > 1) return { entries: [], reason: 'racer_identity_conflict' };
    // 新しいレコードが展示未取得に変わった場合に古い展示を使い回さない。
    const chosen = [...list].sort((a, b) =>
      timestamp(b.updated_date || b.created_date) - timestamp(a.updated_date || a.created_date)
      || String(b.id || '').localeCompare(String(a.id || ''))
    )[0];
    if (!chosen) return { entries: [], reason: 'entry_incomplete' };
    selected.push(chosen);
  }
  return { entries: selected, reason: null };
}
