const clamp = (n, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, Number.isFinite(Number(n)) ? Number(n) : lo));
const num = (v, fallback = 0) => Number.isFinite(Number(v)) ? Number(v) : fallback;

function v5Scenario(entries, v4, v6) {
  const boats = [1,2,3,4,5,6].map(boat => {
    const e = entries.find(x => Number(x.boat_number) === boat) || {};
    const a = (v4?.boat_scores || []).find(x => Number(x.boat_number) === boat) || {};
    const b = (v6?.boat_scores || []).find(x => Number(x.boat_number) === boat) || {};
    const finalScore = (num(a.final_score, 50) + num(b.final_score, 50)) / 2;
    const firstScore = (num(a.first_score, finalScore) + num(b.first_score, finalScore)) / 2;
    const st = num(e.exhibition_st, num(e.section_st, num(e.avg_st, 0.18)));
    const start = clamp(82 - (st - 0.10) * 260, 15, 100);
    const exhibition = e.exhibition_rank != null ? clamp(108 - Number(e.exhibition_rank) * 13) : 50;
    const motor = clamp(num(e.motor_f2_rate, num(e.motor_2rate, 45)));
    const lane = boat === 1 ? 16 : boat === 2 ? 8 : boat === 3 ? 5 : boat === 4 ? 1 : boat === 5 ? -5 : -10;
    return { boat, score: firstScore * .48 + finalScore * .20 + start * .15 + exhibition * .10 + motor * .07 + lane };
  }).sort((a,b) => b.score - a.score);
  const max = boats[0]?.score || 1;
  const exp = boats.map(x => Math.exp((x.score - max) / 14));
  const sum = exp.reduce((a,b) => a+b, 0) || 1;
  const scenarios = boats.map((x,i) => ({
    first_boat:x.boat,
    probability:Math.round(exp[i] / sum * 100),
    score:Math.round(x.score * 10) / 10,
    followers:boats.filter(y => y.boat !== x.boat).slice(0,3).map(y => y.boat)
  }));
  return {
    scenarios,
    verdict: scenarios[0]?.first_boat === 1 ? "イン逃げ優勢" : `${scenarios[0]?.first_boat || "-"}号艇の攻め優勢`
  };
}

function normalizedTris(pred) {
  const selected = new Set(pred?.selected_trifectas || []);
  return (pred?.trifectas || []).map((t,i) => ({
    combination:t.combination,
    probability:num(t.race_probability, num(t.probability, 0)),
    odds:num(t.actual_odds, 0),
    ev:num(t.expected_value, 0),
    selected:selected.has(t.combination) || t.is_selected === true,
    rank:num(t.rank, i + 1)
  })).filter(t => /^([1-6])-([1-6])-([1-6])$/.test(t.combination));
}

