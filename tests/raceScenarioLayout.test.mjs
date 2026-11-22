import test from 'node:test';
import assert from 'node:assert/strict';
import {getScenarioLayout} from '../src/components/liveV8/raceScenarioLayout.js';
const boats=()=>Array.from({length:6},(_,index)=>({boat_number:index+1,active:true,observed_course:index+1,expected_course:index+1,expected_course_basis:'FRAME_ORDER_ASSUMPTION'}));

test('six-boat layout retains the original order and lane coordinates',()=>{
 const layout=getScenarioLayout(boats(),'FINAL');
 assert.equal(layout.valid,true);assert.deepEqual(layout.order,[1,2,3,4,5,6]);assert.deepEqual(layout.courses,[1,2,3,4,5,6]);
 assert.deepEqual(layout.laneByBoat,{1:0,2:1,3:2,4:3,5:4,6:5});assert.equal(layout.label,'展示進入');
});
test('Gamagori 8R style: absent boat 2 is excluded while all five observed entrants render',()=>{
 const input=boats();input[1]={...input[1],active:false,observed_course:null};
 input.filter(row=>row.active).forEach((row,index)=>{row.observed_course=index+1;});
 const layout=getScenarioLayout(input,'FINAL');
 assert.equal(layout.valid,true);assert.deepEqual(layout.order,[1,3,4,5,6]);assert.deepEqual(layout.courses,[1,2,3,4,5]);
 assert.equal(layout.laneByBoat[3],1);assert.equal(layout.laneByBoat[2],undefined);assert.deepEqual(layout.absentBoats,[2]);assert.equal(layout.activeCount,5);
});
test('PRE leaves the missing frame slot open instead of renumbering expected courses',()=>{
 const input=boats();input[1].active=false;
 const layout=getScenarioLayout(input,'PRE');
 assert.equal(layout.valid,true);assert.deepEqual(layout.order,[1,3,4,5,6]);assert.deepEqual(layout.courses,[1,3,4,5,6]);assert.equal(layout.laneByBoat[3],2);
});
test('a missing active course still holds the diagram; it is not silently dropped',()=>{
 const input=boats();input[1].active=false;input[3].observed_course=null;
 assert.equal(getScenarioLayout(input,'FINAL').valid,false);
});
test('duplicate courses or boat identities cannot be rendered as complete',()=>{
 const duplicatedCourse=boats();duplicatedCourse[2].observed_course=2;
 const duplicatedBoat=boats();duplicatedBoat[2].boat_number=2;
 assert.equal(getScenarioLayout(duplicatedCourse,'FINAL').valid,false);
 assert.equal(getScenarioLayout(duplicatedBoat,'FINAL').valid,false);
});
test('three to six actual entrants are supported but two entrants are held',()=>{
 for(const size of [3,4,5,6])assert.equal(getScenarioLayout(boats().slice(0,size),'FINAL').valid,true);
 assert.equal(getScenarioLayout(boats().slice(0,2),'FINAL').valid,false);
});
test('explicit absence fields are respected and malformed values stay invalid',()=>{
 const input=boats();input[5].is_absent=true;input[5].observed_course=null;
 assert.equal(getScenarioLayout(input,'FINAL').valid,true);
 for(const value of [null,'',true,false,0,7,1.5]){const invalid=boats();invalid[2].observed_course=value;assert.equal(getScenarioLayout(invalid,'FINAL').valid,false,String(value));}
});
test('a reordered five-boat exhibition uses recorded courses without changing the snapshot',()=>{
 const input=boats();input[1].active=false;input[1].observed_course=null;
 const active=input.filter(row=>row.active);[3,1,4,5,2].forEach((course,index)=>{active[index].observed_course=course;});
 const before=JSON.stringify(input),layout=getScenarioLayout(input,'FINAL');
 assert.deepEqual(layout.order,[3,6,1,4,5]);assert.equal(JSON.stringify(input),before);
});
