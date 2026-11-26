import test from 'node:test';
import assert from 'node:assert/strict';
import {venueEvidenceView, venueRateText} from '../src/components/liveV8/v8VenueView.js';

function evidence(){return {revision:'V8_VENUE_EVIDENCE_1',status:'READY',used:true,inside_favored:true,baseline_profile_reused:true,change_note:'場の資料は事前保存と同じです。',
  profile:{revision:'V8_VENUE_PROFILE_1',status:'READY',source:'BOATRACE_STADIUM',venue_code:'08',course_basis:'ACTUAL_ENTRY_COURSE',
    source_url:'https://www.boatrace.jp/owpc/pc/data/stadium?jcd=08',period_start:'2026-08-01',period_end:'2026-10-31',sample_size:null,
    courses:Object.fromEntries(Array.from({length:6},(_,i)=>[String(i+1),{course:i+1,first_rate:i===0?57.4:8,top2_rate:70,top3_rate:80,sample_size:null,winning_methods:{逃げ:i===0?95:0,差し:0,まくり:0,まくり差し:0,抜き:0,恵まれ:0}}]))}};}

test('venue first-place percentages and conditional winning methods keep separate denominators',()=>{
  const saved=evidence(),before=structuredClone(saved),view=venueEvidenceView(saved,{venue_code:8});
  assert.equal(view.available,true);assert.equal(view.first_rate,57.4);
  assert.equal(view.rows[0].methods.find(row=>row.method==='逃げ').rate,95);
  assert.equal(view.sample_label,'公式ページに件数の掲載なし');assert.equal(view.rows[0].sample_size,null);
  assert.equal(view.period,'2026/08/01〜2026/10/31');assert.equal(view.same_profile,true);assert.equal(view.used,true);
  assert.deepEqual(saved,before);
});

test('venue zero values remain zero; missing inputs never turn into zero or fabricated large/small sample labels',()=>{
  const saved=evidence();saved.profile.courses['2'].first_rate=0;saved.profile.courses['3'].first_rate=null;
  saved.profile.courses['4'].first_rate='';saved.profile.courses['5'].first_rate=101;
  const view=venueEvidenceView(saved,{venue_code:'08'});
  assert.equal(venueRateText(view.rows[1].first_rate),'0.0%');
  for(const index of [2,3,4])assert.equal(venueRateText(view.rows[index].first_rate),'未取得');
  assert.equal(view.sample_label,'公式ページに件数の掲載なし');
});

test('old, wrong-venue and nonofficial snapshots are not filled with a current master profile',()=>{
  assert.equal(venueEvidenceView(null,{venue_code:'08'}).reason,'NOT_SAVED');
  assert.equal(venueEvidenceView(evidence(),{venue_code:'24'}).reason,'VENUE_MISMATCH');
  const saved=evidence();saved.profile.source='OTHER';assert.equal(venueEvidenceView(saved,{venue_code:'08'}).available,false);
  const unsafe=evidence();unsafe.profile.source_url='javascript:alert(1)';assert.equal(venueEvidenceView(unsafe,{venue_code:'08'}).source_url,null);
  const unapplied=evidence();unapplied.used=false;assert.equal(venueEvidenceView(unapplied,{venue_code:'08'}).used,false);
});
