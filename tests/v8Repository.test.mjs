import test from 'node:test';
import assert from 'node:assert/strict';
import {
  eligibleForecast, canonicalForecasts, latestForecasts, firstBuyForecasts, currentDecision, publicRow, readV8Rows, jstDate,
} from '../base44/shared/v8Repository.js';

const NOW = Date.parse('2026-11-22T04:40:00.000Z');
const deadline = '2026-11-22T05:00:00.000Z';
const race = {id:'race-1',race_key:'2026-11-22_01_08',race_date:'2026-11-22',deadline,status:'scheduled'};
const row = (id, stage, at, status = 'WATCH', extra = {}) => ({
  id, forecast_key:'V8_FORECAST_1:' + race.race_key + ':' + stage + ':' + id,
  race_id:race.id,race_key:race.race_key,race_date:race.race_date,stage,generated_at:at,created_date:at,deadline,
  decision:{status,odds_captured_at:'2026-11-22T04:39:00.000Z',valid_until:'2026-11-22T04:44:00.000Z'},
  ...extra,
});
const earlyBuy = () => row('buy-first','FINAL','2026-11-22T04:30:00Z','BUY');
const lateSkip = () => row('skip-later','FINAL','2026-11-22T04:37:00Z','SKIP');

test('reused JST formatter retains midnight, year and offset boundaries',()=>{
  for(const [at,offset,expected] of [
    ['2026-11-22T14:59:59.999Z',0,'2026-11-22'],
    ['2026-11-22T15:00:00.000Z',0,'2026-11-23'],
    ['2026-12-31T15:00:00.000Z',0,'2027-01-01'],
    ['2026-12-31T15:00:00.000Z',-1,'2026-12-31'],
    ['2026-12-30T15:00:00.000Z',1,'2027-01-01'],
    ['2028-02-28T15:00:00.000Z',1,'2028-03-01'],
  ]){
    const now=Date.parse(at);
    assert.equal(jstDate(offset,now),expected);
    assert.equal(jstDate(offset,now),new Date(now+offset*86400000).toLocaleDateString('sv-SE',{timeZone:'Asia/Tokyo'}));
  }
});
test('JST formatter keeps the previous Invalid Date result for invalid inputs',()=>{
  for(const [offset,now] of [[0,NaN],[0,Infinity],[0,8640000000000001],[NaN,NOW],[Infinity,NOW]]){
    assert.equal(jstDate(offset,now),'Invalid Date');
    assert.equal(jstDate(offset,now),new Date(now+offset*86400000).toLocaleDateString('sv-SE',{timeZone:'Asia/Tokyo'}));
  }
});

