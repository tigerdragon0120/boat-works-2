import test from 'node:test';
import assert from 'node:assert/strict';
import {exhibitionForecastEmptyState} from '../src/components/liveV8/v8ExhibitionEmptyState.js';

const race={id:'race-edogawa-2',race_key:'2026-11-28_03_02',status:'scheduled',exhibition_ready:true,
  deadline:'2026-11-28T11:34:00+09:00'};
const at=time=>Date.parse('2026-11-28T'+time+'+09:00');

test('the observed delayed deadline follows the current race across its live cutoff',()=>{
  // PRE was saved against 11:25. Its separate validity WAIT cannot keep the
  // empty FINAL in a normal live-saving state after the corrected 11:34 cutoff.
  const oldDeadline='2026-11-28T11:25:00+09:00';
  assert.ok(at('11:30:00')>Date.parse(oldDeadline));
  assert.equal(exhibitionForecastEmptyState({race,now:at('11:30:00')}).step,'保存待ち');
  assert.equal(exhibitionForecastEmptyState({race,now:at('11:32:59')}).step,'保存待ち');
  assert.equal(exhibitionForecastEmptyState({race,now:at('11:33:00')}).step,'事後補完待ち');
  const late=exhibitionForecastEmptyState({race,now:at('11:34:00')});
  assert.equal(late.title,'事後検証の補完を待っています');
  assert.match(late.detail,/事後検証として保存/);
});

test('an earlier corrected deadline closes the empty stage before an older forecast deadline',()=>{
  const corrected={...race,deadline:'2026-11-28T11:25:00+09:00'};
  assert.equal(exhibitionForecastEmptyState({race:corrected,now:at('11:30:00')}).step,'事後補完待ち');
});

test('missing or invalid current deadline stays unconfirmed instead of using an old forecast deadline',()=>{
  for(const deadline of [null,undefined,'','not-a-date']){
    const view=exhibitionForecastEmptyState({race:{...race,deadline},now:at('11:40:00')});
    assert.equal(view.step,'締切確認待ち');
  }
  assert.equal(exhibitionForecastEmptyState({race,now:NaN}).step,'締切確認待ち');
});

test('an unconfirmed or failed read takes precedence over old ready, finished and cancelled data',()=>{
  for(const status of ['scheduled','finished','cancelled']){
    const view=exhibitionForecastEmptyState({race:{...race,status},now:at('11:40:00'),unavailable:true});
    assert.equal(view.step,'確認待ち');assert.doesNotMatch(view.title,/補完|中止/);
  }
  assert.equal(exhibitionForecastEmptyState({now:at('11:40:00')}).step,'確認待ち');
});

test('confirmed finished and cancelled race states remain authoritative',()=>{
  assert.equal(exhibitionForecastEmptyState({race:{...race,status:'finished',deadline:null},now:at('11:20:00')}).step,'事後補完待ち');
  assert.equal(exhibitionForecastEmptyState({race:{...race,status:'cancelled'},now:at('11:20:00')}).step,'中止');
});

test('exhibition acquisition and saved-input waiting stay distinct before and after cutoff',()=>{
  const missing={...race,exhibition_ready:false};
  assert.equal(exhibitionForecastEmptyState({race:missing,now:at('11:30:00')}).step,'展示待ち');
  assert.equal(exhibitionForecastEmptyState({race:missing,now:at('11:40:00')}).step,'展示再取得待ち');
  const utc={...race,deadline:'2026-11-28T02:34:00.000000'};
  assert.equal(exhibitionForecastEmptyState({race:utc,now:at('11:34:00')}).step,'事後補完待ち');
});
