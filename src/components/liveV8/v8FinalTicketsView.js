export const FINAL_SELECTION_REVISION = 'V8_FINAL_SELECTION_1';
const finite = value => typeof value === 'number' && Number.isFinite(value);
const bound = (value, min, max) => finite(value) && value >= min && value <= max ? value : null;
const ticketValid = value => typeof value === 'string' && /^[1-6]-[1-6]-[1-6]$/.test(value) && new Set(value.split('-')).size === 3;
const sameTickets = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((value, index) => value === b[index]);
const strings = value => Array.isArray(value) ? value.filter(item => typeof item === 'string' && item.trim()) : [];
const time = value => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(value)) return null;
  const ms = Date.parse(/(?:Z|[+-]\d{2}:?\d{2})$/.test(value) ? value : value + 'Z');
  return Number.isFinite(ms) ? ms : null;
};
const boat = value => Number.isInteger(value) && value >= 1 && value <= 6;
const ROLE_LABELS = {INSIDE_AXIS: '1着の軸', WIN_CANDIDATE: '1着候補', FOLLOWER_FOCUS: '2・3着を中心に評価', SUPPORT_CANDIDATE: '相手候補'};
const HEAD_BALANCE_POLICY = 'V8_RULE_BUY_2';
const HEAD_KINDS = {MAIN: '本線', COUNTER: '対抗'};
const selectionBasis = value => ['SCORE_RANK', 'HEAD_COVERAGE'].includes(value) ? value : null;
const globalRank = value => Number.isInteger(value) && value >= 1 && value <= 120 ? value : null;

// Ticket heads are the source of truth for counts. Optional explanatory metadata
// must not create or relabel a head that is absent from the saved selection.
function headAllocationView(plan, tickets, ranked) {
  const counts = new Map();
  for (const ticket of tickets) {
    const number = Number(ticket[0]);
    counts.set(number, (counts.get(number) || 0) + 1);
  }
  const derived = [...counts].map(([boat_number, ticket_count]) => ({boat_number, ticket_count, kind: null,
    course: null, first_score: null, score_gap: null, scenario_key: null, best_global_rank: null, reason: null,
    label: null, summary: `${boat_number}号艇頭 ${ticket_count}点`}));
  const saved = plan.head_allocations;
  const fallback = status => ({head_allocations: derived, head_allocation_status: status, head_allocation_basis: 'TICKETS'});
  if (saved == null) return fallback('MISSING');
  if (!Array.isArray(saved) || saved.length !== counts.size || new Set(saved.map(row => row?.boat_number)).size !== counts.size
    || saved.filter(row => row?.kind === 'MAIN').length !== 1
    || !saved.every(row => row && boat(row.boat_number) && boat(row.course) && Object.hasOwn(HEAD_KINDS, row.kind)
      && Number.isInteger(row.ticket_count) && row.ticket_count === counts.get(row.boat_number)
      && bound(row.first_score, 0, 100) !== null && bound(row.score_gap, 0, 100) !== null
      && typeof row.scenario_key === 'string' && new RegExp(`^${row.boat_number}_(ESCAPE|SASHI|MAKURI|MAKURISASHI)$`).test(row.scenario_key)
      && globalRank(row.best_global_rank) !== null && typeof row.reason === 'string' && row.reason.trim())) return fallback('INVALID');
  if (plan.policy_revision === HEAD_BALANCE_POLICY) {
    const main = saved.find(row => row.kind === 'MAIN');
    if (!ranked.every(row => row.global_rank !== null) || !saved.every(row => {
      const firstRank = Math.min(...ranked.filter(ticket => Number(ticket.ticket[0]) === row.boat_number).map(ticket => ticket.global_rank));
      const expectedGap = main.first_score - row.first_score;
      return row.best_global_rank === firstRank && expectedGap >= -0.002 && Math.abs(row.score_gap - expectedGap) <= 0.002;
    })) return fallback('INVALID');
  }
  const normalized = [...saved].sort((a, b) => Number(b.kind === 'MAIN') - Number(a.kind === 'MAIN')
    || [...counts.keys()].indexOf(a.boat_number) - [...counts.keys()].indexOf(b.boat_number)).map(row => ({
    boat_number: row.boat_number, course: row.course, kind: row.kind, ticket_count: counts.get(row.boat_number),
    first_score: row.first_score, score_gap: row.score_gap, scenario_key: row.scenario_key,
    best_global_rank: row.best_global_rank, reason: row.reason.trim(), label: HEAD_KINDS[row.kind],
    summary: `${HEAD_KINDS[row.kind]} ${row.boat_number}号艇頭 ${counts.get(row.boat_number)}点`,
  }));
  return {head_allocations: normalized, head_allocation_status: 'VALID', head_allocation_basis: 'SAVED'};
}

