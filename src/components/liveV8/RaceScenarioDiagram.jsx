import React, {useId} from 'react';

const COLORS={1:{fill:'#fff',text:'#0f172a',stroke:'#94a3b8'},2:{fill:'#1e293b',text:'#fff',stroke:'#1e293b'},3:{fill:'#e8484c',text:'#fff',stroke:'#c33239'},4:{fill:'#2779da',text:'#fff',stroke:'#1d63b9'},5:{fill:'#f5cf45',text:'#422006',stroke:'#d6ac20'},6:{fill:'#249774',text:'#fff',stroke:'#167556'}};
const METHODS={ESCAPE:'逃げ',SASHI:'差し',MAKURI:'まくり',MAKURISASHI:'まくり差し'};

function getOrder(boats,stage) {
  const rows=(boats||[]).filter(boat=>Number(boat.boat_number)>=1 && Number(boat.boat_number)<=6);
  const field=stage==='FINAL'?'observed_course':'expected_course';
  const valid=rows.length===6 && rows.every(boat=>Number.isInteger(Number(boat[field]))&&Number(boat[field])>=1&&Number(boat[field])<=6) && new Set(rows.map(boat=>Number(boat[field]))).size===6;
  const assumption=rows.some(boat=>boat.expected_course_basis==='FRAME_ORDER_ASSUMPTION');
  return {valid,order:valid?[...rows].sort((a,b)=>Number(a[field])-Number(b[field])).map(boat=>Number(boat.boat_number)):[],label:valid?(stage==='FINAL'?'展示進入':assumption?'想定進入・枠なりを仮定':'想定進入'):'進入未確認'};
}
function route(index,method,secondary=false) {
  const y=180+index*24;
  if (method==='MAKURI') return `M 608 ${y} C 435 ${y} 270 ${y+10} 130 ${y-12} C 66 210 83 78 218 72 L ${secondary?388:468} 72`;
  if (method==='MAKURISASHI') return `M 608 ${y} C 470 ${y} 334 ${y+4} 272 214 C 199 199 175 126 253 103 L ${secondary?388:468} 103`;
  if (method==='SASHI') return `M 608 ${y} C 441 ${y} 330 ${y} 267 199 C 220 179 198 126 267 118 L ${secondary?388:468} 118`;
  return `M 608 ${y} C 448 ${y} 336 ${y} 218 184 C 145 181 139 95 233 94 L ${secondary?388:468} 94`;
}

