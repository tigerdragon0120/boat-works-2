// 保存済みV7予想を既存V7画面と同じ形式で表示するための読取専用アダプタ。
// DB記録から復元できない個別確率・期待回収は未取得のまま表示する。
const ms = (value) => {
  const raw = String(value || '').trim().replace(/(\.\d{3})\d+/, '$1');
  if (!raw) return null;
  const normalized = /(Z|[+-]\d{2}:?\d{2})$/.test(raw) ? raw : raw + 'Z';
  const valueMs = Date.parse(normalized);
  return Number.isFinite(valueMs) ? valueMs : null;
};
const cleanCombo = (value) => /^[1-6]-[1-6]-[1-6]$/.test(String(value))
  && new Set(String(value).split('-')).size === 3;

export const savedDateMs = ms;

export function selectSavedStage(rows, stage, race) {
  const deadline = ms(race?.deadline);
  if (!race?.id || deadline == null) return null;
  const eligible = (rows || []).filter((row) =>
    row?.race_id === race.id && row?.race_key === race.race_key && row?.stage === stage &&
    ms(row.created_date) != null && ms(row.created_date) < deadline &&
    ms(row.generated_at) != null && ms(row.generated_at) < deadline
  );
  // 同段階の重複は恣意的に選ばない。画面でも保留扱いにする。
  return eligible.length === 1 ? eligible[0] : null;
}

// 画面に出すオッズは「いま取得できている直近の実オッズ」。予想時点のオッズとは別物。
// 締切後は締切前に取得された最後のオッズだけを表示し、結果確定後の数字を遡及させない。
export function latestDisplayOddsSnapshot(oddsRows = [], raceId, deadlineValue, now = Date.now()) {
  const deadline = ms(deadlineValue);
  if (!raceId || deadline == null) return null;
  const maxTime = Math.min(now, deadline);
  return (oddsRows || []).filter((s) => s?.race_id === raceId
    && s.stage === 'FINAL' && ms(s.captured_at) != null
    && ms(s.captured_at) <= now && ms(s.captured_at) < maxTime
    && s.odds_map && typeof s.odds_map === 'object'
  ).sort((a, b) => ms(b.captured_at) - ms(a.captured_at))[0] || null;
}

export function adaptSavedStage(row, oddsRows = [], now = Date.now()) {
  if (!row) return null;
  const predictedAt = ms(row.generated_at);
  const odds = latestDisplayOddsSnapshot(oddsRows, row.race_id, row.deadline, now);
  const oddsMap = odds?.odds_map || {};
  const plans = { hit: {}, value: {} };
  const combinations = new Map();
  for (const mode of ['hit','value']) {
    for (const n of [4,6,8,12]) {
      const saved = row?.plans?.[mode+'_'+n];
      if (!Array.isArray(saved?.tickets) || saved.tickets.length !== n ||
        saved.tickets.some((c) => !cleanCombo(c))) continue;
      for (const t of saved.tickets) {
        if (!combinations.has(t)) combinations.set(t, {combination:t,probability:null});
      }
      const covered = odds ? saved.tickets.filter(t => Number.isFinite(Number(oddsMap[t])) && Number(oddsMap[t]) > 0).length / n : 0;
      plans[mode][n] = {
        tickets: [...saved.tickets], probability: saved.probability ?? null,
        judgment: saved.judgment || null, stake: n * 100,
        expectedRecovery: null, oddsCoverage: covered,
      };
    }
  }
  if (cleanCombo(row.top_combination)) {
    combinations.set(row.top_combination, {
      combination: row.top_combination,
      probability: Number.isFinite(Number(row.top_probability)) && row.top_probability != null
        ? Number(row.top_probability) : null,
    });
  }
  const output = {
    model: row.model || (row.is_womens ? 'WOMENS':'OPEN'),
    combinations: [...combinations.values()],
    ticketPlans: plans.hit, recoveryPlans: plans.value,
    coverage: row.coverage ?? null, course_basis: 'サーバー保存', judgment_reason: row.judgment_reason || null,
  };
  return { status: 'READY', record: { id: row.id,
    payload: { race_key: row.race_key, deadline: row.deadline, generated_at: row.generated_at,
      input_hash: row.input_hash || null, stage: row.stage,
      output, snapshot: {oddsMap, provenance: {odds_captured_at: odds?.captured_at || null,
        display_odds_after_prediction: odds && predictedAt != null ? ms(odds.captured_at) > predictedAt : false,
        display_odds_only: true} }
    }
  }, fromServer: true };
}
