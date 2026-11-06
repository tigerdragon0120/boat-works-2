// Approximate dutching at the actual 100-yen stake increment.
// Find the lowest total stake whose possible payouts are within 10%
// of the smallest payout. This is NOT the same as buying each ticket for 100 yen.
export function minimumBalancedStakes(odds, {unit=100, tolerance=0.10, maxTotal=100000}={}) {
 if (!Array.isArray(odds) || odds.length===0 || odds.some(x=>!Number.isFinite(x)||x<=0)) return null;
 const maximumOdds=Math.max(...odds);
 const maxPayout=maxTotal*maximumOdds;
 // Optimal minimum payout is one of the ticket payout levels.
 // Searching these levels is sufficient to identify the minimum spend.
 const candidates=new Set();
 for(const odd of odds) {
  const cap=Math.min(Math.floor(maxTotal/unit),Math.floor(maxPayout/(unit*odd)));
  for(let i=1;i<=cap;i++) candidates.add(unit*odd*i);
 }
 let best=null;
 for(const threshold of [...candidates].sort((a,b)=>a-b)) {
  const units=odds.map(odd=>Math.max(1,Math.ceil((threshold-1e-8)/(unit*odd))));
  const cost=units.reduce((sum,n)=>sum+n*unit,0);
  if(cost>maxTotal || (best&&cost>=best.total)) continue;
  const payouts=units.map((n,i)=>n*unit*odds[i]);
  const low=Math.min(...payouts),high=Math.max(...payouts);
  if(high>low*(1+tolerance)+1e-7)continue;
  best={total:cost,stakes:units.map(n=>n*unit),minPayout:low,maxPayout:high,actualOddsLow:low/cost,actualOddsHigh:high/cost,tolerance};
 }
 return best;
}