export function finalSelectionView(forecast) {
  const plan = forecast?.final_selection;
  const headBalanced = plan?.policy_revision === HEAD_BALANCE_POLICY;
  const rankLabel = headBalanced ? '選抜内の評価順' : '推定順位';
  const empty = kind => ({kind, available: false, plan: plan || null, tickets: [], ranked: [], roles: [], count: 0,
    head_balanced: headBalanced, rank_label: rankLabel, head_allocations: [], head_allocation_status: 'MISSING', head_allocation_basis: 'TICKETS', coverage_count: null});
  if (!plan) return empty('LEGACY');
  if (plan.revision !== FINAL_SELECTION_REVISION || !['BUY', 'WATCH', 'WAIT', 'SKIP', 'REPLAY'].includes(plan.status)
    || !['DAY_BEFORE', 'PRE', 'FINAL'].includes(forecast.stage) || plan.stage !== forecast.stage || plan.probability_calibrated !== false) return empty('INVALID');
  if (Array.isArray(plan.tickets) && !plan.tickets.length && plan.ticket_count === 0 && Array.isArray(plan.ranked_tickets)
    && !plan.ranked_tickets.length && ['WAIT', 'SKIP', 'REPLAY'].includes(plan.status)) return empty(plan.status === 'REPLAY' ? 'REPLAY' : 'WAIT');
  const tickets = plan.tickets, ranked = plan.ranked_tickets;
  if (!Array.isArray(tickets) || tickets.length < 6 || tickets.length > 12 || plan.ticket_count !== tickets.length
    || !tickets.every(ticketValid) || new Set(tickets).size !== tickets.length || !Array.isArray(ranked) || ranked.length !== tickets.length
    || !ranked.every(row => row && Number.isInteger(row.rank))) return empty('INVALID');
  const sorted = [...ranked].sort((a, b) => a.rank - b.rank);
  if (!sorted.every((row, index) => row?.rank === index + 1 && row.ticket === tickets[index] && finite(row.score))) return empty('INVALID');
  const ranks = sorted.map(row => globalRank(row.global_rank));
  const validGlobalRanks = ranks.every(value => value !== null) && new Set(ranks).size === ranks.length
    && ranks.every((value, index) => index === 0 || value > ranks[index - 1]);
  const rows = sorted.map(row => ({...row, reasons: strings(row.reasons), reason: strings(row.reasons).slice(0, 2).join('。'),
    global_rank: validGlobalRanks ? row.global_rank : null, selection_basis: selectionBasis(row.selection_basis),
    ...(headBalanced ? {label: rankLabel} : {})}));
  const heads = headAllocationView(plan, tickets, rows);
  const coverageCount = headBalanced && rows.every(row => row.selection_basis !== null)
    ? rows.filter(row => row.selection_basis === 'HEAD_COVERAGE').length : null;
  const roles = (Array.isArray(plan.role_evidence) ? plan.role_evidence : []).filter(row => boat(row?.boat_number)
    && Object.hasOwn(ROLE_LABELS, row.role)).map(row => {
    const allocation = heads.head_allocation_basis === 'SAVED' ? heads.head_allocations.find(item => item.boat_number === row.boat_number) : null;
    const label = headBalanced && allocation ? `${allocation.label}の1着候補`
      : headBalanced && row.role === 'INSIDE_AXIS' ? '内側の1着候補' : ROLE_LABELS[row.role];
    return {...row, label, reasons: strings(row.reasons),
      player_name: forecast.boats?.find(item => item.boat_number === row.boat_number)?.player_name || '選手名未取得',
      reverse_support: Array.isArray(row.reverse_support) ? row.reverse_support.filter(item => typeof item?.label === 'string') : []};
  });
  return {kind: 'SAVED', available: true, plan, tickets: [...tickets], ranked: rows, roles, count: tickets.length,
    head_balanced: headBalanced, rank_label: rankLabel, coverage_count: coverageCount, ...heads};
}

