// Reuse existing read APIs, with injection for local contract tests.
import {selectFinalResult} from "./resultInput.js";
import {buildDataQuality} from "./dataQuality.js";
export function createLiveReader(client,readEntries,{readFetchLogs=null,readRace=id=>client.entities.Race.get(id),readResultRows=id=>client.entities.RaceResult.filter({race_id:id},"-finished_at",10)}={}){return async function readLiveRace(id){
 const race=await readRace(id);
 if(!race)throw Error('レースが見つかりません');
 let logError=null;
 const logRequest=readFetchLogs?readFetchLogs(race).catch(e=>{logError="取得ログ未確認："+e.message;return [];}):Promise.resolve([]);
 const [entries,odds,results,logs]=await Promise.all([
  readEntries(id,race.race_key),
  client.entities.OddsSnapshot.filter({race_id:id},'-captured_at',20),
  readResultRows(id),
  logRequest,
 ]);
 const result=selectFinalResult(results||[],id);return {race,entries,odds:odds||[],result,quality:buildDataQuality({race,entries,odds:odds||[],result,logs,logError,observedAt:new Date().toISOString()})};
};}