test('first published BUY remains the verification source after a later SKIP', () => {
  const canonical = canonicalForecasts([lateSkip(), earlyBuy()], NOW).rows;
  assert.equal(firstBuyForecasts(canonical).length, 1);
  assert.equal(firstBuyForecasts(canonical)[0].id, 'buy-first');
  assert.equal(latestForecasts(canonical)[0].id, 'skip-later');
  assert.equal(currentDecision(latestForecasts(canonical)[0], race, NOW), 'SKIP');
});
test('latest selection is independent per race and stage, not per generated row count', () => {
  const before = row('day','DAY_BEFORE','2026-11-21T10:00:00Z');
  const pre = row('pre','PRE','2026-11-22T01:00:00Z');
  const secondRace = {...lateSkip(),id:'race-two',race_id:'race-2',race_key:'2026-11-22_02_01',forecast_key:'race-two-key'};
  const selected = latestForecasts(canonicalForecasts([earlyBuy(),before,secondRace,pre,lateSkip()], NOW).rows);
  assert.equal(selected.length,4);
  assert.deepEqual(new Set(selected.filter(item=>item.race_id===race.id).map(item=>item.stage)),new Set(['DAY_BEFORE','PRE','FINAL']));
  assert.equal(selected.find(item=>item.race_id===race.id&&item.stage==='FINAL').id,'skip-later');
});
test('ambiguous forecast keys are held rather than selected by insertion order', () => {
  const a=earlyBuy(), duplicate={...a,id:'same-logical-key-2'};
  const result=canonicalForecasts([a,duplicate,lateSkip()], NOW);
  assert.deepEqual(result.conflicts,[a.forecast_key]);
  assert.deepEqual(result.rows.map(item=>item.id),['skip-later']);
  assert.equal(firstBuyForecasts(result.rows).length,0);
});
test('forecasts created at the cutoff are never eligible for prospective statistics', () => {
  const tooLate=row('late','FINAL','2026-11-22T04:59:00Z','BUY');
  assert.equal(eligibleForecast(tooLate,NOW),false);
  assert.equal(canonicalForecasts([tooLate],NOW).rows.length,0);
});
test('live BUY expires on the stored price deadline and on race closure', () => {
  const buy=earlyBuy();
  assert.equal(currentDecision(buy,race,NOW),'BUY');
  assert.equal(currentDecision(buy,race,Date.parse('2026-11-22T04:44:00Z')),'WAIT');
  assert.equal(currentDecision(buy,race,Date.parse('2026-11-22T04:59:00Z')),'CLOSED');
  assert.equal(currentDecision(buy,{...race,status:'finished'},NOW),'CLOSED');
  assert.equal(currentDecision(buy,{...race,status:'cancelled'},NOW),'CLOSED');
});
test('future forecasts and future quotes cannot become current BUY', () => {
  const future=row('future','FINAL','2026-11-22T04:45:00Z','BUY');
  assert.equal(eligibleForecast(future,NOW),false);
  assert.equal(canonicalForecasts([future],NOW).rows.length,0);
  const futureQuote={...earlyBuy(),decision:{status:'BUY',odds_captured_at:'2026-11-22T04:41:00Z',valid_until:'2026-11-22T04:46:00Z'}};
  assert.notEqual(currentDecision(futureQuote,race,NOW),'BUY');
});
test('a DAY_BEFORE label must match when the record was generated and actually stored', () => {
  const mislabeled=row('mislabeled','DAY_BEFORE','2026-11-22T01:00:00Z');
  assert.equal(eligibleForecast(mislabeled,NOW),false);
  const backdated=row('backdated','DAY_BEFORE','2026-11-21T10:00:00Z','WATCH',{created_date:'2026-11-22T01:00:00Z'});
  assert.equal(eligibleForecast(backdated,NOW),false);
  const proper=row('proper','DAY_BEFORE','2026-11-21T10:00:00Z');
  assert.equal(eligibleForecast(proper,NOW),true);
});
test('current BUY is not reusable for a different race identity', () => {
  assert.notEqual(currentDecision(earlyBuy(),{...race,id:'other-race',race_key:'2026-11-22_02_08'},NOW),'BUY');
});
test('public row excludes private recorder identity fields', () => {
  const source={...earlyBuy(),created_by:'private@example.com',created_by_id:'private-user',recorded_by_id:'private-user'};
  const result=publicRow(source);
  assert.equal(Object.hasOwn(result,'created_by'),false);
  assert.equal(Object.hasOwn(result,'created_by_id'),false);
  assert.equal(Object.hasOwn(result,'recorded_by_id'),false);
  assert.equal(result.id,source.id);
});

test('valid previous-day and pre-exhibition candidates keep WATCH without becoming BUY', () => {
  const before=row('before','DAY_BEFORE','2026-11-21T10:00:00Z');
  const pre=row('pre','PRE','2026-11-22T01:00:00Z');
  assert.equal(currentDecision(before,race,NOW),'WATCH');
  assert.equal(currentDecision(pre,race,NOW),'WATCH');
  assert.equal(currentDecision({...pre,decision:{status:'BUY'}},race,NOW),'WAIT');
  assert.equal(currentDecision({...pre,decision:{status:'WAIT'}},race,NOW),'WAIT');
  assert.equal(currentDecision({...pre,decision:{status:'SKIP'}},race,NOW),'SKIP');
});
test('pre-exhibition status still respects closure, cutoff and race identity guards', () => {
  const pre=row('pre','PRE','2026-11-22T01:00:00Z');
  assert.equal(currentDecision(pre,{...race,status:'finished'},NOW),'CLOSED');
  assert.equal(currentDecision(pre,{...race,status:'cancelled'},NOW),'CLOSED');
  assert.equal(currentDecision(pre,race,Date.parse('2026-11-22T04:59:00Z')),'CLOSED');
  assert.equal(currentDecision(pre,{...race,id:'other-race'},NOW),'WAIT');
  assert.equal(currentDecision(pre,{...race,deadline:'2026-11-22T05:05:00Z'},NOW),'WAIT');
});

