// Independent settlement for prospective forecasts and explicitly labelled replays.
import {CUTOFF_MS, evidenceTime, jstDay, validTicket, validateTickets} from './v8ExternalEvidence.js';
import {eligibleReplayForecast} from './v8Repository.js';
import {deriveScenarioVerification, SCENARIO_VERIFICATION_REVISION} from './v8ScenarioSettlement.js';

export const SETTLEMENT_REVISION = 'V8_SETTLEMENT_2';
const fail = (reason) => ({ok: false, reason});
// RESULT_FINAL is the current RaceResult schema; FINAL is accepted only for legacy rows.
const isFinal = (r) => r && (['RESULT_FINAL', 'FINAL'].includes(r.result_status) || (r.is_finished === true && !r.result_status));
const amount = (value) => value !== null && value !== undefined && value !== '' && Number.isInteger(Number(value)) && Number(value) >= 0
  ? Number(value) : null;
const hasRefundCode = (value) => typeof value === 'string' && /^(F|L|F\d*|L\d*|欠|欠場|返還|取消|中止)$/i.test(value.trim());
function refundOrCancellation(result) {
  if (['CANCELLED', 'CANCELED', 'VOID', 'REFUND'].includes(String(result.result_status || '').toUpperCase())) return true;
  if (result.is_cancelled === true || result.cancelled === true || result.is_refund === true || result.refund === true) return true;
  if (['refund_boats', 'refunded_boats', 'refunds'].some((key) => Array.isArray(result[key]) && result[key].length > 0)) return true;
  if ((result.finish_order || []).some(hasRefundCode)) return true;
  return (Array.isArray(result.boats) ? result.boats : []).some((boat) =>
    boat?.f_flag === true || ['f_flag', 'finish_order', 'result_status', 'finish', 'finish_rank', 'rank', 'arrival', 'status', 'finish_position', 'result']
      .some((key) => hasRefundCode(boat?.[key])));
}

// The worker may pass every RaceResult row. Different final outcomes are never silently chosen.
function resolveResult(input, provenance, allowRefund=false) {
  const rows = Array.isArray(input) ? input : input ? [input] : [];
  if (rows.some(refundOrCancellation)&&!allowRefund) return fail('REFUND_OR_CANCELLATION_REQUIRES_REVIEW');
  const finals = rows.filter(isFinal);
  if (!finals.length) return fail('RESULT_NOT_FINAL');
  if (finals.some((r) => !validTicket(r.result_trifecta) || amount(r.payout) === null || amount(r.payout) <= 0))
    return fail('INVALID_FINAL_RESULT');
  const outcomes = new Set(finals.map((r) => r.result_trifecta + ':' + amount(r.payout)));
  if (outcomes.size !== 1) return fail('CONFLICTING_FINAL_RESULTS');
  const selected = finals.find((r) => r.id === provenance?.result_id) || finals[0];
  return {ok: true, result: selected};
}

function checkSource(source, sourceKind, nowMs) {
  if (!source?.id || !source.race_id || !source.race_key || !['DAY_BEFORE', 'PRE', 'FINAL'].includes(source.stage)) return fail('INVALID_SOURCE');
  const deadline = evidenceTime(source.deadline);
  const generated = evidenceTime(sourceKind === 'EXTERNAL' ? source.recorded_at : source.generated_at);
  const created = evidenceTime(source.created_date);
  if (deadline === null || generated === null || created === null || nowMs === null) return fail('SOURCE_TIMESTAMPS_MISSING');
  if(sourceKind==='REPLAY')return eligibleReplayForecast(source,nowMs)?{ok:true,deadline,generated,created}:fail('INVALID_REPLAY_SOURCE');
  if(source.record_mode==='REPLAY')return fail('REPLAY_REQUIRES_SEPARATE_COHORT');
  if (generated >= deadline - CUTOFF_MS || created >= deadline - CUTOFF_MS || generated > nowMs || created > nowMs)
    return fail('SOURCE_NOT_SAVED_BEFORE_CUTOFF');
  if (generated > created + 1000) return fail('SOURCE_CLOCK_ORDER_INVALID');
  if (jstDay(deadline) !== source.race_date) return fail('RACE_DATE_DEADLINE_MISMATCH');
  const previousDay = new Date(Date.parse(source.race_date + 'T00:00:00Z') - 86400000).toISOString().slice(0, 10);
  if (source.stage === 'DAY_BEFORE' && (jstDay(generated) !== previousDay || jstDay(created) !== previousDay))
    return fail('DAY_BEFORE_NOT_SAVED_PREVIOUS_DAY');
  if (source.stage !== 'DAY_BEFORE' && jstDay(generated) !== source.race_date) return fail('SOURCE_NOT_RECORDED_ON_RACE_DAY');
  const inputAt = source.input_as_of == null ? null : evidenceTime(source.input_as_of);
  if (source.input_as_of != null && (inputAt === null || inputAt > generated)) return fail('INPUT_AFTER_GENERATION');
  if (sourceKind === 'EXTERNAL') {
    if (source.verification_eligible !== true || source.evidence_type !== 'MANUAL_BEFORE_DEADLINE') return fail('HISTORICAL_EXTERNAL_EXCLUDED');
    if (source.use_scope !== 'PRIVATE_RESEARCH' || source.permission_confirmed !== true) return fail('EXTERNAL_PERMISSION_MISSING');
    const published = evidenceTime(source.published_at);
    if (published === null || published > generated || published >= deadline) return fail('INVALID_PUBLICATION_TIME');
  }
  return {ok: true, deadline, generated, created};
}