export async function runAndSaveEnsemble(client, race, entries = []) {
  const sr = client.asServiceRole.entities;
  const [v4s, v6s] = await Promise.all([
    sr.PredictionV4.filter({ race_key: race.race_key, stage:"FINAL" }, "-computed_at", 5).catch(() => []),
    sr.PredictionV6.filter({ race_key: race.race_key, stage:"FINAL" }, "-computed_at", 5).catch(() => [])
  ]);
  const v4 = v4s.find(x => x.status === "COMPLETED" || !x.status);
  const v6 = v6s.find(x => x.status === "COMPLETED" || !x.status);
  if (!v4 || !v6) return { skipped:true, reason:"v4_or_v6_missing" };

  const v5 = v5Scenario(entries, v4, v6);
  const score = new Map();
  const detail = new Map();
  const add = (combo, points, engine, meta = {}) => {
    if (!/^([1-6])-([1-6])-([1-6])$/.test(combo || "")) return;
    const [a,b,c] = combo.split("-");
    if (new Set([a,b,c]).size !== 3) return;
    score.set(combo, (score.get(combo) || 0) + points);
    const d = detail.get(combo) || { engines:new Set(), probability:0, odds:0, ev:0 };
    d.engines.add(engine);
    d.probability = Math.max(d.probability, num(meta.probability,0));
    d.odds = Math.max(d.odds, num(meta.odds,0));
    d.ev = Math.max(d.ev, num(meta.ev,0));
    detail.set(combo,d);
  };

  for (const [engine,pred,weight] of [["V4",v4,4.0],["V6",v6,3.2]]) {
    for (const t of normalizedTris(pred)) {
      const rankBonus = Math.max(0, 1.5 - t.rank * .05);
      add(t.combination, (t.selected ? weight : weight * .15) + rankBonus + Math.min(2, t.probability / 8), engine, t);
    }
  }
  v5.scenarios.slice(0,3).forEach((s,si) => {
    const followers = s.followers || [];
    for (let i=0;i<followers.length;i++) for (let j=0;j<followers.length;j++) {
      if (i === j) continue;
      add(`${s.first_boat}-${followers[i]}-${followers[j]}`, 3.4 - si * .7 - (i+j)*.12, "V5", { probability:s.probability });
    }
  });

  const ranked = [...score.entries()].map(([combination,points]) => {
    const d=detail.get(combination);
    const agreement=d.engines.size;
    return { combination, score:Math.round((points + agreement * 1.8)*10)/10, engine_count:agreement,
      engines:[...d.engines], probability:d.probability, actual_odds:d.odds || null,
      expected_value:d.ev || null };
  }).sort((a,b) => b.score-a.score || b.engine_count-a.engine_count);

  const consensus = ranked.filter(x => x.engine_count >= 2);
  const selected = [...consensus, ...ranked.filter(x => x.engine_count < 2)]
    .filter((x,i,a) => a.findIndex(y => y.combination === x.combination) === i).slice(0,8);
  const top = selected[0];
  const v4Buy=v4.final_judgment === "BUY", v6Buy=v6.final_judgment === "BUY";
  const strongAgreement=selected.filter(x => x.engine_count >= 2).length;
  const consensusScore=Math.round(((strongAgreement / Math.max(1,selected.length))*70 + (top?.engine_count || 0)/3*30)*10)/10;
  const judgment = (v4Buy || v6Buy) && strongAgreement >= 3 ? "BUY"
    : (strongAgreement >= 2 || v4Buy || v6Buy) ? "WATCH" : "SKIP";
  const firsts=selected.map(x => Number(x.combination.split("-")[0]));
  const counts=firsts.reduce((m,n)=>(m[n]=(m[n]||0)+1,m),{});
  const roleOrder=Object.entries(counts).sort((a,b)=>b[1]-a[1]).map(([n])=>Number(n));
  const doc={
    race_id:race.id,race_key:race.race_key,stage:"FINAL",prediction_version:"ensemble_v1",
    computed_at:new Date().toISOString(),final_judgment:judgment,
    judgment_reason:`V4(${v4.final_judgment})・V5(${v5.verdict})・V6(${v6.final_judgment})を合成。2系統以上一致${strongAgreement}点`,
    ticket_count:selected.length,selected_trifectas:selected.map(x=>x.combination),
    trifectas:selected.map((x,i)=>({...x,rank:i+1,is_selected:true,ticket_rank:i+1})),
    honmei_boat:roleOrder[0] || Number(top?.combination?.split("-")[0]) || null,
    taiko_boat:roleOrder[1] || null,ana_boat:roleOrder[2] || null,
    top_trifecta:top?.combination || "",top_probability:top?.probability || 0,
    consensus_score:consensusScore,
    engine_votes:{v4:v4.final_judgment,v5:v5.verdict,v6:v6.final_judgment,strong_agreement_tickets:strongAgreement},
    v5_scenarios:v5.scenarios,v5_verdict:v5.verdict,
    source_prediction_ids:{v4:v4.id,v6:v6.id},status:"COMPLETED"
  };
  const old=await sr.PredictionEnsemble.filter({race_key:race.race_key,stage:"FINAL"},"-computed_at",10).catch(()=>[]);
  let saved;
  if(old[0]) saved=await sr.PredictionEnsemble.update(old[0].id,doc);
  else saved=await sr.PredictionEnsemble.create(doc);
  for(const dup of old.slice(1)) await sr.PredictionEnsemble.delete(dup.id).catch(()=>{});
  return {skipped:false,prediction:saved};
}

export async function verifyEnsemblePrediction(client, race, resultData) {
  const sr=client.asServiceRole.entities;
  const preds=await sr.PredictionEnsemble.filter({race_key:race.race_key,stage:"FINAL"},"-computed_at",1).catch(()=>[]);
  const p=preds[0];
  if(!p) return null;
  const tickets=p.selected_trifectas || [];
  const hit=tickets.includes(resultData.result_trifecta);
  const investment=p.final_judgment === "BUY" ? tickets.length*100 : 0;
  const payout=hit ? num(resultData.payout,0) : 0;
  const doc={race_id:race.id,race_key:race.race_key,race_date:race.race_date,venue_code:race.venue_code,
    race_number:race.race_number,actual_result:resultData.result_trifecta,final_judgment:p.final_judgment,
    recommended_hit:hit,ticket_count:tickets.length,selected_trifectas:tickets,payout,investment,
    recovery_rate:investment?Math.round(payout/investment*100):0,consensus_score:p.consensus_score,
    engine_votes:p.engine_votes,verified_at:new Date().toISOString()};
  const old=await sr.PredictionEnsembleVerification.filter({race_key:race.race_key},"-verified_at",10).catch(()=>[]);
  let saved;
  if(old[0]) saved=await sr.PredictionEnsembleVerification.update(old[0].id,doc);
  else saved=await sr.PredictionEnsembleVerification.create(doc);
  for(const dup of old.slice(1)) await sr.PredictionEnsembleVerification.delete(dup.id).catch(()=>{});
  return saved;
}
