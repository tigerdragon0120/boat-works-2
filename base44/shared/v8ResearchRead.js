// Research reads use the same bounded transport retry and strict cursor
// validation as the V8 live/replay pipelines. No write is ever retried here.
import {readV8Rows} from './v8Repository.js';

export async function readResearchPaged(fetchPage,query,options={}){
  try{
    const rows=await readV8Rows({filter:fetchPage},query,{
      budget:options.deadlineMs??Date.now()+25000,
      maxPages:options.maxPages??40,
      sort:options.sort||'-created_date',
    });
    return {rows,complete:true};
  }catch(error){
    const match=/^INCOMPLETE_READ:([a-z_]+)$/.exec(String(error?.message||''));
    const reason=match?.[1]||'read_failed';
    const status=error?.http_status;
    const httpStatus=Number.isInteger(status)&&status>=100&&status<=599?status:null;
    console.warn('[V8_RESEARCH_READ] incomplete',reason,httpStatus);
    // readV8Rows intentionally withholds partial pages. Never let a consumer
    // interpret earlier pages as a complete existing-key/source ledger.
    return {rows:[],complete:false,error:reason,page:null,http_status:httpStatus};
  }
}
