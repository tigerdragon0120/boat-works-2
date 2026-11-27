import test from 'node:test';
import assert from 'node:assert/strict';
import {acquireLock} from '../base44/shared/concurrencyLock.js';

test('a failed or invalid lock read cannot start another writer',async()=>{
  for(const failure of ['read','shape']){
    let creates=0;
    const error=new Error('database unavailable');
    const client={asServiceRole:{entities:{ProcessLock:{
      filter:async()=>{if(failure==='read')throw error;return null;},
      create:async()=>{creates++;return {id:'unsafe-lock'};},
    }}}};
    await assert.rejects(acquireLock(client,'V8_FORECAST_CAPTURE','capture'),failure==='read'?e=>e===error:/LOCK_READ_INVALID/);
    assert.equal(creates,0);
  }
});

test('a successful lock read retains free-lock creation and active-lock exclusion',async()=>{
  for(const active of [false,true]){
    let creates=0;
    const client={asServiceRole:{entities:{ProcessLock:{
      filter:async()=>active?[{id:'held',expires_at:new Date(Date.now()+60000).toISOString()}]:[],
      create:async doc=>{creates++;assert.equal(doc.status,'active');return {id:'new-lock'};},
    }}}};
    assert.equal(await acquireLock(client,'V8_FORECAST_CAPTURE','capture'),active?null:'new-lock');
    assert.equal(creates,active?0:1);
  }
});
