import { useEffect, useState } from 'react';
import { base44 } from '@/api/base44Client';
import { loadRaceEvidence } from '@/lib/resultEvidence';
import { adaptSavedStage, selectSavedStage } from '@/liveV7/savedDisplayAdapter';

const EMPTY = {stages:{PRE:null,FINAL:null},evidence:null,error:null,loading:true};
export default function useV7SavedRace(race) {
  const [data,setData]=useState(EMPTY);
  useEffect(()=>{
    if(!race?.id) return;
    let active=true;
    const load = async () => {
      try {
        const [rows,odds] = await Promise.all([
          base44.entities.PredictionV7.filter({race_id:race.id},'-created_date',30),
          base44.entities.OddsSnapshot.filter({race_id:race.id,stage:'FINAL'},'-captured_at',30),
        ]);
        if(!Array.isArray(rows) || !Array.isArray(odds)) throw new Error('V7の保存データを取得できませんでした');
        const stages = Object.fromEntries(['PRE','FINAL'].map(stage=>[
          stage,adaptSavedStage(selectSavedStage(rows,stage,race),odds)
        ]));
        let evidence=null;
        const deadline = Date.parse(race.deadline || '');
        if(race.status==='finished'||(Number.isFinite(deadline)&&Date.now()>=deadline)) {
          evidence=await loadRaceEvidence(race.id);
        }
        if(active) setData({stages,evidence,error:null,loading:false});
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
