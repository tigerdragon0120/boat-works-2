// Share overlapping read requests only; completed data is never cached as a fresh response.
export function singleFlight(read){const pending=new Map();return key=>{
 if(pending.has(key))return pending.get(key);
 const promise=Promise.resolve().then(()=>read(key)).finally(()=>{if(pending.get(key)===promise)pending.delete(key);});pending.set(key,promise);return promise;
};}