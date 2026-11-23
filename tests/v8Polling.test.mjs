import test from 'node:test';
import assert from 'node:assert/strict';
import {dashboardPollInterval} from '../src/components/liveV8/v8Polling.js';

const now=Date.parse('2026-11-23T11:00:00Z');
const race={id:'r1',race_date:'2026-11-23',status:'scheduled',deadline:'2026-11-23T11:10:00Z'};
const data=(overrides={})=>({race_date:race.race_date,races:[race],coverage:{expected_races:1,pending_races:1},...overrides});
const minutes=(parameters,rows,error=null,at=now)=>dashboardPollInterval(parameters,rows,error,at)/60000;

test('today upcoming and missing-deadline races retain one-minute alert checks',()=>{
  assert.equal(minutes({mode:'day',race_date:'2026-11-23'},data()),1);
  assert.equal(minutes({mode:'race'},data({races:[{...race,deadline:null}]})),1);
  assert.equal(minutes({mode:'day',race_date:'2026-11-23'},data({races:[]})),1);
});
test('closed races with incomplete exhibition or settlement continue checking every five minutes',()=>{
  const closed=data({races:[{...race,deadline:'2026-11-23T10:59:00Z'}]});
  assert.equal(minutes({mode:'race'},closed),5);
  const previous=data({race_date:'2026-11-22',races:[{...race,race_date:'2026-11-22',status:'finished'}]});
  assert.equal(minutes({mode:'day',race_date:'2026-11-22'},previous),5);
});
test('fully verified finished view uses fifteen minutes, while live alerts take precedence',()=>{
  const coverage={expected_races:1,pending_races:0};
  assert.equal(minutes({mode:'race'},data({coverage,races:[{...race,status:'finished'}]})),15);
  assert.equal(minutes({mode:'race'},data({coverage})),1);
});
test('verification view and tomorrow plans use five minutes; errors retry at one minute',()=>{
  assert.equal(minutes({mode:'verification',days:7},data()),5);
  assert.equal(minutes({mode:'day',race_date:'2026-11-24'},data({race_date:'2026-11-24'})),5);
  assert.equal(minutes({mode:'verification'},data(),true),1);
  assert.equal(minutes({mode:'race'},null),1);
});
test('zero or unknown expected races cannot be mistaken for a completed archive',()=>{
  for (const coverage of [{expected_races:0,pending_races:0},{pending_races:0},undefined]) {
    assert.equal(minutes({mode:'day',race_date:'2026-11-22'},data({coverage})),5);
  }
});
test('a tomorrow page switches to live cadence at Japanese midnight without remounting',()=>{
  const rows=data({race_date:'2026-11-24',races:[{...race,race_date:'2026-11-24',deadline:'2026-11-24T02:00:00Z'}]});
  const params={mode:'day',race_date:'2026-11-24'};
  assert.equal(minutes(params,rows,null,Date.parse('2026-11-23T14:59:59Z')),5);
  assert.equal(minutes(params,rows,null,Date.parse('2026-11-23T15:00:00Z')),1);
});