test('cursor pagination follows has_more even for short pages and preserves filter binding', async () => {
  const query={race_date:'2026-11-22'};
  const entity={
    calls:[],
    async filter(...args) {
      assert.equal(args.length,2);
      const [received,options]=args;
      assert.deepEqual(received,query);
      assert.equal(options.sort,'-captured_at');
      assert.equal(options.limit,200);
      this.calls.push(options);
      if(!options.cursor)return {items:[{id:'first'}],has_more:true,next_cursor:'after-first'};
      assert.equal(options.cursor,'after-first');
      return {items:[{id:'second'}],has_more:false,next_cursor:null};
    },
  };
  const result=await readV8Rows(entity,query,{sort:'-captured_at'});
  assert.deepEqual(result.map(item=>item.id),['first','second']);
  assert.equal(entity.calls.length,2);
  assert.equal(Object.hasOwn(entity.calls[0],'cursor'),false);
  assert.equal(Object.hasOwn(entity.calls[0],'fields'),false);
});
test('optional field projection is sent unchanged on every cursor without shortening a complete ledger',async()=>{
  const fields=['id','forecast_key','decision.status','final_selection.ranked_tickets.ticket'],calls=[];
  const entity={filter:async(query,options)=>{
    calls.push(structuredClone(options));assert.equal(options.fields,fields);
    return options.cursor?{items:[{id:'second',decision:{status:'BUY'}}],has_more:false,next_cursor:null}
      :{items:[{id:'first',decision:{status:'WATCH'}}],has_more:true,next_cursor:'next-projected'};
  }};
  const result=await readV8Rows(entity,{race_date:'2026-11-22'},{fields});
  assert.deepEqual(result.map(row=>row.id),['first','second']);assert.equal(calls.length,2);
  assert.equal(calls[1].cursor,'next-projected');assert.equal(calls[1].limit,200);
});
test('projected reads still reject a missing row identity or incomplete final cursor',async()=>{
  await assert.rejects(readV8Rows({filter:async()=>({items:[{decision:{status:'BUY'}}],has_more:false})},{},{fields:'id,decision.status'}),/page_row_invalid_or_repeated/);
  await assert.rejects(readV8Rows({filter:async()=>({items:[{id:'one'}],has_more:true,next_cursor:null})},{},{fields:'id,decision.status'}),/continuation_invalid_or_repeated/);
});
test('an array response is never accepted as a complete V8 ledger', async () => {
  let calls=0;
  await assert.rejects(readV8Rows({filter:async()=>{calls++;return [{id:'row-1'}];}},{}),/INCOMPLETE_READ:page_format_invalid/);
  assert.equal(calls,1);
});
test('repeated rows and invalid cursor continuations fail instead of returning partial data', async () => {
  const cases=[
    {pages:[{items:[{id:'same'}],has_more:true,next_cursor:'next'},{items:[{id:'same'}],has_more:false}],reason:/page_row_invalid_or_repeated/},
    {pages:[{items:[{id:'first'}],has_more:true,next_cursor:null}],reason:/continuation_invalid_or_repeated/},
    {pages:[{items:[{id:'first'}],has_more:false,next_cursor:'unexpected'}],reason:/terminal_cursor_invalid/},
    {pages:[{items:[{id:'first'}],has_more:true,next_cursor:'same-cursor'},{items:[{id:'second'}],has_more:true,next_cursor:'same-cursor'}],reason:/continuation_invalid_or_repeated/},
  ];
  for(const sample of cases){
    let calls=0;
    await assert.rejects(readV8Rows({filter:async()=>sample.pages[calls++]},{}),sample.reason);
    assert.equal(calls,sample.pages.length);
  }
});
test('page limits and exhausted read budgets cannot publish incomplete ledgers', async () => {
  await assert.rejects(readV8Rows({filter:async()=>({items:[{id:'first'}],has_more:true,next_cursor:'next'})},{},{maxPages:1}),/page_safety_limit/);
  let calls=0;
  await assert.rejects(readV8Rows({filter:async()=>{calls++;return {items:[],has_more:false};}},{},{budget:Date.now()-1}),/read_budget_exhausted/);
  assert.equal(calls,0);
});

const flush=()=>new Promise(resolve=>setImmediate(resolve));
const readError=(status,extra={})=>Object.assign(new Error('private upstream details'),status==null?extra:{response:{status,...extra}});

test('transient page reads recover with at most three attempts on the same query and cursor',async(t)=>{
  t.mock.timers.enable({apis:['Date','setTimeout'],now:NOW});
  const calls=[],query={race_date:'2026-11-22'};
  const entity={async filter(q,options){
    calls.push({q,options,at:Date.now()});
    if(calls.length===1)throw readError('503');
    if(calls.length===2)throw readError(null,{code:'ECONNRESET'});
    return options.cursor?{items:[{id:'second'}],has_more:false}:{items:[{id:'first'}],has_more:true,next_cursor:'next'};
  }};
  const pending=readV8Rows(entity,query,{budget:NOW+5000,sort:'-captured_at'});
  await flush();
  assert.equal(calls.length,1);
  t.mock.timers.tick(199);await flush();assert.equal(calls.length,1);
  t.mock.timers.tick(1);await flush();assert.equal(calls.length,2);
  t.mock.timers.tick(499);await flush();assert.equal(calls.length,2);
  t.mock.timers.tick(1);await flush();
  assert.deepEqual((await pending).map(row=>row.id),['first','second']);
  assert.deepEqual(calls.map(call=>call.at),[NOW,NOW+200,NOW+700,NOW+700]);
  for(const call of calls.slice(0,3)){
    assert.strictEqual(call.q,query);
    assert.deepEqual(call.options,{sort:'-captured_at',limit:200});
  }
  assert.equal(calls[3].options.cursor,'next');
});

