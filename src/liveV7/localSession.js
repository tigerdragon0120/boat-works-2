// Separate ordinary tab sessions; browser-duplicated tabs may share session identity.
export function localSession(appId,{session,persistent,uuid}){
 if(!appId)throw Error('V7の接続環境IDが未設定です');
 const key=`BOAT_LIVE_V7_TAB:${appId}`;
 let tab=session.getItem(key);if(!tab){tab=uuid();session.setItem(key,tab);}
 return {namespace:`${appId}:tab:${tab}`,storage:persistent};
}