import { useEffect, useState } from 'react';
import { base44 } from '@/api/base44Client';
import { loadRaceEvidence } from '@/lib/resultEvidence';
import { adaptSavedStage, selectSavedStage } from '@/liveV7/savedDisplayAdapter';

const EMPTY = {stages:{PRE:null,FINAL:null},evidence:null,resultCandidate:null,resultConflict:false,error:null,loading:true};
export default function useV7SavedRace(race) {
  const [data,setData]=useState(EMPTY);
  useEffect(()=>{
    if(!race?.id) return;
    let active=true;
    const load = async () => {
      try {
        const [rows,odds,results] = await Promise.all([
          base44.entities.PredictionV7.filter({race_id:race.id},'-created_date',30),
          base44.entities.OddsSnapshot.filter({race_id:race.id,stage:'FINAL'},'-captured_at',30),
          base44.entities.RaceResult.filter({race_id:race.id},'-created_date',30),
        ]);
        if(!Array.isArray(rows) || !Array.isArray(odds) || !Array.isArray(results) || results.length>=30) throw new Error('V7予想または結果を全件取得できませんでした');
        const stages = {
          PRE: adaptSavedStage(selectSavedStage(rows,'PRE',race),odds),
          FINAL: adaptSavedStage(selectSavedStage(rows,'FINAL',race),odds),
        };
        const completed = results.filter((r)=>r?.race_id===race.id&&(r.is_finished===true||r.result_status==='RESULT_FINAL')&&/^[1-6]-[1-6]-[1-6]$/.test(String(r.result_trifecta||''))&&new Set(String(r.result_trifecta).split('-')).size===3);
        const combinations = new Set(completed.map((r)=>String(r.result_trifecta)));
        const resultConflict = combinations.size>1;
        const resultCandidate = combinations.size===1 ? completed[0] : null;
        let evidence=null;
        const deadline = Date.parse(race.deadline || '');
        if(race.status==='finished'||(Number.isFinite(deadline)&&Date.now()>=deadline)) {
          evidence=await loadRaceEvidence(race.id);
        }
        if(active) setData({stages,evidence,resultCandidate,resultConflict,error:null,loading:false});
      }catch(e){
        if(active) setData(prev=>({...prev,error:e?.message||'データ取得に失敗しました',loading:false}));
      }
    };
    setData(EMPTY);
    void load();
    const timer=window.setInterval(()=>{
      if(document.hidden) return;
      void load();
    },45000);
    return()=>{active=false;window.clearInterval(timer)};
  },[race?.id,race?.race_key,race?.deadline]);
  return data;
}