function verifyResultEvidence({source, result, provenance, nowMs, deadline}) {
  if (!result.id || result.race_id !== source.race_id) return fail('RESULT_RACE_MISMATCH');
  if (!['BOATCAST', 'LOCAL', 'TXT'].includes(result.source)) return fail('RESULT_SOURCE_UNSUPPORTED');
  if (!provenance?.id || provenance.evidence_type !== 'LIVE') return fail('LIVE_RESULT_PROVENANCE_REQUIRED');
  if (provenance.race_id !== source.race_id || provenance.race_key !== source.race_key || provenance.result_id !== result.id ||
      provenance.result_trifecta !== result.result_trifecta || provenance.source !== result.source) return fail('RESULT_PROVENANCE_MISMATCH');
  const finished = evidenceTime(result.finished_at);
  const fetched = evidenceTime(provenance.fetched_at);
  const recorded = evidenceTime(provenance.recorded_at || provenance.created_date);
  const stored = evidenceTime(provenance.created_date || provenance.recorded_at);
  if ([finished, fetched, recorded, stored].some((time) => time === null)) return fail('RESULT_TIMESTAMPS_MISSING');
  // Existing writers stamp finished_at while processing the fetched response, rather
  // than supplying the official race finish instant. Check both against the deadline
  // independently; do not invent an ordering or an arbitrary timing tolerance.
  if (finished < deadline || fetched < deadline || recorded < fetched || stored < fetched ||
      [finished, fetched, recorded, stored].some((time) => time > nowMs)) return fail('RESULT_TIME_ORDER_INVALID');
  return {ok: true};
}

const methodKey = (method) => ({
  '逃げ': 'ESCAPE', '差し': 'SASHI', 'まくり': 'MAKURI', '捲り': 'MAKURI',
  'まくり差し': 'MAKURISASHI', '捲り差し': 'MAKURISASHI',
  ESCAPE: 'ESCAPE', SASHI: 'SASHI', MAKURI: 'MAKURI', MAKURISASHI: 'MAKURISASHI',
}[String(method || '').trim()] || null);