test('permanent HTTP errors and non-network exceptions never retry or disclose upstream details',async()=>{
  for(const status of [400,401,403,404,408,422]){
    let calls=0;
    await assert.rejects(readV8Rows({filter:async()=>{calls++;throw readError(status);}},{race_date:'2026-11-22'}),error=>{
      assert.equal(error.message,'INCOMPLETE_READ:page_read_failed_or_timed_out');
      assert.equal(error.http_status,status);
      assert.equal(error.message.includes('private'),false);
      return true;
    });
    assert.equal(calls,1);
  }
  let calls=0;
  await assert.rejects(readV8Rows({filter:async()=>{calls++;throw new TypeError('malformed SDK configuration');}},{}),error=>{
    assert.equal(error.http_status,undefined);return true;
  });
  assert.equal(calls,1);
});

test('Retry-After seconds and HTTP dates are respected before another read',async(t)=>{
  t.mock.timers.enable({apis:['Date','setTimeout'],now:NOW});
  for(const kind of ['seconds','date']){
    const start=Date.now();let calls=0;
    const headers=kind==='seconds'?{'retry-after':'2'}:new Headers({'Retry-After':new Date(start+2000).toUTCString()});
    const pending=readV8Rows({filter:async()=>{
      calls++;if(calls===1)throw readError(429,{headers});
      return {items:[{id:kind}],has_more:false};
    }},{},{budget:start+5000});
    await flush();assert.equal(calls,1);
    t.mock.timers.tick(1999);await flush();assert.equal(calls,1);
    t.mock.timers.tick(1);await flush();
    assert.deepEqual(await pending,[{id:kind}]);
    assert.equal(calls,2);
  }
});

test('a retry that cannot fit the remaining page or request budget fails without another read',async(t)=>{
  t.mock.timers.enable({apis:['Date','setTimeout'],now:NOW});
  for(const sample of [{remaining:100,retryAfter:null},{remaining:5000,retryAfter:'6'},{remaining:35000,retryAfter:'11'}]){
    let calls=0;
    const headers=sample.retryAfter?{'retry-after':sample.retryAfter}:{};
    await assert.rejects(readV8Rows({filter:async()=>{calls++;throw readError(429,{headers});}},{},{budget:NOW+sample.remaining}),error=>{
      assert.equal(error.message,'INCOMPLETE_READ:retry_budget_exhausted');
      assert.equal(error.http_status,429);return true;
    });
    assert.equal(calls,1);
  }
});

test('budget expiry during backoff stops all further reads',async(t)=>{
  t.mock.timers.enable({apis:['Date','setTimeout'],now:NOW});
  let calls=0;
  const pending=assert.rejects(readV8Rows({filter:async()=>{calls++;throw readError(503);}},{},{budget:NOW+250}),error=>{
    assert.match(error.message,/^INCOMPLETE_READ:/);
    assert.equal(error.http_status,503);return true;
  });
  await flush();assert.equal(calls,1);
  t.mock.timers.tick(300);await flush();await pending;
  t.mock.timers.tick(1000);await flush();assert.equal(calls,1);
});

test('three exhausted attempts expose only the last safe status and never partial earlier pages',async(t)=>{
  t.mock.timers.enable({apis:['Date','setTimeout'],now:NOW});
  const calls=[];
  const pending=assert.rejects(readV8Rows({filter:async(q,options)=>{
    calls.push(options);
    if(!options.cursor)return {items:[{id:'partial'}],has_more:true,next_cursor:'page-two'};
    throw readError([502,503,504][calls.length-2]);
  }},{},{budget:NOW+5000}),error=>{
    assert.equal(error.message,'INCOMPLETE_READ:page_read_failed_or_timed_out');
    assert.equal(error.http_status,504);
    assert.equal(Object.hasOwn(error,'rows'),false);return true;
  });
  await flush();t.mock.timers.tick(200);await flush();t.mock.timers.tick(500);await flush();await pending;
  assert.equal(calls.length,4);
  assert.deepEqual(calls.slice(1).map(call=>call.cursor),['page-two','page-two','page-two']);
});

test('a recovered transport error cannot mask an invalid response or attach a stale HTTP status',async(t)=>{
  t.mock.timers.enable({apis:['Date','setTimeout'],now:NOW});
  let calls=0;
  const pending=assert.rejects(readV8Rows({filter:async()=>{
    calls++;if(calls===1)throw readError(503);return [{id:'invalid-array'}];
  }},{},{budget:NOW+5000}),error=>{
    assert.equal(error.message,'INCOMPLETE_READ:page_format_invalid');
    assert.equal(error.http_status,undefined);return true;
  });
  await flush();t.mock.timers.tick(200);await flush();await pending;
  assert.equal(calls,2);
});
