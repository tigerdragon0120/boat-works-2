import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {parseBeforeInfo} from '../base44/shared/boatraceOfficialParser.js';
import {isSavedExhibitionComplete} from '../base44/shared/liveInputPriority.js';

// Actual official beforeinfo fragments. Both pages explicitly mark racer 3605
// as is-miss; independently observed official results also show 欠.
const fixture=n=>readFileSync(new URL('./fixtures/official-beforeinfo-20261122-gamagori'+n+'.html',import.meta.url),'utf8');
for(const [race,missingBoat] of [['02',3],['08',2]]){
  test('observed Gamagori '+race+' keeps five complete active boats and explicit absence',()=>{
    const output=parseBeforeInfo(fixture(race));
    assert.equal(output.ok,true);assert.deepEqual(output.errors,[]);
    assert.equal(output.data.entries.length,6);assert.equal(output.data.active_boat_count,5);assert.equal(output.data.real_exhibition_count,5);
    assert.deepEqual(output.data.scratched_boats,[missingBoat]);
    const missing=output.data.entries.find(row=>row.boat_number===missingBoat);
    assert.equal(missing.registration_number,'3605');assert.equal(missing.is_absent,true);assert.equal(missing.is_scratched,true);
    assert.equal(missing.exhibition_time,null);assert.equal(missing.exhibition_st,null);assert.equal(missing.exhibition_course,null);assert.equal(missing.tilt,null);
    assert.equal(isSavedExhibitionComplete(output.data.entries,output.data.scratched_boats),true);
  });
}
test('the next player supplies only its own time, and numeric zero/F ST are preserved',()=>{
  const r2=parseBeforeInfo(fixture('02')).data.entries,r8=parseBeforeInfo(fixture('08')).data.entries;
  assert.equal(r2.find(row=>row.boat_number===4).exhibition_time,6.66);
  assert.equal(r2.find(row=>row.boat_number===2).exhibition_st,0);
  assert.equal(r8.find(row=>row.boat_number===3).exhibition_time,6.77);
  assert.equal(r8.find(row=>row.boat_number===1).exhibition_st,-0.03);
  assert.equal(r2.find(row=>row.boat_number===4).exhibition_course,3);
  assert.equal(r8.find(row=>row.boat_number===3).exhibition_course,2);
});
test('a synthetic unmarked blank player is incomplete, never inferred as absent',()=>{
  const output=parseBeforeInfo(fixture('02').replace('is-fs12 is-miss','is-fs12'));
  assert.equal(output.ok,false);assert.deepEqual(output.data.scratched_boats,[]);
  assert.equal(output.data.active_boat_count,6);assert.equal(output.data.real_exhibition_count,5);
  assert.equal(output.data.entries.find(row=>row.boat_number===3).is_absent,false);
});
test('repeated player bodies are ambiguous and cannot be treated as complete',()=>{
  const html=fixture('02'),body=[...html.matchAll(/<tbody\b[^>]*>[\s\S]*?<\/tbody>/gi)].map(match=>match[0]).find(row=>row.includes('toban=3605'));
  const output=parseBeforeInfo(html+body);
  assert.equal(output.ok,false);assert.ok(output.errors.some(error=>error.includes('3605')));
});
test('tbody identity preserves boat numbers when observed player body order changes',()=>{
  const html=fixture('02'),bodies=[...html.matchAll(/<tbody\b[^>]*>[\s\S]*?<\/tbody>/gi)].map(match=>match[0]).filter(row=>row.includes('toban='));
  const changed=html.replace(bodies[0],'@@FIRST@@').replace(bodies[1],bodies[0]).replace('@@FIRST@@',bodies[1]);
  const output=parseBeforeInfo(changed);
  assert.equal(output.ok,true);assert.equal(output.data.entries.find(row=>row.registration_number==='4750').boat_number,1);
  assert.equal(output.data.entries.find(row=>row.registration_number==='4563').boat_number,2);
  assert.deepEqual(output.data.scratched_boats,[3]);
});
