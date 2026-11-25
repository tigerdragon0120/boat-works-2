import {scenarioTicketView} from '../../../base44/shared/v8ScenarioTickets.js';
import {deriveScenarioVerification} from '../../../base44/shared/v8ScenarioSettlement.js';

const finite = value => typeof value === 'number' && Number.isFinite(value);
const sameTickets = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length
  && new Set(a).size === a.length && new Set(b).size === b.length && a.every(ticket => b.includes(ticket));

// Only the selected forecast's frozen scenarios and its matching verification
// are used. Switching a card never fetches inputs or changes the saved forecast.
export function scenarioViews(forecast, verification) {
  if (!forecast) return [];
  const scenarios = Array.isArray(forecast.scenarios) ? forecast.scenarios : [];
  const unique = scenarios.filter((scenario, index) => typeof scenario?.key === 'string'
    && scenarios.findIndex(row => row?.key === scenario.key) === index).slice(0, 6);
  const results = verification?.forecast_id === forecast.id
    ? deriveScenarioVerification(forecast, verification) : [];
  return unique.map(scenario => {
    const ticketView = scenarioTicketView(forecast, scenario.key);
    const tickets = ticketView.tickets || [];
    const matches = results.filter(row => row?.scenario_key === scenario.key && sameTickets(row.tickets, tickets));
    const result = matches.length === 1 ? matches[0] : null;
    const reconstructed = ticketView.status === 'RECONSTRUCTED';
    const replay = forecast.record_mode === 'REPLAY';
    const saved = ticketView.status === 'SAVED';
    const available = (saved || reconstructed) && tickets.length > 0;
    const sourceLabel = saved ? (replay ? '事後検証・保存済み' : '保存済み')
      : reconstructed ? '保存データから計算' : '買い目の情報不足';
    const reference = reconstructed || replay || result?.ticket_basis === 'RECONSTRUCTED';
    const settled = result?.status === 'SETTLED' && typeof result.hit === 'boolean'
      && finite(result.stake) && result.stake > 0 && finite(result.returned) && result.returned >= 0;
    const excluded = result?.status === 'EXCLUDED_REFUND';
    const resultLabel = excluded ? '返還等・集計対象外'
      : settled ? `${reference ? '参考照合：' : ''}${result.hit ? '的中' : '不的中'}`
      : available ? '結果照合待ち' : '買い目の確認待ち';
    return {scenario, tickets, ticketView, sourceLabel, available, saved, reconstructed,
      reference, result: settled || excluded ? result : null, settled, excluded, resultLabel};
  });
}

export const scenarioSelectionContext = (forecast, mode = '') => forecast
  ? `${forecast.race_key || forecast.race_id || ''}:${forecast.stage || ''}:${mode}` : '';

export function selectedScenarioView(views, selection, forecast, mode = '') {
  const selectedKey = selection?.context === scenarioSelectionContext(forecast, mode) ? selection.key : null;
  return views.find(view => view.scenario.key === selectedKey)
    || views.find(view => view.scenario.key === forecast?.top_scenario_key) || views[0] || null;
}
