// A saved final shortlist is its own cohort. Never reconstruct it from results
// or from the eight-ticket research plan when the original shortlist is absent.
import {validTicket} from './v8ExternalEvidence.js';

export const FINAL_SELECTION_VERIFICATION_REVISION='V8_FINAL_SELECTION_VERIFICATION_1';
export const validSavedFinalSelection=selection=>selection?.revision==='V8_FINAL_SELECTION_1'
  &&Array.isArray(selection.tickets)&&selection.tickets.length>=6&&selection.tickets.length<=12
  &&selection.tickets.every(validTicket)&&new Set(selection.tickets).size===selection.tickets.length
  &&selection.ticket_count===selection.tickets.length;

export function deriveFinalSelectionVerification(forecast,settlement){
  if(!forecast?.final_selection)return null;
  const selection=forecast.final_selection;
  const common={revision:FINAL_SELECTION_VERIFICATION_REVISION,source_revision:selection.revision||null,
    source_policy_revision:selection.policy_revision||null,
    source_forecast_id:forecast.id,decision_status:forecast.decision?.status||null,unit_stake:100};
  if(!validSavedFinalSelection(selection))return {...common,status:'INVALID_SAVED_SELECTION',
    tickets:[],ticket_count:0,buy_selected:false};
  const tickets=[...selection.tickets];
  const row={...common,tickets,ticket_count:tickets.length,status:settlement.status,
    buy_selected:settlement.buy_selected===true};
  if(settlement.status==='EXCLUDED_REFUND')return {...row,buy_selected:false};
  if(settlement.status!=='SETTLED'||!validTicket(settlement.result_trifecta)
    ||!Number.isFinite(settlement.result_payout)||settlement.result_payout<=0)
    return {...row,status:'RESULT_PENDING',buy_selected:false};
  const index=tickets.indexOf(settlement.result_trifecta),hit=index>=0;
  return {...row,hit,hit_rank:hit?index+1:null,stake:tickets.length*100,
    return:hit?settlement.result_payout:0};
}
