// Presentation of the saved SUM evidence only. Never recompute a saved forecast
// from the current race data, and never treat an absent timing as zero.
export const SUM_LABELS = {SUM_BASIC: '基本SUM', SUM_AMAGASAKI: '尼崎・3項SUM'};
export const finiteSumValue = value => typeof value === 'number' && Number.isFinite(value);
export const sumTimeText = value => finiteSumValue(value) && value > 0 ? value.toFixed(2) : '—';
export const sumDifferenceText = value => {
  if (!finiteSumValue(value)) return '—';
  const rounded = Math.round(value * 100) / 100;
  return `${rounded > 0 ? '+' : ''}${Object.is(rounded, -0) ? '0.00' : rounded.toFixed(2)}`;
};

export function sumAvailability(evidence) {
  const reasons = new Set([
    ...(Array.isArray(evidence?.acquisition_reasons) ? evidence.acquisition_reasons : []),
    ...(Array.isArray(evidence?.missing) ? evidence.missing : []),
  ].filter(reason => typeof reason === 'string'));
  if (reasons.has('HALF_LAP_NOT_SUPPORTED')) return {state:'UNAVAILABLE',label:'SUM未適用・半周タイムのみ',shortLabel:'SUM未適用',detail:'取得元は半周タイムの公開のため、1周を使うSUMは計算しません。'};
  if (reasons.has('MEASUREMENT_UNAVAILABLE')) return {state:'UNAVAILABLE',label:'SUM未適用・計測なし',shortLabel:'SUM未適用',detail:'取得元で、今回のオリジナル展示は計測なしと案内されています。'};
  if (reasons.has('LAP_TIME_NOT_PUBLISHED')) return {state:'UNAVAILABLE',label:'SUM未適用・1周タイム非公開',shortLabel:'SUM未適用',detail:'取得元に1周タイムの項目がないため、SUMを計算しません。'};
  if ([...reasons].some(reason => /^HTTP_\d{3}$/.test(reason) || ['FETCH_TIMEOUT','FETCH_FAILED','FETCH_TIME_BUDGET'].includes(reason))) return {state:'RETRY',label:'SUM未取得・再取得待ち',shortLabel:'再取得待ち',detail:'元データを取得できませんでした。再取得を待っています。'};
  if (reasons.has('NOT_PUBLISHED')) return {state:'WAIT',label:'SUMの公開待ち',shortLabel:'公開待ち',detail:'1周などの元データがまだ公開されていません。'};
  if ([...reasons].some(reason => /^(?:ROSTER_|EXHIBITION_RACER_|EXHIBITION_BOATS_|SOURCE_RACER_|SOURCE_BOATS_|ORIGINAL_RACER_|ORIGINAL_BOATS_)/.test(reason) || ['ACTIVE_BOATS_INVALID','SCRATCHED_BOATS_INVALID'].includes(reason))) return {state:'INVALID',label:'SUMデータの確認待ち',shortLabel:'確認待ち',detail:'元データと出走艇・選手の一致を確認できていないため、SUMの反映を保留しています。'};
  if (reasons.has('EXHIBITION_TIME_MISSING')) return {state:'WAIT',label:'SUM未適用・展示タイム待ち',shortLabel:'展示待ち',detail:'出走艇の展示タイムが揃ってから、1周タイムとの合算を計算します。'};
  if (evidence?.status === 'INVALID' || [...reasons].some(reason => /^(?:SOURCE_|ORIGINAL_SOURCE_|ORIGINAL_RACE_|RACE_IDENTITY_|EXHIBITION_SOURCE_|EXHIBITION_TIME_SOURCE_)/.test(reason))) return {state:'INVALID',label:'SUMデータの確認待ち',shortLabel:'確認待ち',detail:'対象レースの元データを確認できていないため、SUMの反映を保留しています。'};
  if (reasons.has('ORIGINAL_TIMES_PARTIAL') || [...reasons].some(reason => /^BOAT_[1-6]_SUM_INPUT_MISSING$/.test(reason))) return {state:'WAIT',label:'SUM未適用・タイム不足',shortLabel:'タイム不足',detail:'出走艇の必要なタイムが揃っていません。揃うまでSUMの反映を保留します。'};
  return {state:'WAIT',label:'SUMの取得待ち',shortLabel:'情報不足',detail:'必要なタイムと取得元が揃ったレースで、SUMを計算して予想に反映します。'};
}

export function savedSumView(forecast) {
  const evidence = forecast?.sum_evidence;
  const models = evidence ? [evidence.basic, evidence.venue_specific].filter(model => model && SUM_LABELS[model.key]) : [];
  const selected = models.find(model => model.key === evidence?.selected_model) || null;
  const activeCount = Number.isInteger(evidence?.active_count) && evidence.active_count >= 1 && evidence.active_count <= 6
    ? evidence.active_count : null;
  const calculated = evidence?.status === 'READY' && selected?.status === 'READY';
  const applied = calculated && evidence?.used_for_scoring === true;
  if (forecast?.stage !== 'FINAL') return {state: 'PRE', label: '事前予想には不使用', evidence, models, selected: null, activeCount, applied: false};
  if (!evidence) return {state: 'LEGACY', label: 'SUM未計測の保存記録', evidence: null, models: [], selected: null, activeCount: null, applied: false};
  const availability = sumAvailability(evidence);
  const state = calculated ? 'READY' : availability.state;
  const label = calculated ? `${SUM_LABELS[selected.key]}・${applied ? '予想に反映' : '計算済み'}` : availability.label;
  return {state, label, detail:calculated ? null : availability.detail, evidence, models, selected, activeCount, applied};
}

export function originalTimingSummary(forecast) {
  if (forecast?.stage !== 'FINAL') return '事前予想には不使用';
  const boats = (forecast?.boats || []).filter(boat => boat.active !== false);
  const count = boats.length;
  if (!count) return '未取得';
  const fields = [['lap_time', '1周'], ['turn_time', '周り足'], ['straight_time', '直線']];
  const totals = fields.map(([key, label]) => ({label, count: boats.filter(boat => finiteSumValue(boat[key]) && boat[key] > 0).length}));
  if (!totals.some(item => item.count)) return forecast?.sum_evidence ? '未取得' : '未計測の保存記録';
  return totals.map(item => `${item.label} ${item.count}/${count}艇`).join(' · ');
}

export function sumModelStatus(model) {
  if (model?.missing?.includes('SUM_NO_DIFFERENCE')) return '差なし';
  const fixed = {READY:'計算済み',WAIT_EXHIBITION:'展示待ち',UNSUPPORTED_VENUE:'対象場外'}[model?.status];
  if (fixed) return fixed;
  const evidence = model?.sum_evidence || model;
  const reason = sumAvailability(evidence);
  return reason.shortLabel === '情報不足' && model?.status === 'INSUFFICIENT' ? 'タイム不足' : reason.shortLabel;
}