function settle({source, sourceKind, result: resultInput, provenance, now, excludeRefund=false}) {
  const nowMs = evidenceTime(now);
  const checked = checkSource(source, sourceKind, nowMs);
  if (!checked.ok) return checked;
  const hasRefund=(Array.isArray(resultInput)?resultInput:[resultInput]).filter(Boolean).some(refundOrCancellation);
  if(excludeRefund&&!hasRefund)return fail('NO_REFUND_TO_EXCLUDE');
  const resolved = resolveResult(resultInput, provenance, excludeRefund);
  if (!resolved.ok) return resolved;
  const result = resolved.result;
  const evidence = verifyResultEvidence({source, result, provenance, nowMs, deadline: checked.deadline});
  if (!evidence.ok) return evidence;
  const tickets = sourceKind === 'EXTERNAL' ? source.tickets : source.research_tickets;
  if (!validateTickets(tickets)) return fail('INVALID_RESEARCH_TICKETS');
  const stakePerTicket = sourceKind === 'EXTERNAL' ? amount(source.stake_per_ticket) : 100;
  const fee = sourceKind === 'EXTERNAL' ? amount(source.information_fee ?? 0) : 0;
  if (stakePerTicket === null || stakePerTicket < 100 || stakePerTicket % 100 !== 0 || fee === null)
    return fail('INVALID_RECORDED_STAKE');
  const payout = amount(result.payout);
  const hit = tickets.includes(result.result_trifecta);
  const stake = tickets.length * stakePerTicket;
  const returned = hit ? payout * stakePerTicket / 100 : 0;
  const buySelected = sourceKind === 'FORECAST' && source.stage === 'FINAL' && source.decision?.status === 'BUY';
  const buyTickets = buySelected ? source.decision.tickets : [];
  if (buySelected && !validateTickets(buyTickets)) return fail('INVALID_BUY_TICKETS');
  const buyHit = buySelected && buyTickets.includes(result.result_trifecta);
  const topScenario = sourceKind !== 'EXTERNAL'
    ? (source.scenarios || []).find((row) => row.key === source.top_scenario_key) : null;
  const winner = Number(result.result_trifecta.split('-')[0]);
  const leader = Number(topScenario?.leader);
  const leaderKnown = Number.isInteger(leader) && leader >= 1 && leader <= 6;
  const actualMethod = methodKey(result.winning_method);
  const predictedMethod = methodKey(topScenario?.method);
  const methodHit = actualMethod && predictedMethod && leaderKnown ? actualMethod === predictedMethod && leader === winner : null;
  const record = {
    verification_key: SETTLEMENT_REVISION + ':' + sourceKind + ':' + source.id + ':' + result.id,
    revision: SETTLEMENT_REVISION, source_kind: sourceKind, record_mode:sourceKind==='REPLAY'?'REPLAY':'LIVE',
    ...(sourceKind !== 'EXTERNAL' ? {forecast_id: source.id} : {external_id: source.id}),
    race_id: source.race_id, race_key: source.race_key, race_date: source.race_date,
    venue_code: source.venue_code || '', venue_name: source.venue_name || '', race_number: source.race_number,
    stage: source.stage, source_revision: source.revision || '',
    source_generated_at: new Date(checked.generated).toISOString(), source_created_at: source.created_date,
    source_name: source.source_name || 'BOAT WORKS 2', forecaster_name: source.forecaster_name || '',
    result_id: result.id, result_trifecta: result.result_trifecta, result_payout: payout,
    evidence_id: provenance.id, settled_at: new Date(nowMs).toISOString(), status: 'SETTLED',
    research_tickets: [...tickets], research_hit: hit, research_stake: stake, research_return: returned,
    buy_selected: buySelected, buy_tickets: [...buyTickets], buy_hit: buyHit,
    buy_stake: buyTickets.length * 100, buy_return: buyHit ? payout : 0,
    information_fee: fee, net_return: returned - stake - fee,
    scenario_leader_hit: leaderKnown ? leader === winner : null,
    winning_method_hit: methodHit, actual_winning_method: result.winning_method || null,
    provenance: {
      result_source: result.source, result_evidence_type: 'LIVE', result_fetched_at: provenance.fetched_at,
      source_evidence_type: sourceKind === 'EXTERNAL' ? source.evidence_type : sourceKind==='REPLAY'?'POST_DEADLINE_RECONSTRUCTION':'SERVER_SNAPSHOT',
      reconstructed_after_deadline:sourceKind==='REPLAY', prospective_statistics_eligible:sourceKind!=='REPLAY',
      external_publisher_verified: sourceKind === 'EXTERNAL' ? source.publisher_verified === true : null,
      all_tickets_charged: true, cancelled_or_refunded_included: false, unit_payout_yen: 100,
      planned_stake_only: true, result_and_source_race_matched: true,
      ...(sourceKind !== 'EXTERNAL' ? {
        sum_revision: source.sum_evidence?.revision || null,
        sum_used_for_scoring: source.sum_evidence?.used_for_scoring === true,
        sum_model: source.sum_evidence?.used_for_scoring === true ? source.sum_evidence.selected_model : null,
        sum_input_as_of: source.sum_evidence?.input_as_of || null,
      } : {}),
    },
  };
  if(excludeRefund){
    record.status='EXCLUDED_REFUND';record.buy_selected=false;record.buy_tickets=[];record.buy_stake=0;
    for(const key of ['research_hit','research_return','buy_hit','buy_return','net_return','scenario_leader_hit','winning_method_hit'])delete record[key];
    record.provenance.exclusion_reason='REFUND_OR_CANCELLATION_REQUIRES_REVIEW';
  }
  if(sourceKind !== 'EXTERNAL'){
    record.scenario_verification_revision = SCENARIO_VERIFICATION_REVISION;
    record.scenario_results = deriveScenarioVerification(source, record);
    record.provenance.scenario_result_count = record.scenario_results.length;
    record.provenance.scenario_totals_in_combined_statistics = false;
  }
  return {ok:true,record};
}

export const settleForecast = ({forecast, result, provenance, now}) => settle({source: forecast, sourceKind: 'FORECAST', result, provenance, now});
export const settleReplayForecast = ({forecast, result, provenance, now}) => settle({source: forecast, sourceKind: 'REPLAY', result, provenance, now});
export const settleExcludedForecast = ({forecast, result, provenance, now}) => settle({source:forecast,sourceKind:forecast?.record_mode==='REPLAY'?'REPLAY':'FORECAST',result,provenance,now,excludeRefund:true});
export const settleExternal = ({external, result, provenance, now}) => settle({source: external, sourceKind: 'EXTERNAL', result, provenance, now});
