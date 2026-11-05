import {useEffect} from 'react';
import {liveV7,readResultRows} from '@/liveV7/runtime';
// Keep result reconciliation alive while another application screen is open.
export default function V7ResultMonitor(){
 useEffect(()=>{let stopped=false,timer=null;
  const tick=async()=>{try{await liveV7.pollResults(async race=>{
   return readResultRows(race.id);
  });}catch{/* Error is shown by controller; existing application continues. */}
  if(!stopped)timer=setTimeout(tick,30000);};void tick();return()=>{stopped=true;if(timer)clearTimeout(timer);};
 },[]);return null;
}