// Research thresholds, versioned with the frozen forecast. No operational BUY.
export const policy = {
  OPEN: { coverage: .80, oddsCoverage: .80, hit: .065, recovery: 1.12, watchHit: .035 },
  WOMENS: { coverage: .85, oddsCoverage: .85, hit: .075, recovery: 1.18, watchHit: .04,
    missingShrink: 1, alternativeRatio: .5, startDeltaWeight: .25 },
};

export function researchJudgment(model, stage, coverage, critical, plan) {
  const p = policy[model];
  if (!critical || coverage < .5) return 'SKIP';
  const sizeAdjustment = Math.sqrt(plan.tickets.length / 8);
  if (stage === 'FINAL' && plan.tickets.length >= 4 && coverage >= p.coverage && plan.oddsCoverage >= p.oddsCoverage &&
      plan.probability >= p.hit * sizeAdjustment && plan.expectedRecovery !== null &&
      plan.expectedRecovery >= p.recovery) return 'BUY';
  return plan.probability >= p.watchHit * sizeAdjustment ? 'WATCH' : 'SKIP';
}