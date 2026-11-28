// A source is selected as a whole. Measurements from different providers or
// older stored rows are never combined to manufacture a complete exhibition.
import {fetchHtml,parseBeforeInfo,buildUrl} from './boatraceOfficialParser.js';
import {fetchBoatcastExhibitionSource} from './boatcastExhibitionSource.js';
import {isSavedExhibitionComplete} from './liveInputPriority.js';

export async function fetchExhibitionSource({race,entries,deadlineMs,skipPrimary=false,
  fetchOfficial=fetchHtml,parseOfficial=parseBeforeInfo,fetchBackup=fetchBoatcastExhibitionSource,now=()=>Date.now()}) {
  const budget=Number.isFinite(deadlineMs)?deadlineMs:now()+8000;
  const url=buildUrl('beforeinfo',race.race_date,race.venue_code,race.race_number);
  let primary=null,primaryStatus=null;
  if(!skipPrimary&&now()<budget){
    const response=await fetchOfficial(url,0,{timeoutMs:4000,deadlineMs:budget});
    primaryStatus=response.status??0;
    if(response.ok){
      const capturedAt=new Date(now()).toISOString(),parsed=parseOfficial(response.html);
      if(parsed.ok&&Array.isArray(parsed.data?.entries)&&parsed.data.entries.length){
        primary={ok:true,data:parsed.data,complete:isSavedExhibitionComplete(parsed.data.entries,parsed.data.scratched_boats||[]),
          source:{provider:'BOATRACE',url,urls:[url],captured_at:capturedAt}};
        if(primary.complete)return {...primary,primary_http_status:primaryStatus};
      }
    }
  }
  if(now()<budget){
    const backup=await fetchBackup({race,entries,deadlineMs:budget,timeoutMs:4000,now});
    if(backup.ok)return {...backup,complete:true,primary_http_status:primaryStatus};
    // Preserve genuinely observed partial primary inputs, but never advertise
    // that response as complete or reuse old values to complete its marker.
    if(primary)return {...primary,primary_http_status:primaryStatus,backup_reason:backup.reason};
    return {ok:false,reason:backup.reason||'EXHIBITION_SOURCE_UNAVAILABLE',
      http_status:backup.http_status??primaryStatus??0,primary_http_status:primaryStatus};
  }
  return primary?{...primary,primary_http_status:primaryStatus,backup_reason:'SOURCE_TIME_BUDGET'}
    :{ok:false,reason:'SOURCE_TIME_BUDGET',http_status:primaryStatus??0,primary_http_status:primaryStatus};
}