export function finalSelectionOdds(forecast, race, now = Date.now(), blocked = false) {
  const view = finalSelectionView(forecast), plan = view.plan;
  const empty = status => ({status, total: view.count, available: 0, quotes: {}, composite: null, capturedAt: null,
    snapshotId: null, stale: false, historical: false, saved: true});
  if (blocked || !view.available) return empty('UNAVAILABLE');
  if (!plan.odds_snapshot_id || !plan.odds || typeof plan.odds !== 'object') return empty('MISSING');
  const captured = time(plan.odds_captured_at), generated = time(forecast.generated_at), deadline = time(race?.deadline || forecast.deadline);
  if (captured == null || generated == null || deadline == null || captured > generated || captured > now || captured >= deadline - 60000
    || (race?.id && forecast.race_id !== race.id) || (race?.race_key && forecast.race_key !== race.race_key)) return empty('INVALID');
  const quotes = Object.fromEntries(view.tickets.map(ticket => [ticket, bound(plan.odds[ticket], 1, 1000000)]).filter(([, value]) => value !== null));
  const complete = Object.keys(quotes).length === view.count;
  return {status: complete ? 'AVAILABLE' : 'PARTIAL', total: view.count, available: Object.keys(quotes).length, quotes,
    composite: complete && finite(plan.composite_odds) && plan.composite_odds > 0 ? plan.composite_odds : null,
    capturedAt: plan.odds_captured_at, snapshotId: plan.odds_snapshot_id, saved: true,
    stale: now - captured >= 300000 || (time(plan.valid_until) != null && now >= time(plan.valid_until)),
    historical: now >= deadline || ['finished', 'cancelled'].includes(race?.status)};
}

export function finalSelectionDecision(forecast, race, now = Date.now(), {blocked = false} = {}) {
  const state = (key, label, tone = 'slate', detail = null) => ({key, label, tone, detail});
  if (blocked) return state('WAIT', '保存状況の確認待ち', 'amber');
  const effective = forecast?.effective_status || forecast?.decision?.effective_status;
  if (race?.status === 'cancelled' || effective === 'CANCELLED') return state('CANCELLED', '中止');
  if (forecast?.record_mode === 'REPLAY' || forecast?.final_selection?.status === 'REPLAY') return state('REPLAY', '事後検証', 'sky');
  const sourceDeadline = time(forecast?.deadline), currentDeadline = time(race?.deadline);
  const deadline = sourceDeadline != null && currentDeadline != null ? Math.min(sourceDeadline, currentDeadline) : currentDeadline ?? sourceDeadline;
  if (race?.status === 'finished' || effective === 'CLOSED' || (deadline != null && now >= deadline - 60000)) return state('CLOSED', deadline != null && now < deadline && race?.status !== 'finished' ? '締切直前' : '締切済');
  if (!forecast) return state('WAIT', '展示後の最終選抜待ち', 'sky');
  if (race && ((race.id && forecast.race_id !== race.id) || (race.race_key && forecast.race_key !== race.race_key)
    || currentDeadline == null || sourceDeadline !== currentDeadline)) return state('WAIT', 'レース情報の確認待ち', 'amber');
  const view = finalSelectionView(forecast);
  if (view.kind === 'LEGACY') return state('LEGACY', '最終選抜は未保存');
  if (view.kind === 'INVALID') return state('WAIT', '保存内容の確認待ち', 'amber');
  if (forecast.stage !== 'FINAL') return state('PRE', '展示前の候補', 'sky', '展示の進入・ST・タイムを確認して最終候補を絞ります。');
  if (!view.available || forecast.exhibition_complete !== true || forecast.quality === 'PARTIAL') return state('WAIT', '展示・入力情報待ち', 'amber');
  if (effective === 'WAIT' && forecast.decision?.status === 'BUY') return state('STALE', '再確認待ち', 'amber', '保存したBUY判定の有効時刻・オッズ・買い目を再確認します。');
  const status = effective || forecast.decision?.status || view.plan.status;
  if (status === 'BUY') {
    const generated = time(forecast.generated_at), created = time(forecast.created_date), expires = time(view.plan.valid_until);
    const decisionExpires = time(forecast.decision?.valid_until), odds = finalSelectionOdds(forecast, race, now);
    if (view.plan.status !== 'BUY' || forecast.decision?.status !== 'BUY' || (forecast.record_mode != null && forecast.record_mode !== 'LIVE')
      || !sameTickets(forecast.decision.tickets, view.tickets)
      || !forecast.id || generated == null || created == null || deadline == null || generated > now || created > now || created < generated
      || generated >= deadline - 60000 || created >= deadline - 60000 || view.plan.price_checked !== true || forecast.decision.price_checked !== true
      || forecast.decision.odds_snapshot_id !== view.plan.odds_snapshot_id || time(forecast.decision.odds_captured_at) !== time(view.plan.odds_captured_at)
      || odds.status !== 'AVAILABLE' || odds.composite == null || odds.composite <= 1 || expires == null || decisionExpires == null
      || now >= expires || now >= decisionExpires || odds.stale) return state('STALE', '再確認待ち', 'amber', '保存したBUY判定の有効時刻・オッズ・買い目を再確認します。');
    return state('BUY', 'BUY', 'emerald');
  }
  return ({WATCH: state('WATCH', '候補・保留', 'amber'), SKIP: state('SKIP', '見送り'), WAIT: state('WAIT', '情報待ち', 'amber')})[status]
    || state('WAIT', '判定待ち', 'amber');
}

