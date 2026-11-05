// Reuse existing read APIs, with injection for local contract tests.
import {selectFinalResult} from "./resultInput.js";
import {buildDataQuality} from "./dataQuality.js";
// Base44 entity metadata timestamps are UTC even when SDK returns an ISO string
// without a zone suffix (often with six fractional digits). Only normalize
// known Base44 metadata fields; race deadlines must retain explicit offsets.
function platformUtc(value) {
 if(typeof value!=='string')return value;
 const m=/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?$/.exec(value);
 if(!m)return value;
 return m[1]+(m[2]?'.'+m[2].slice(0,3).padEnd(3,'0'):'')+'Z';
}
function withBase44MetadataTime(row){
 return row?{...row,updated_date:platformUtc(row.updated_date)}:row;
}
export function createLiveReader(client,readEntries,{readFetchLogs=null,readRace=id=>client.entities.Race.get(id),readResultRows=id=>client.entities.RaceResult.filter({race_id:id},"-finished_at",10)}={}){return async function readLiveRace(id){
 const race=withBase44MetadataTime(await readRace(id));
 if(!race)throw Error('レースが見つかりません');
 let logError=null;
 const logRequest=readFetchLogs?readFetchLogs(race).catch(e=>{logError="取得ログ未確認："+e.message;return [];}):Promise.resolve([]);
 const [entries,odds,results,logs]=await Promise.all([
  readEntries(id,race.race_key),
  client.entities.OddsSnapshot.filter({race_id:id},'-captured_at',20),
  readResultRows(id),
  logRequest,
 ]);
 const normalizedEntries=(entries||[]).map(withBase44MetadataTime);
 const normalizedOdds=(odds||[]).map(o=>({...withBase44MetadataTime(o),captured_at:platformUtc(o.captured_at)}));
 const normalizedResults=(results||[]).map(o=>({...withBase44MetadataTime(o),finished_at:platformUtc(o.finished_at)}));
 const result=selectFinalResult(normalizedResults,id);
 return {race,entries:normalizedEntries,odds:normalizedOdds,result,quality:buildDataQuality({race,entries:normalizedEntries,odds:normalizedOdds,result,logs,logError,observedAt:new Date().toISOString()})};
};}