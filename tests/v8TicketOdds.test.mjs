import test from 'node:test';
import assert from 'node:assert/strict';
import {buildTicketOdds} from '../src/components/liveV8/v8TicketOdds.js';

const NOW = Date.parse('2026-11-25T03:00:00Z');
const race = {id:'race-a',deadline:'2026-11-25T03:10:00Z',status:'scheduled'};
const tickets = ['1-2-3','1-3-2'];
const snapshot = {id:'quote-a',race_id:race.id,stage:'FINAL',captured_at:'2026-11-25T02:59:00Z',created_date:'2026-11-25T02:59:00.100000',odds_map:{'1-2-3':10,'1-3-2':'20','6-5-4':1}};
const build = (options = {}) => buildTicketOdds({tickets,race,now:NOW,displayOdds:{status:'AVAILABLE',snapshot},...options});
const withSnapshot = change => ({displayOdds:{status:'AVAILABLE',snapshot:{...snapshot,...change}}});

test('composite odds use exactly the displayed tickets and a single quoted snapshot', () => {
  const frozen = structuredClone(snapshot);
  const value = build();
  assert.equal(value.status,'AVAILABLE');
  assert.ok(Math.abs(value.composite - 20/3) < 1e-12);
  assert.deepEqual(value.quotes,{'1-2-3':10,'1-3-2':20});
  assert.equal(value.available,2);
  assert.equal(value.composite.toFixed(2),'6.67');
  assert.equal(build({tickets:['6-5-4']}).composite,1);
  assert.deepEqual(snapshot,frozen);
});

test('missing and invalid individual quotes never produce a partial composite', () => {
  for (const missing of [undefined,null,'',0,-1,true,false,NaN,Infinity,'Infinity','bad',1000001]) {
    const value = build(withSnapshot({odds_map:{'1-2-3':10,'1-3-2':missing}}));
    assert.equal(value.status,'PARTIAL');
    assert.equal(value.composite,null);
    assert.equal(value.available,1);
    assert.deepEqual(value.quotes,{'1-2-3':10});
  }
  for (const bad of [[],['1-2-3','1-2-3'],['1-1-2'],['not-a-ticket']]) {
    const value = build({tickets:bad});
    assert.equal(value.status,'INVALID');
    assert.equal(value.composite,null);
  }
  assert.equal(build({displayOdds:{status:'MISSING',snapshot:null}}).status,'MISSING');
  assert.equal(build({displayOdds:{status:'UNAVAILABLE',snapshot:null}}).status,'UNAVAILABLE');
  assert.equal(build({blocked:true}).status,'UNAVAILABLE');
});

test('wrong-race, future, late or unverified snapshots are held without quoting any odds', () => {
  for (const change of [
    {race_id:'another-race'}, {id:null}, {captured_at:null}, {created_date:null},
    {captured_at:'2026-11-25T03:00:01Z'}, {created_date:'2026-11-25T03:00:01Z'},
    {created_date:'2026-11-25T02:58:59Z'}, {odds_map:[]},
  ]) {
    const value = build(withSnapshot(change));
    assert.equal(value.status,'INVALID');
    assert.deepEqual(value.quotes,{});
    assert.equal(value.composite,null);
  }
  const closedNow = Date.parse('2026-11-25T03:12:00Z');
  for (const change of [
    {captured_at:race.deadline,created_date:'2026-11-25T03:10:01Z'},
    {captured_at:'2026-11-25T03:09:00Z',created_date:race.deadline},
  ]) assert.equal(build({...withSnapshot(change),now:closedNow}).status,'INVALID');
  assert.equal(build({race:{...race,deadline:null}}).status,'INVALID');
});

test('quotes become update-waiting at five minutes and historical after closing', () => {
  const value = build(withSnapshot({captured_at:'2026-11-25T02:55:00Z',created_date:'2026-11-25T02:55:01Z'}));
  assert.equal(value.stale,true);
  assert.equal(value.historical,false);
  assert.ok(value.composite > 0);
  assert.equal(build(withSnapshot({captured_at:'2026-11-25T02:55:00.001Z',created_date:'2026-11-25T02:55:01Z'})).stale,false);
  const closed = build({now:Date.parse(race.deadline)});
  assert.equal(closed.stale,false);
  assert.equal(closed.historical,true);
  assert.equal(closed.capturedAt,snapshot.captured_at);
  assert.equal(build({race:{...race,status:'finished'}}).historical,true);
});

test('quote times retain the same meaning for JST and production UTC microseconds', () => {
  const zoned = build(withSnapshot({captured_at:'2026-11-25T11:59:00+09:00',created_date:'2026-11-25T02:59:00.100000'}));
  assert.equal(zoned.status,'AVAILABLE');
  assert.equal(zoned.stale,false);
  assert.equal(zoned.composite,build().composite);
});