export function finalSelectionResultView(forecast, verification) {
  const selection = finalSelectionView(forecast), result = verification?.final_selection_result;
  const empty = status => ({status, available: false, result: null, hit: null, count: selection.count});
  if (!selection.available) return empty(['LEGACY', 'REPLAY', 'WAIT'].includes(selection.kind) ? 'NOT_RECORDED' : 'INVALID');
  if (!result) return empty('PENDING');
  if (result.status === 'INVALID_SAVED_SELECTION') return empty('INVALID');
  if (result.revision !== 'V8_FINAL_SELECTION_VERIFICATION_1' || result.source_revision !== selection.plan.revision
    || result.source_forecast_id !== forecast.id || (verification.forecast_id && verification.forecast_id !== forecast.id)
    || !sameTickets(result.tickets, selection.tickets) || result.ticket_count !== selection.count || result.unit_stake !== 100) return empty('INVALID');
  if (result.status === 'RESULT_PENDING') return empty('PENDING');
  if (result.status === 'EXCLUDED_REFUND') return {status: 'EXCLUDED_REFUND', available: true, result, hit: null, count: selection.count};
  if (result.status !== 'SETTLED' || typeof result.hit !== 'boolean' || result.stake !== selection.count * 100
    || !finite(result.return) || result.return < 0 || (result.hit && (!Number.isInteger(result.hit_rank) || result.hit_rank < 1 || result.hit_rank > selection.count))) return empty('INVALID');
  return {status: 'SETTLED', available: true, result, hit: result.hit, count: selection.count};
}

export function finalSelectionStats(forecasts = [], settlementMap = new Map(), {buyOnly = false} = {}) {
  const rows = [...new Map(forecasts.filter(row => row?.stage === 'FINAL' && row.record_mode !== 'REPLAY' && row.id).map(row => [row.id, row])).values()];
  const summary = {saved: 0, pending: 0, excluded: 0, invalid: 0, legacy: 0, unselected: 0, n: 0, hits: 0, stake: 0, returns: 0};
  for (const forecast of rows) {
    const selection = finalSelectionView(forecast);
    if (buyOnly && forecast.decision?.status !== 'BUY') continue;
    if (!selection.available) { summary[selection.kind === 'LEGACY' ? 'legacy' : ['WAIT', 'REPLAY'].includes(selection.kind) ? 'unselected' : 'invalid']++; continue; }
    if (buyOnly && (selection.plan.status !== 'BUY' || !sameTickets(forecast.decision.tickets, selection.tickets))) { summary.invalid++; continue; }
    summary.saved++;
    const view = finalSelectionResultView(forecast, settlementMap.get(forecast.id));
    if (view.status === 'PENDING') { summary.pending++; continue; }
    if (view.status === 'EXCLUDED_REFUND') { summary.excluded++; continue; }
    if (view.status !== 'SETTLED' || (buyOnly && (view.result.buy_selected !== true || view.result.decision_status !== 'BUY'))) { summary.invalid++; continue; }
    summary.n++; summary.hits += view.hit ? 1 : 0; summary.stake += view.result.stake; summary.returns += view.result.return;
  }
  return summary;
}
