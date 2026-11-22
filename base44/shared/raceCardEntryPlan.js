// Plan a card refresh from a complete, freshly read ledger. Never merge or
// delete duplicates, and never replace a different racer in the same slot.
const present=value=>value!=null&&value!=='';
const venue=value=>String(value).padStart(2,'0');
const registration=row=>row.registration_number??row.register_number;
function identityConflict(old,incoming){
  if(!old?.id)return true;
  for(const key of ['race_id','race_key','race_date'])if(present(old[key])&&String(old[key])!==String(incoming[key]))return true;
  if(present(old.venue_code)&&venue(old.venue_code)!==venue(incoming.venue_code))return true;
  if(present(old.race_number)&&Number(old.race_number)!==Number(incoming.race_number))return true;
  if(present(registration(old))&&String(registration(old))!==String(registration(incoming)))return true;
  return false;
}
export function planRaceCardEntries(existingRows,incomingRows){
  const groups=new Map();
  for(const row of incomingRows){const rows=groups.get(row.race_key)||[];rows.push(row);groups.set(row.race_key,rows);}
  const creates=[],updates=[],held=[];
  for(const [raceKey,rows] of groups){
    const boats=new Set(rows.map(row=>Number(row.boat_number)));
    if(boats.size!==rows.length||[...boats].some(boat=>!Number.isInteger(boat)||boat<1||boat>6)){
      held.push({race_key:raceKey,reason:'INCOMING_BOAT_IDENTITY_INVALID'});continue;
    }
    const nextCreates=[],nextUpdates=[];
    let reason=null;
    for(const incoming of rows){
      const matches=existingRows.filter(row=>(row.race_key===incoming.race_key||row.race_id===incoming.race_id)&&Number(row.boat_number)===Number(incoming.boat_number));
      if(matches.length>1){reason='EXISTING_BOAT_AMBIGUOUS';break;}
      const old=matches[0];
      if(!old){nextCreates.push({...incoming});continue;}
      if(identityConflict(old,incoming)){reason='EXISTING_BOAT_IDENTITY_CONFLICT';break;}
      nextUpdates.push({...incoming,id:old.id,is_absent:old.is_absent===true,is_scratched:old.is_scratched===true});
    }
    if(reason){held.push({race_key:raceKey,reason});continue;}
    creates.push(...nextCreates);updates.push(...nextUpdates);
  }
  return {creates,updates,held};
}
