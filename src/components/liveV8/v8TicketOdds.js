// Display-only quotes for the tickets on screen. No forecast or decision inputs
// are changed, and quotes from different snapshots are never combined.
const MAX_AGE_MS = 5 * 60 * 1000;
const timestamp = value => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(value.trim())) return null;
  const text = value.trim().replace(/(\.\d{3})\d+/, '$1');
  const result = Date.parse(/[zZ]$|[+-]\d{2}:?\d{2}$/.test(text) ? text : text + 'Z');
  return Number.isFinite(result) ? result : null;
};
const ticketValid = ticket => typeof ticket === 'string'
  && /^[1-6]-[1-6]-[1-6]$/.test(ticket) && new Set(ticket.split('-')).size === 3;
const quoteValue = value => {
  if (typeof value !== 'number' && !(typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value.trim()))) return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 1 && number <= 1000000 ? number : null;
};

export function buildTicketOdds({tickets = [], displayOdds, race, now = Date.now(), blocked = false} = {}) {
  const total = Array.isArray(tickets) ? tickets.length : 0;
  const empty = status => ({status, total, available: 0, quotes: {}, composite: null,
    capturedAt: null, snapshotId: null, stale: false, historical: false});
  if (blocked || displayOdds?.status === 'UNAVAILABLE') return empty('UNAVAILABLE');
  if (!Array.isArray(tickets) || !total || new Set(tickets).size !== total || !tickets.every(ticketValid)) return empty('INVALID');
  if (!displayOdds || displayOdds.status === 'MISSING') return empty('MISSING');
  const snapshot = displayOdds.snapshot, deadline = timestamp(race?.deadline);
  const captured = timestamp(snapshot?.captured_at), created = timestamp(snapshot?.created_date);
  if (displayOdds.status !== 'AVAILABLE' || !snapshot?.id || !race?.id || snapshot.race_id !== race.id
    || !Number.isFinite(now) || deadline == null || captured == null || created == null
    || captured > now || created > now || created < captured || captured >= deadline || created >= deadline
    || !snapshot.odds_map || typeof snapshot.odds_map !== 'object' || Array.isArray(snapshot.odds_map)) return empty('INVALID');
  const quotes = Object.fromEntries(tickets.map(ticket => [ticket, quoteValue(snapshot.odds_map[ticket])]).filter(([, value]) => value != null));
  const available = Object.keys(quotes).length;
  const composite = available === total ? 1 / tickets.reduce((sum, ticket) => sum + 1 / quotes[ticket], 0) : null;
  const historical = now >= deadline || ['finished', 'cancelled'].includes(race.status);
  return {status: available === total ? 'AVAILABLE' : 'PARTIAL', total, available, quotes, composite,
    capturedAt: snapshot.captured_at, snapshotId: snapshot.id,
    stale: !historical && now - captured >= MAX_AGE_MS, historical};
}
