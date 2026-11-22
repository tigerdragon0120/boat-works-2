// A valid trifecta alone cannot establish whether another boat was refunded.
// Require an observed outcome for every participating boat; missing rows are
// unknown, never inferred as F/L, loss, scratch or a normal finish.
const integer=value=>{
  if(typeof value==='number')return Number.isInteger(value)?value:null;
  if(typeof value!=='string'||!/^\d+$/.test(value.trim()))return null;
  const parsed=Number(value.trim());return Number.isInteger(parsed)?parsed:null;
};
const boatNumber=value=>{const n=integer(value);return n!=null&&n>=1&&n<=6?n:null;};
const normalize=value=>typeof value==='string'?value.normalize('NFKC').trim().toUpperCase():'';
const OBSERVED_NONFINISH=new Set(['F','L','欠','欠場','返還','取消','中止','失','失格','転','転覆','落','落水','沈','沈没','不','不完走','妨','妨害','エ','エンスト','DISQUALIFIED','CAPSIZED','SUNK','DNF','DNS','SCRATCHED','ABSENT']);
const explicitNonfinish=boat=>{
  if(boat?.f_flag===true||boat?.l_flag===true)return true;
  return ['result_status','f_flag','l_flag','finish_order','finish','finish_rank','rank','arrival','status','finish_position','result']
    .some(key=>{const code=normalize(boat?.[key]);return OBSERVED_NONFINISH.has(code)||/^[FL]\d+$/.test(code);});
};

export function hasCompleteResultDetails(result,race={}){
  if(!result||!Array.isArray(result.boats)||!result.boats.length)return false;
  const scratched=race?.scratched_boats??[];
  if(!Array.isArray(scratched)||scratched.some(value=>boatNumber(value)==null))return false;
  const excluded=new Set(scratched.map(Number));
  const active=[1,2,3,4,5,6].filter(boat=>!excluded.has(boat));
  if(active.length<3)return false;
  const byBoat=new Map();
  for(const row of result.boats){
    const boat=boatNumber(row?.boat_number);
    if(boat==null||byBoat.has(boat))return false;
    byBoat.set(boat,row);
  }
  const finishers=new Map();
  for(const boat of active){
    const row=byBoat.get(boat);if(!row)return false;
    const place=boatNumber(row.finish_order);
    if(place!=null){
      // An explicit refund/nonfinish contradicting a numeric finish cannot be
      // silently treated as normal. Keep it pending for source correction.
      if(explicitNonfinish(row)||finishers.has(place))return false;
      finishers.set(place,boat);
    }else if(!explicitNonfinish(row))return false;
  }
  // The observed first three finishers must agree with the official payout row.
  if(typeof result.result_trifecta!=='string'||!/^[1-6]-[1-6]-[1-6]$/.test(result.result_trifecta))return false;
  const top=result.result_trifecta.split('-').map(Number);
  if(new Set(top).size!==3||top.some((boat,index)=>finishers.get(index+1)!==boat))return false;
  // A scratched entrant reported as a finisher is a source/identity conflict.
  for(const boat of excluded)if(boatNumber(byBoat.get(boat)?.finish_order)!=null)return false;
  return true;
}
