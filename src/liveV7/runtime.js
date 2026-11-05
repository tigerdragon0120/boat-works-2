import {base44} from '@/api/base44Client';
import {appParams} from '@/lib/app-params';
import {getRaceEntries} from '@/lib/predictionService';
import {singleFlight} from './requests';
import {createLiveReader} from './reader';
import {localSession} from './localSession';
import {LiveV7Controller} from './controller';
import {unifiedV7,UNIFIED_REVISION} from './unified';
// Reuse existing entities; no function invocation, create/update/delete or Service Role.
export const readRace=singleFlight(id=>base44.entities.Race.get(id));
const readEntriesByKey=singleFlight(key=>getRaceEntries(...JSON.parse(key)));
export const readRaceEntries=(id,key)=>readEntriesByKey(JSON.stringify([id,key]));
export const readResultRows=singleFlight(id=>base44.entities.RaceResult.filter({race_id:id},"-finished_at",10));
export const readLiveRace=createLiveReader(base44,readRaceEntries,{readRace,readResultRows,readFetchLogs:race=>base44.entities.OnlineFetchLog.filter({race_date:race.race_date,venue_code:race.venue_code,race_number:race.race_number},"-fetched_at",100)});
let local={storage:null,namespace:(appParams.appId||'UNCONFIGURED')+':memory-only'};
try{local=localSession(appParams.appId,{session:globalThis.sessionStorage,persistent:globalThis.localStorage,uuid:()=>globalThis.crypto.randomUUID()});}catch{/* Storage denied: keep in-memory previews and report persistence unavailable. */}
export const archivedV7=new LiveV7Controller({reader:readLiveRace,...local});
export const liveV7=new LiveV7Controller({reader:readLiveRace,...local,namespace:'v7-unified-trial-2:'+local.namespace,
 model:UNIFIED_REVISION,predict:unifiedV7,compare:null,waitForResult:true,hidden:()=>typeof document!=='undefined'&&document.hidden});
if(!local.storage)liveV7.storageError='このタブでは履歴を永続保存できません';