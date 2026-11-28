// Empty-stage copy follows the current race, independently of an immutable PRE's
// old deadline. This helper does not authorize a forecast, tickets or BUY.
const currentDeadline=value=>{
  if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}T/.test(value.trim()))return null;
  const text=value.trim().replace(/(\.\d{3})\d+/,'$1');
  const at=Date.parse(/[zZ]$|[+-]\d{2}:?\d{2}$/.test(text)?text:text+'Z');
  return Number.isFinite(at)?at:null;
};

export function exhibitionForecastEmptyState({race,now=Date.now(),unavailable=false}={}){
  if(unavailable||!race)return {title:'展示後予想の保存状況を確認できません',detail:'保存記録を確認できていません。時間を置いて再読込してください。',step:'確認待ち'};
  if(race.status==='cancelled')return {title:'レースは中止になりました',detail:'このレースの展示後予想は保存されていません。',step:'中止'};
  const deadline=currentDeadline(race.deadline);
  if(!Number.isFinite(now)||(race.status!=='finished'&&deadline==null))return {title:'レースの締切時刻を確認しています',detail:'最新の締切時刻を確認できるまで、展示後予想の保存状況を保留します。',step:'締切確認待ち'};
  // The live engine stops saving one minute before the official deadline.
  const closed=race.status==='finished'||now>=deadline-60000;
  if(closed)return race.exhibition_ready===true
    ? {title:'事後検証の補完を待っています',detail:'締切前に保存できなかった展示後予想を、取得済みの展示情報から補完します。補完分は事後検証として保存し、確定結果と照合します。',step:'事後補完待ち'}
    : {title:'展示データの再取得を待っています',detail:'締切後も展示情報を収集し、展示後予想と結果検証を補完します。',step:'展示再取得待ち'};
  return race.exhibition_ready===true
    ? {title:'展示後予想の保存を待っています',detail:'展示情報は取得済みです。展示後予想の保存を確認してから表示します。',step:'保存待ち'}
    : {title:'展示情報を待っています',detail:'展示の進入・ST・タイムを取得後、展示後予想を保存して表示します。',step:'展示待ち'};
}
