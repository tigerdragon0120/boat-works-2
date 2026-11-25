// Conditional ticket sets built only from a forecast's frozen boat/scenario inputs.
// Ranking weights express BOAT WORKS 2's scenario assumptions, not probabilities.
import {roleAdjustedBoatScore} from './v8RacerParameters.js';
export const SCENARIO_TICKET_REVISION = 'V8_SCENARIO_TICKETS_2_RACER_PARAMETERS';
const SAVED_TICKET_REVISIONS = new Set(['V8_SCENARIO_TICKETS_1',SCENARIO_TICKET_REVISION]);
export const SCENARIO_TICKET_BASIS = 'FORECAST_SNAPSHOT';
const METHODS = new Set(['ESCAPE', 'SASHI', 'MAKURI', 'MAKURISASHI']);
const finite = value => typeof value === 'number' && Number.isFinite(value);
const boatNumber = value => Number.isInteger(value) && value >= 1 && value <= 6;
const validTicket = value => typeof value === 'string' && /^[1-6]-[1-6]-[1-6]$/.test(value)
  && new Set(value.split('-')).size === 3;

function scenarioInputs({scenario, boats, stage, exhibitionComplete}) {
  if (!scenario || !METHODS.has(scenario.method) || !boatNumber(scenario.leader)
    || scenario.key !== scenario.leader + '_' + scenario.method
    || !['DAY_BEFORE', 'PRE', 'FINAL'].includes(stage) || !Array.isArray(boats)) return null;
  if (boats.some(boat => !boat || !boatNumber(boat.boat_number))
    || new Set(boats.map(boat => boat.boat_number)).size !== boats.length) return null;
  const active = boats.filter(boat => boat.active !== false && !boat.is_absent && !boat.is_scratched);
  if (active.length < 3 || active.length > 6 || active.some(boat => !finite(boat.score) || boat.score < 0 || boat.score > 100)) return null;
  const courseKey = stage === 'FINAL' && exhibitionComplete === true ? 'observed_course' : 'expected_course';
  if (active.some(boat => !boatNumber(boat[courseKey])) || new Set(active.map(boat => boat[courseKey])).size !== active.length) return null;
  const ordered = active.map(boat => ({boat_number:boat.boat_number, score:boat.score, course:boat[courseKey],racer_parameters:boat.racer_parameters}))
    .sort((a,b) => a.course - b.course || a.boat_number - b.boat_number);
  const leader = ordered.find(boat => boat.boat_number === scenario.leader);
  return leader ? {ordered, leader} : null;
}

/** Fix the selected scenario's leader in first place and rank its followers. */
export function buildScenarioTickets({scenario, boats, stage, exhibitionComplete = false, limit = 8} = {}) {
  const input = scenarioInputs({scenario, boats, stage, exhibitionComplete});
  if (!input || !Number.isInteger(limit) || limit < 1 || limit > 8) return [];
  const {ordered, leader} = input, inside = ordered[0];
  const followers = ordered.filter(boat => boat.boat_number !== leader.boat_number);
  const beneficiaries = [...new Set(Array.isArray(scenario.beneficiaries) ? scenario.beneficiaries : [])]
    .filter(number => followers.some(boat => boat.boat_number === number));
  const beneficiaryScore = boat => {
    const index = beneficiaries.indexOf(boat.boat_number);
    return index < 0 ? 0 : Math.max(0, 3 - index);
  };
  const methodSupport = boat => {
    const distance = boat.course - leader.course;
    if (scenario.method === 'ESCAPE') return (7 - boat.course) * 1.5;
    // A successful sashi can leave the inside boat in the next places.
    if (scenario.method === 'SASHI') return boat.boat_number === inside.boat_number ? 15 : distance < 0 ? 12 : 1;
    // An outside attack opens following space outside the attacking boat.
    if (scenario.method === 'MAKURI') return distance > 0 ? 18 / distance : -10;
    // Makuri-sashi compares an inside survivor with following outer boats.
    return boat.boat_number === inside.boat_number ? 14 : distance > 0 ? 10 / distance : -2;
  };
  const pairSupport = (second, third) => {
    if (scenario.method === 'MAKURI') return second.course > leader.course && third.course > leader.course ? 4 : 0;
    if (scenario.method === 'MAKURISASHI') {
      const insideOutside = (second.boat_number === inside.boat_number && third.course > leader.course)
        || (third.boat_number === inside.boat_number && second.course > leader.course);
      return insideOutside ? 10 : second.course < leader.course && third.course < leader.course ? -3 : 0;
    }
    return 0;
  };
  const candidates = [];
  for (const second of followers) for (const third of followers) {
    if (second.boat_number === third.boat_number) continue;
    candidates.push({
      ticket:[leader.boat_number,second.boat_number,third.boat_number].join('-'),
      score:roleAdjustedBoatScore(second,2) * .62 + roleAdjustedBoatScore(third,3) * .38 + methodSupport(second) + methodSupport(third) * .55
        + beneficiaryScore(second) * 3 + beneficiaryScore(third) + pairSupport(second,third),
    });
  }
  return candidates.sort((a,b) => b.score - a.score || a.ticket.localeCompare(b.ticket))
    .slice(0,limit).map(row => row.ticket);
}

/** Read saved conditional tickets, or explicitly reconstruct legacy ones in memory. */
export function scenarioTicketView(forecast, scenarioKey) {
  const base = {
    status:'UNAVAILABLE', tickets:[], revision:null,
    source_forecast_id:forecast?.id || null, source_generated_at:forecast?.generated_at || null,
    input_as_of:forecast?.input_as_of || null,
  };
  const matches = Array.isArray(forecast?.scenarios) ? forecast.scenarios.filter(row => row?.key === scenarioKey) : [];
  if (matches.length !== 1) return base;
  const scenario = matches[0];
  const input = scenarioInputs({scenario,boats:forecast.boats,stage:forecast.stage,exhibitionComplete:forecast.exhibition_complete});
  if (!input) return base;
  const active = new Set(input.ordered.map(boat => boat.boat_number));
  const expected = Math.min(8,(active.size - 1) * (active.size - 2));
  const hasStoredFields = ['tickets','ticket_revision','ticket_basis'].some(key => Object.hasOwn(scenario,key))
    || /^V8_FORECAST_(?:[3-9]|\d{2,})_/.test(forecast.revision||'')
    || Object.hasOwn(forecast.provenance || {},'scenario_ticket_revision');
  if (hasStoredFields) {
    // A damaged new-format record must not silently become a different prediction.
    if (!SAVED_TICKET_REVISIONS.has(scenario.ticket_revision) || scenario.ticket_basis !== SCENARIO_TICKET_BASIS
      || !Array.isArray(scenario.tickets) || scenario.tickets.length !== expected
      || new Set(scenario.tickets).size !== expected || scenario.tickets.some(ticket => !validTicket(ticket)
        || Number(ticket[0]) !== scenario.leader || ticket.split('-').some(value => !active.has(Number(value))))) return base;
    return {...base,status:'SAVED',tickets:[...scenario.tickets],revision:scenario.ticket_revision};
  }
  const tickets = buildScenarioTickets({scenario,boats:forecast.boats,stage:forecast.stage,exhibitionComplete:forecast.exhibition_complete});
  return tickets.length === expected
    ? {...base,status:'RECONSTRUCTED',tickets,revision:SCENARIO_TICKET_REVISION} : base;
}