export default function RaceScenarioDiagram({scenario,boats=[],stage='PRE',compact=false}) {
  const uid=useId().replace(/:/g,''), layout=getOrder(boats,stage);
  const leader=Number(scenario?.leader), index=layout.order.indexOf(leader), color=COLORS[leader] || COLORS[4];
  const benefits=(scenario?.beneficiaries||[]).map(Number).filter(boat=>boat!==leader&&layout.order.includes(boat)).slice(0,2);
  if (!scenario) return <div className="flex min-h-40 items-center justify-center rounded-xl bg-sky-50 px-5 text-sm text-slate-500">展開を保存すると、想定進路を表示します。</div>;
  if (!layout.valid) return <div className="flex min-h-40 flex-col items-center justify-center rounded-xl border border-dashed border-sky-200 bg-sky-50 px-5 text-center"><p className="text-sm font-semibold text-slate-600">{stage==='FINAL'?'展示進入の確認待ち':'想定進入の確認待ち'}</p><p className="mt-2 text-xs leading-6 text-slate-500">6艇の進入が揃っていないため、展開図を保留しています。</p></div>;
  return <figure className="overflow-hidden rounded-xl border border-sky-100 bg-gradient-to-br from-sky-50 to-white">
    <svg viewBox="0 0 720 350" className="block h-auto w-full" role="img" aria-labelledby={`${uid}-title ${uid}-description`}>
      <title id={`${uid}-title`}>{leader}号艇の{METHODS[scenario.method] || scenario.label}を想定した1マークの展開図</title>
      <desc id={`${uid}-description`}>実測軌跡ではなく、保存した展開仮説を模式化しています。太い矢印は中心となる艇、点線は展開を利用する候補です。{layout.label}。</desc>
      <defs>
        <pattern id={`${uid}-water`} width="32" height="24" patternUnits="userSpaceOnUse"><path d="M 0 15 Q 8 9 16 15 T 32 15" fill="none" stroke="#bae6fd" strokeWidth="0.7" opacity="0.5"/></pattern>
        <marker id={`${uid}-arrow`} viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 Z" fill={leader===1?'#64748b':color.fill}/></marker>
        <marker id={`${uid}-small`} viewBox="0 0 10 10" refX="8" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 Z" fill="#94a3b8"/></marker>
      </defs>
      <rect width="720" height="350" fill={`url(#${uid}-water)`}/>
      <text x="22" y="28" fill="#0369a1" fontSize="12" fontWeight="700">1マーク・想定展開図</text>
      <text x="698" y="28" textAnchor="end" fill="#64748b" fontSize="11">{layout.label}</text>
      <path d="M 230 150 H 710" stroke="#cbd5e1" strokeWidth="1" strokeDasharray="4 7"/>
      <text x="695" y="140" textAnchor="end" fill="#94a3b8" fontSize="10">内側</text>
      <path d="M 555 172 V 318" stroke="#94a3b8" strokeWidth="1" strokeDasharray="4 5"/>
      <text x="555" y="337" textAnchor="middle" fill="#64748b" fontSize="10">スタート方向 ←</text>
      {layout.order.map((boat,lane)=><path key={`lane-${boat}`} d={`M 600 ${180+lane*24} H 470`} stroke="#cbd5e1" strokeWidth="1" strokeDasharray="3 6"/>)}
      {benefits.map((boat,i)=><path key={`benefit-${boat}`} d={route(layout.order.indexOf(boat),i===0?'SASHI':'MAKURISASHI',true)} fill="none" stroke={COLORS[boat].fill==='#fff'?'#94a3b8':COLORS[boat].fill} strokeWidth="2.5" strokeDasharray="6 6" opacity="0.65" markerEnd={`url(#${uid}-small)`}/>)}
      {index>=0 && <>
        <path d={route(index,scenario.method)} fill="none" stroke="#fff" strokeWidth="9" strokeLinecap="round"/>
        <path d={route(index,scenario.method)} fill="none" stroke={leader===1?'#64748b':color.fill} strokeWidth="4" strokeLinecap="round" markerEnd={`url(#${uid}-arrow)`}/>
      </>}
      <ellipse cx="210" cy="154" rx="21" ry="7" fill="#bae6fd"/>
      <path d="M 210 123 L 198 151 L 222 151 Z" fill="#e8484c" stroke="#fff" strokeWidth="2"/>
      <path d="M 204 137 H 216 L 218 143 H 202 Z" fill="#fff"/>
      <text x="210" y="174" textAnchor="middle" fill="#64748b" fontSize="10">1M</text>
      {layout.order.map((boat,lane)=>{
        const y=180+lane*24, c=COLORS[boat];
        return <g key={boat}>
          <text x="679" y={y+4} textAnchor="middle" fill="#64748b" fontSize="10">{layout.valid?`${lane+1}コース`:`${boat}枠`}</text>
          <path d={`M 589 ${y} Q 602 ${y-12} 631 ${y-10} L 637 ${y} L 631 ${y+10} Q 602 ${y+12} 589 ${y} Z`} fill={c.fill} stroke={c.stroke} strokeWidth={boat===leader?2:1}/>
          <text x="614" y={y+4} textAnchor="middle" fill={c.text} fontSize="12" fontWeight="800">{boat}</text>
        </g>;
      })}
      <rect x="26" y="279" rx="8" width="280" height="45" fill="white" opacity="0.94"/>
      <text x="39" y="297" fill="#0f172a" fontSize="12" fontWeight="700">中心：{leader}号艇 {METHODS[scenario.method] || scenario.label}</text>
      <text x="39" y="314" fill="#64748b" fontSize="10">{benefits.length?`展開を利用する候補：${benefits.join('・')}号艇`:'想定進路の模式図です'}</text>
    </svg>
    {!compact && <figcaption className="border-t border-sky-100 bg-white/70 px-3 py-2 text-[11px] leading-5 text-slate-500">矢印は展開仮説の説明用です。位置・速度・本番の進入を再現したシミュレーションではありません。</figcaption>}
  </figure>;
}
