// V7 browser persistence: preserve original localStorage value and offer
// compressed IndexedDB fallback without deleting any existing user history.
const PREFIX='V7_GZIP_V1:';
const STORE='archive';
const DB='BOAT_WORKS_V7_LOCAL_ARCHIVE_V1';

function base64Encode(bytes){
 let output='';
 for(let i=0;i<bytes.length;i+=8192){
  const part=bytes.subarray(i,i+8192);
  output+=String.fromCharCode(...part);
 }
 return btoa(output);
}
function base64Decode(value){
 const binary=atob(value);
 const bytes=new Uint8Array(binary.length);
 for(let i=0;i<binary.length;i++)bytes[i]=binary.charCodeAt(i);
 return bytes;
}
async function zip(value){
 if(typeof CompressionStream==='undefined') return value;
 const stream=new Blob([value]).stream().pipeThrough(new CompressionStream('gzip'));
 const zipped=new Uint8Array(await new Response(stream).arrayBuffer());
 return PREFIX+base64Encode(zipped);
}
async function unzip(value){
 if(!value?.startsWith(PREFIX))return value;
 if(typeof DecompressionStream==='undefined')throw Error('この端末では圧縮済み履歴を復元できません');
 const stream=new Blob([base64Decode(value.slice(PREFIX.length))]).stream().pipeThrough(new DecompressionStream('gzip'));
 return new Response(stream).text();
}
function openDb(){
 if(typeof indexedDB==='undefined')return Promise.reject(Error('IndexedDB非対応'));
 return new Promise((resolve,reject)=>{
  const request=indexedDB.open(DB,1);
  request.onupgradeneeded=()=>{const db=request.result;if(!db.objectStoreNames.contains(STORE))db.createObjectStore(STORE);};
  request.onsuccess=()=>resolve(request.result);
  request.onerror=()=>reject(request.error||Error('IndexedDB open failed'));
 });
}
async function dbGet(key){
 const db=await openDb();
 try{return await new Promise((resolve,reject)=>{
  const tx=db.transaction(STORE,'readonly');
  const req=tx.objectStore(STORE).get(key);
  req.onsuccess=()=>resolve(req.result||null);
  req.onerror=()=>reject(req.error||Error('IndexedDB read failed'));
 });}finally{db.close();}
}
async function dbSet(key,value){
 const db=await openDb();
 try{await new Promise((resolve,reject)=>{
  const tx=db.transaction(STORE,'readwrite');
  tx.objectStore(STORE).put(value,key);
  tx.oncomplete=resolve;
  tx.onerror=()=>reject(tx.error||Error('IndexedDB write failed'));
  tx.onabort=()=>reject(tx.error||Error('IndexedDB write aborted'));
 });}finally{db.close();}
}
export function createDurableStorage(localStorage, key){
 let usingIndexedDb=false;
 return {
  async read(){
   // A previous quota failure may have left an older localStorage archive.
   // Prefer the committed IndexedDB copy if one exists.
   try{
    const stored=await dbGet(key);
    if(stored!=null){usingIndexedDb=true;return JSON.parse(await unzip(stored));}
   }catch{/* Continue to original localStorage; never mutate it here. */}
   const original=localStorage?.getItem(key);
   return original?JSON.parse(await unzip(original)):{};
  },
  async write(snapshot){
   const packed=await zip(JSON.stringify(snapshot));
   if(usingIndexedDb){await dbSet(key,packed);return 'IndexedDB';}
   try{
    if(!localStorage)throw Error('localStorage unavailable');
    localStorage.setItem(key,packed);return 'localStorage';
   }catch(error){
    // Never remove/clear/overwrite the previous archive on failure.
    try{await dbSet(key,packed);usingIndexedDb=true;return 'IndexedDB';}
    catch(fallback){throw Error('端末内保存容量の上限です。既存履歴は削除していません：'+(fallback.message||error.message));}
   }
  }
 };
}
