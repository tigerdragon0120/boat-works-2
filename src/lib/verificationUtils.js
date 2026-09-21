// Lists are requested newest-first. Keep one verification per logical race.
export function dedupeVerifications(rows = []) {
  const seen = new Set();
  return (rows || []).filter((row) => {
    const key = row?.race_key || row?.race_id || row?.id;
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
