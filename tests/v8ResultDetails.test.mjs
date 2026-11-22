import test from 'node:test';
import assert from 'node:assert/strict';
import {hasCompleteResultDetails} from '../base44/shared/v8ResultDetails.js';
const result=()=>({result_trifecta:'1-2-3',boats:Array.from({length:6},(_,i)=>({boat_number:i+1,finish_order:i+1}))});

test('complete observed finish rows qualify while payout-only and missing rows stay pending',()=>{
 assert.equal(hasCompleteResultDetails(result(),{}),true);
 assert.equal(hasCompleteResultDetails({...result(),boats:[]},{}),false);
 assert.equal(hasCompleteResultDetails({...result(),boats:result().boats.slice(0,5)},{}),false);
});
test('explicitly scratched boats can be absent but no scratch is inferred from a missing row',()=>{
 const five={...result(),boats:result().boats.slice(0,5)};
 assert.equal(hasCompleteResultDetails(five,{scratched_boats:[6]}),true);
 assert.equal(hasCompleteResultDetails(five,{scratched_boats:[]}),false);
 assert.equal(hasCompleteResultDetails(result(),{scratched_boats:[6]}),false);
 assert.equal(hasCompleteResultDetails(five,{scratched_boats:[7]}),false);
});
test('explicit F L and other nonfinishes are recognized without inventing numeric placings',()=>{
 for(const status of ['F','L','欠場','転覆','失格','落水','不完走']){
  const row=result();row.boats[5]={boat_number:6,result_status:status};
  assert.equal(hasCompleteResultDetails(row,{}),true,status);
 }
 const unknown=result();unknown.boats[5]={boat_number:6,finish_order:null};
 assert.equal(hasCompleteResultDetails(unknown,{}),false);
 const placeholder=result();placeholder.boats[5]={boat_number:6,result_status:'UNKNOWN'};
 assert.equal(hasCompleteResultDetails(placeholder,{}),false);
});
test('duplicate boats, duplicate places, inconsistent trifecta and conflicting finish flags are held',()=>{
 const duplicateBoat=result();duplicateBoat.boats[5].boat_number=5;assert.equal(hasCompleteResultDetails(duplicateBoat,{}),false);
 const duplicatePlace=result();duplicatePlace.boats[5].finish_order=5;assert.equal(hasCompleteResultDetails(duplicatePlace,{}),false);
 assert.equal(hasCompleteResultDetails({...result(),result_trifecta:'1-3-2'},{}),false);
 const conflict=result();conflict.boats[5].f_flag=true;assert.equal(hasCompleteResultDetails(conflict,{}),false);
});
