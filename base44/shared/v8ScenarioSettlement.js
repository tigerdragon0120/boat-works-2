// Per-scenario comparisons use only a frozen forecast and an already verified
// result receipt. They never change the combined V8 ticket set or its totals.
import {scenarioTicketView} from './v8ScenarioTickets.js';
import {CUTOFF_MS, evidenceTime, jstDay, validTicket} from './v8ExternalEvidence.js';

export const SCENARIO_VERIFICATION_REVISION = 'V8_SCENARIO_VERIFICATION_1';
const payoutAmount = value => typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null;
const methodKey = method => ({
  '逃げ': 'ESCAPE', '差し': 'SASHI', 'まくり': 'MAKURI', '捲り': 'MAKURI',
  'まくり差し': 'MAKURISASHI', '捲り差し': 'MAKURISASHI',
  ESCAPE: 'ESCAPE', SASHI: 'SASHI', MAKURI: 'MAKURI', MAKURISASHI: 'MAKURISASHI',
}[String(method || '').trim()] || null);

function matchingReceipt(forecast, verification) {
  if (!forecast?.id || !forecast.race_id || !forecast.race_key || !forecast.race_date
    || !verification?.result_id || !verification?.evidence_id
    || verification.forecast_id !== forecast.id || verification.race_id !== forecast.race_id
    || verification.race_key !== forecast.race_key || verification.race_date !== forecast.race_date
    || verification.stage !== forecast.stage || !['SETTLED', 'EXCLUDED_REFUND'].includes(verification.status)
    || !['FORECAST', 'REPLAY'].includes(verification.source_kind)
    || verification.provenance?.result_evidence_type !== 'LIVE'
    || verification.provenance?.result_and_source_race_matched !== true
    || (verification.source_kind === 'REPLAY') !== (forecast.record_mode === 'REPLAY')
    || !validTicket(verification.result_trifecta) || payoutAmount(verification.result_payout) == null) return false;
  const generated = evidenceTime(forecast.generated_at), settled = evidenceTime(verification.settled_at);
  return generated != null && settled != null && generated <= settled
    && evidenceTime(verification.source_generated_at) === generated
    && evidenceTime(verification.source_created_at) === evidenceTime(forecast.created_date)
    && evidenceTime(forecast.created_date) != null;
}

function prospectiveTickets(forecast, verification, view) {
  if (view.status !== 'SAVED' || verification.status !== 'SETTLED'
    || verification.source_kind !== 'FORECAST' || forecast.record_mode === 'REPLAY'
    || verification.provenance?.prospective_statistics_eligible !== true) return false;
  const deadline = evidenceTime(forecast.deadline), generated = evidenceTime(forecast.generated_at);
  const created = evidenceTime(forecast.created_date), input = evidenceTime(forecast.input_as_of);
  if ([deadline, generated, created].some(value => value == null)
    || generated >= deadline - CUTOFF_MS || created >= deadline - CUTOFF_MS
    || generated > created + 1000 || (forecast.input_as_of != null && (input == null || input > generated))
    || jstDay(deadline) !== forecast.race_date) return false;
  if (forecast.stage === 'DAY_BEFORE') {
    const previousDay = new Date(Date.parse(forecast.race_date + 'T00:00:00Z') - 86400000).toISOString().slice(0, 10);
    return jstDay(generated) === previousDay && jstDay(created) === previousDay;
  }
  return ['PRE', 'FINAL'].includes(forecast.stage) && jstDay(generated) === forecast.race_date;
}

/**
 * Read-only arithmetic for an existing verified result. Legacy ticket sets are
 * reconstructed from the forecast's frozen inputs and remain reference-only.
 * Calling this in the UI makes no new requests and writes no historical rows.
 */
export function deriveScenarioVerification(forecast, verification) {
  if (!matchingReceipt(forecast, verification)) return [];
  const scenarios = Array.isArray(forecast.scenarios) ? forecast.scenarios : [];
  const counts = new Map();
  for (const scenario of scenarios) if (typeof scenario?.key === 'string') counts.set(scenario.key, (counts.get(scenario.key) || 0) + 1);
  const winner = Number(verification.result_trifecta.split('-')[0]);
  const actualMethod = methodKey(verification.actual_winning_method);
  const rows = [];
  for (const scenario of scenarios) {
    if (!scenario?.key || counts.get(scenario.key) !== 1) continue;
    const view = scenarioTicketView(forecast, scenario.key);
    if (!['SAVED', 'RECONSTRUCTED'].includes(view.status) || !view.tickets.length) continue;
    const leader = Number(scenario.leader), predictedMethod = methodKey(scenario.method);
    const leaderKnown = Number.isInteger(leader) && leader >= 1 && leader <= 6;
    const hit = view.tickets.includes(verification.result_trifecta), stake = view.tickets.length * 100;
    const returned = hit ? verification.result_payout : 0;
    const row = {
      scenario_key: scenario.key, label: scenario.label || scenario.key,
      leader: leaderKnown ? leader : null, method: predictedMethod,
      ticket_revision: view.revision, ticket_basis: view.status,
      source_forecast_id: forecast.id, source_generated_at: forecast.generated_at,
      verification_revision: SCENARIO_VERIFICATION_REVISION,
      verification_basis: view.status === 'SAVED' ? 'STORED_SCENARIO_TICKETS' : 'RECONSTRUCTED_FROM_FROZEN_FORECAST',
      result_id: verification.result_id, settled_at: verification.settled_at,
      record_mode: verification.source_kind === 'REPLAY' ? 'REPLAY' : 'LIVE',
      tickets: [...view.tickets], ticket_count: view.tickets.length, stake_per_ticket: 100,
      status: verification.status, stake,
      prospective_statistics_eligible: prospectiveTickets(forecast, verification, view),
    };
    if (verification.status === 'SETTLED') {
      Object.assign(row, {hit, returned, net_return: returned - stake,
        leader_hit: leaderKnown ? leader === winner : null,
        winning_method_hit: leaderKnown && predictedMethod && actualMethod ? leader === winner && predictedMethod === actualMethod : null});
    } else {
      row.exclusion_reason = 'REFUND_OR_CANCELLATION_REQUIRES_REVIEW';
    }
    rows.push(row);
  }
  return rows;
}
