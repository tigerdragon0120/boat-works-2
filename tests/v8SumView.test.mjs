import test from 'node:test';
import assert from 'node:assert/strict';
import {originalTimingSummary, savedSumView, sumDifferenceText, sumModelStatus, sumTimeText} from '../src/components/liveV8/v8SumView.js';

const evidence = (extra = {}) => ({status:'READY',active_count:6,selected_model:'SUM_BASIC',used_for_scoring:true,basic:{key:'SUM_BASIC',status:'READY',mean:43.853333,boats:[]},venue_specific:{key:'SUM_AMAGASAKI',status:'UNSUPPORTED_VENUE'},...extra});

test('old saved forecasts remain visibly unmeasured without fabricated SUM values', () => {
  const view=savedSumView({stage:'FINAL',boats:[{boat_number:1,exhibition_time:6.73}]});
  assert.equal(view.state,'LEGACY');assert.equal(view.applied,false);assert.equal(view.selected,null);
  assert.equal(originalTimingSummary({stage:'FINAL',boats:[{boat_number:1,exhibition_time:6.73}]}),'未計測の保存記録');
});

test('pre-exhibition records cannot claim a SUM scoring contribution', () => {
  for(const stage of ['PRE','DAY_BEFORE']) {
    const view=savedSumView({stage,sum_evidence:evidence()});
    assert.equal(view.state,'PRE');assert.equal(view.applied,false);assert.equal(view.selected,null);
    assert.equal(originalTimingSummary({stage,boats:[{lap_time:36.04}]}),'事前予想には不使用');
  }
});

test('the saved selected model and active starter count control the display', () => {
  const meta=evidence({active_count:5,selected_model:'SUM_AMAGASAKI',mean_basis:'ACTIVE_STARTERS_EXTENSION',venue_specific:{key:'SUM_AMAGASAKI',status:'READY',mean:50.85}});
  const view=savedSumView({stage:'FINAL',sum_evidence:meta});
  assert.equal(view.activeCount,5);assert.equal(view.selected.key,'SUM_AMAGASAKI');assert.equal(view.applied,true);
  assert.match(view.label,/尼崎・3項SUM/);
  // The presentation helper neither modifies nor calculates a missing mean.
  assert.equal(view.selected.mean,50.85);assert.equal(meta.basic.mean,43.853333);
});

test('invalid or incomplete evidence is not shown as used even with stale selection fields', () => {
  for(const status of ['INVALID','INSUFFICIENT','WAIT_EXHIBITION']) {
    const view=savedSumView({stage:'FINAL',sum_evidence:evidence({status})});
    assert.equal(view.applied,false);assert.notEqual(view.state,'READY');assert.doesNotMatch(view.label,/予想に反映/);
  }
});

test('the acquisition count excludes scratched boats and distinguishes optional missing times', () => {
  const boats=Array.from({length:6},(_,i)=>({boat_number:i+1,active:i!==5,lap_time:36+i/10,turn_time:i===2?null:8,straight_time:null}));
  const result=originalTimingSummary({stage:'FINAL',sum_evidence:evidence({active_count:5}),boats});
  assert.equal(result,'1周 5/5艇 · 周り足 4/5艇 · 直線 0/5艇');
});

test('zero and absent timing values stay missing while a real zero difference remains visible', () => {
  for(const value of [null,undefined,NaN,Infinity,'36.04',0,-1])assert.equal(sumTimeText(value),'—');
  assert.equal(sumTimeText(36.04),'36.04');assert.equal(sumDifferenceText(0),'0.00');
  assert.equal(sumDifferenceText(-0.001),'0.00');assert.equal(sumDifferenceText(1.083333),'+1.08');
  assert.equal(sumDifferenceText(-0.15),'-0.15');assert.equal(sumDifferenceText(null),'—');
  assert.equal(sumModelStatus({status:'WAIT_EXHIBITION'}),'展示待ち');
  assert.equal(sumModelStatus({status:'UNSUPPORTED_VENUE'}),'対象場外');
});

test('unpublished measurements do not imply that repeated fetching will eventually produce SUM', () => {
  const cases=[['HALF_LAP_NOT_SUPPORTED','半周タイムのみ'],['MEASUREMENT_UNAVAILABLE','計測なし'],['LAP_TIME_NOT_PUBLISHED','1周タイム非公開']];
  for(const [reason,label] of cases) {
    const meta=evidence({status:'INSUFFICIENT',selected_model:null,used_for_scoring:false,acquisition_reasons:[reason]});
    const view=savedSumView({stage:'FINAL',sum_evidence:meta});
    assert.equal(view.state,'UNAVAILABLE');assert.match(view.label,/SUM未適用/);assert.ok(view.label.includes(label));
    assert.doesNotMatch(view.label,/取得待ち|再取得待ち/);
    assert.equal(sumModelStatus({status:'INSUFFICIENT',sum_evidence:meta}),'SUM未適用');
  }
});

test('network failures are retry states and a roster conflict stays a verification state', () => {
  for(const reason of ['HTTP_403','HTTP_404','HTTP_429','FETCH_TIMEOUT','FETCH_FAILED','FETCH_TIME_BUDGET']) {
    const view=savedSumView({stage:'FINAL',sum_evidence:evidence({status:'INSUFFICIENT',selected_model:null,acquisition_reasons:[reason]})});
    assert.equal(view.state,'RETRY');assert.match(view.label,/再取得待ち/);assert.equal(view.applied,false);
  }
  for(const reason of ['ROSTER_AMBIGUOUS','SOURCE_RACER_MISMATCH','EXHIBITION_RACER_MISMATCH']) {
    const view=savedSumView({stage:'FINAL',sum_evidence:evidence({status:'INSUFFICIENT',selected_model:null,acquisition_reasons:[reason]})});
    assert.equal(view.state,'INVALID');assert.match(view.detail,/出走艇・選手/);
  }
});

test('valid basic SUM still shows applied when the optional venue component is missing', () => {
  const view=savedSumView({stage:'FINAL',sum_evidence:evidence({missing:['BOAT_1_SUM_INPUT_MISSING'],venue_specific:{key:'SUM_AMAGASAKI',status:'INSUFFICIENT'}})});
  assert.equal(view.state,'READY');assert.equal(view.applied,true);assert.match(view.label,/基本SUM/);
});

test('an equal-SUM comparator is labelled as no difference instead of missing measurements', () => {
  assert.equal(sumModelStatus({status:'INSUFFICIENT',missing:['SUM_NO_DIFFERENCE'],sum_evidence:{status:'READY'}}),'差なし');
});
