// Public study views keep the saved-in-time and reconstructed cohorts distinct.
export const isReplay = row => row?.record_mode === 'REPLAY';
const at = row => Date.parse(row?.generated_at || row?.created_date || '') || 0;
const raceKey = row => row?.race_key || row?.race_id || row?.id;
export const completeStudyFinal = row => row?.stage === 'FINAL' && row.exhibition_complete === true && Array.isArray(row.research_tickets) && row.research_tickets.length > 0;
export function latestStudyStage(rows, stage) {
  return (rows || []).filter(row => row?.stage === stage && (stage !== 'FINAL' || completeStudyFinal(row))).sort((a,b) => at(b)-at(a) || String(b.id).localeCompare(String(a.id)))[0] || null;
}
export function studyStageLabel(row) {
  if (!row) return '未保存';
  if (row.stage === 'FINAL') return '展示後';
  if (isReplay(row)) return '展示を使わない予想';
  return row.stage === 'DAY_BEFORE' ? '前日' : '当日・展示前';
}
export function studySettlementIndex(rows) {
  const groups = new Map();
  for (const row of rows || []) {
    if (!['SETTLED','EXCLUDED_REFUND'].includes(row?.status) || !row.forecast_id || row.source_kind === 'EXTERNAL') continue;
    const group = groups.get(row.forecast_id) || [];
    group.push(row); groups.set(row.forecast_id, group);
  }
  return new Map([...groups].filter(([,group])=>group.length===1).map(([id,group])=>[id,group[0]]));
}
export function buildStudyRows(data) {
  const live=(data?.forecasts || []).filter(row=>!isReplay(row)), replay=(data?.replay_forecasts || []).filter(isReplay);
  const all=[...live,...replay], byId=new Map(all.map(row=>[row.id,row])), races=new Map();
  for (const race of data?.races || []) races.set(raceKey(race), race);
  for (const row of all) if (!races.has(raceKey(row))) races.set(raceKey(row), {...row,id:row.race_id});
  const settled=studySettlementIndex([...(data?.verifications || []),...(data?.replay_verifications || [])]);
  const progressById=new Map((data?.race_progress || []).map(row=>[row.race_id,row]));
  return [...races.values()].map(race=>{
    const liveRows=live.filter(row=>row.race_id===race.id), replayRows=replay.filter(row=>row.race_id===race.id);
    const final=latestStudyStage(liveRows,'FINAL') || latestStudyStage(replayRows,'FINAL');
    const linkedCandidate=byId.get(final?.comparison?.baseline_id || final?.baseline_id);
    const linked=linkedCandidate?.race_id===race.id&&['DAY_BEFORE','PRE'].includes(linkedCandidate?.stage)?linkedCandidate:null;
    const livePre=latestStudyStage(liveRows,'PRE') || latestStudyStage(liveRows,'DAY_BEFORE');
    const replayPre=latestStudyStage(replayRows,'PRE');
    const pre=linked&&!isReplay(linked)?linked:livePre || linked || replayPre || null;
    return {race,pre,final,preResult:settled.get(pre?.id)||null,finalResult:settled.get(final?.id)||null,progress:progressById.get(race.id)||null};
  });
}
export function studyProgressLabel(progress) {
  return {PRE_PENDING:'事前予想を補完中',EXHIBITION_PENDING:'展示データ取得待ち',FINAL_PENDING:'展示後予想を補完中',RESULT_PENDING:'結果取得待ち',VERIFICATION_PENDING:'結果照合待ち',RESULT_EXCLUDED:'返還等を確認済み',VERIFIED:'検証済み',CANCELLED:'中止'}[progress?.status] || 'データ確認中';
}
export function studyStats(rows,kind='research') {
  const valid=rows.filter(row=>row?.status==='SETTLED'&&Number.isFinite(row[`${kind}_stake`])&&row[`${kind}_stake`]>0&&Number.isFinite(row[`${kind}_return`])&&typeof row[`${kind}_hit`]==='boolean');
  return {n:valid.length,hits:valid.filter(row=>row[`${kind}_hit`]).length,stake:valid.reduce((sum,row)=>sum+row[`${kind}_stake`],0),returns:valid.reduce((sum,row)=>sum+row[`${kind}_return`],0),fees:valid.reduce((sum,row)=>sum+(Number.isFinite(row.information_fee)?row.information_fee:0),0)};
}
export function studyPairs(rows,mode) {
  const pairs={count:0,improved:0,worsened:0,both_hit:0,both_missed:0,excluded_points:0};
  for (const row of rows) {
    const {pre,final,preResult:b,finalResult:a}=row;
    if (!pre||!final||a?.status!=='SETTLED'||b?.status!=='SETTLED') continue;
    const replay=isReplay(pre)||isReplay(final);
    if ((mode==='REPLAY')!==replay) continue;
    if (typeof a.research_hit!=='boolean'||typeof b.research_hit!=='boolean') continue;
    if (a.research_tickets?.length!==b.research_tickets?.length||a.research_stake!==b.research_stake) {pairs.excluded_points++;continue;}
    pairs.count++;
    if (a.research_hit&&!b.research_hit) pairs.improved++;
    else if (!a.research_hit&&b.research_hit) pairs.worsened++;
    else if (a.research_hit) pairs.both_hit++;
    else pairs.both_missed++;
  }
  return pairs;
}
