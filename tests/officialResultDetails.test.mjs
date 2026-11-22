import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {parseResult} from '../base44/shared/boatraceOfficialParser.js';

// These fragments were fetched from the actual official Suminoe 8R result page.
// The F/L and malformed variants below are explicitly synthetic, not race claims.
const observed=readFileSync(new URL('./fixtures/official-result-20261122-suminoe08.html',import.meta.url),'utf8');
const parse=html=>{const output=parseResult(html,'2026-11-22','12','住之江');assert.equal(output.ok,true);return output.data.venues[0].results[0];};
const tables=[...observed.matchAll(/<table\b[^>]*>[\s\S]*?<\/table>/gi)].map(match=>match[0]);
const finish=tables.find(table=>table.includes('<th>着</th>'));
const starts=tables.find(table=>table.includes('<th>スタート情報</th>'));

test('observed official finish table retains six boats despite internal name spaces',()=>{
  const result=parse(observed);
  assert.equal(result.result_trifecta,'1-2-4');assert.equal(result.payout,480);assert.equal(result.winning_method,'抜き');
  assert.deepEqual(result.finish_order,[1,2,4,3,5,6]);assert.equal(result.entries.length,6);
  assert.equal(result.entries[0].player_name,'土屋千明');assert.equal(result.entries[4].player_name,'内田壮');
  assert.equal(result.entries[0].race_time,"1'48\"0");assert.equal(result.entries[0].st,0.18);
  assert.equal(result.details_complete,true);assert.equal(result.details_revision,'OFFICIAL_RESULT_TABLE_V1');assert.deepEqual(result.details_missing,[]);
});

test('explicit synthetic F/L cells survive without invented numeric ranks or times',()=>{
  const nonfinish=finish.replace('<td class="is-fs14">５</td>','<td class="is-fs14">Ｆ</td>')
    .replace('<td class="is-fs14">６</td>','<td class="is-fs14">Ｌ</td>')
    .replace("<td>1'52\"9</td>",'<td>&nbsp;</td>').replace("<td>1'55\"9</td>",'<td>&nbsp;</td>');
  const result=parse(observed.replace(finish,nonfinish).replace(starts,''));
  assert.equal(result.details_complete,true);assert.deepEqual(result.finish_order,[1,2,4,3]);
  const f=result.entries.find(row=>row.boat_number===5),l=result.entries.find(row=>row.boat_number===6);
  assert.equal(f.result_status,'F');assert.equal(f.f_flag,'F');assert.equal(l.result_status,'L');assert.equal(l.f_flag,'L');
  for(const row of [f,l]){assert.equal(Object.hasOwn(row,'finish_order'),false);assert.equal(row.race_time,'');assert.equal(row.st,null);assert.equal(Object.hasOwn(row,'course'),false);}
});

test('synthetic changed entry order supplies observed course and signed F start only',()=>{
  const order=[6,1,2,3,4,5],tokens={1:'.18',2:'.22',3:'.28',4:'.19',5:'F.03',6:'L'};
  const synthetic='<table><thead><tr><th>スタート情報</th></tr></thead><tbody>'+order.map(boat=>'<tr><td><span class="table1_boatImage1Number is-type'+boat+'">'+boat+'</span><span class="table1_boatImage1TimeInner">'+tokens[boat]+'</span></td></tr>').join('')+'</tbody></table>';
  const result=parse(observed.replace(starts,synthetic));
  assert.equal(result.entries.find(row=>row.boat_number===1).course,2);
  assert.equal(result.entries.find(row=>row.boat_number===5).course,6);
  assert.equal(result.entries.find(row=>row.boat_number===5).st,-0.03);
  assert.equal(result.entries.find(row=>row.boat_number===5).f_flag,'F');
  assert.equal(result.entries.find(row=>row.boat_number===6).st,null);
  assert.equal(result.entries.find(row=>row.boat_number===6).f_flag,'L');
});

test('missing start cell cannot borrow a numeric value from another boat',()=>{
  const missing=starts.replace('.18','&nbsp;');
  const result=parse(observed.replace(starts,missing));
  assert.equal(result.entries.find(row=>row.boat_number===1).st,null);
  assert.equal(result.entries.find(row=>row.boat_number===2).st,0.22);
});

test('duplicate boat rows and duplicate finish tables never claim complete details',()=>{
  const lastRow=[...finish.matchAll(/<tr\b[^>]*>[\s\S]*?<\/tr>/gi)].at(-1)[0];
  const doubled=finish.replace('</table>',lastRow+'</table>');
  const repeated=parse(observed.replace(finish,doubled));
  assert.equal(repeated.details_complete,false);assert.equal(repeated.entries.length,0);
  assert.ok(repeated.details_missing.includes('FINISH_ROWS_INVALID_OR_REPEATED'));
  const tablesRepeated=parse(observed+finish);
  assert.equal(tablesRepeated.details_complete,false);assert.ok(tablesRepeated.details_missing.includes('FINISH_TABLE_AMBIGUOUS'));
});

test('finish-place and trifecta inconsistencies are explicit incomplete details',()=>{
  const duplicatePlace=parse(observed.replace(finish,finish.replace('<td class="is-fs14">６</td>','<td class="is-fs14">５</td>')));
  assert.equal(duplicatePlace.details_complete,false);assert.ok(duplicatePlace.details_missing.includes('FINISH_PLACES_INVALID'));
  const conflict=parse('3連単 1-2-3 ¥480 '+observed);
  assert.equal(conflict.details_complete,false);assert.ok(conflict.details_missing.includes('FINISH_TRIFECTA_MISMATCH'));
});

test('payout-only response retains outcome but cannot claim verified boat details',()=>{
  const result=parse('3連単 1-2-4 ¥480 決まり手 抜き');
  assert.deepEqual(result.entries,[]);assert.equal(result.details_complete,false);assert.ok(result.details_missing.includes('FINISH_TABLE_MISSING'));
});

test('existing longest winning-method match remains intact',()=>{
  assert.equal(parse(observed.replaceAll('抜き','まくり差し')).winning_method,'まくり差し');
});
