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
// Stand-side view: boats approach left-to-right, pass the right side of 1M,
// then turn left (counterclockwise) toward 2M. Inside routes still clear the buoy.
function route(index,method,secondary=false) {
  const y=180+index*24, exitX=secondary?332:252;
  if (method==='MAKURI') return `M 112 ${y} C 285 ${y} 450 ${y+10} 590 ${y-12} C 654 210 637 78 502 72 L ${exitX} 72`;
  if (method==='MAKURISASHI') return `M 112 ${y} C 250 ${y} 386 ${y+4} 448 214 C 545 207 594 120 486 103 L ${exitX} 103`;
  if (method==='SASHI') return `M 112 ${y} C 279 ${y} 390 ${y} 470 199 C 535 180 567 110 478 106 L ${exitX} 106`;
  return `M 112 ${y} C 272 ${y} 384 ${y} 502 184 C 575 181 581 95 487 94 L ${exitX} 94`;
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
      <desc id={`${uid}-description`}>スタンド側から見た配置で、左から右へ進み、右側の1マークを左旋回します。実測軌跡ではなく、保存した展開仮説を模式化しています。太い矢印は中心となる艇、点線は展開を利用する候補です。{layout.label}。</desc>
      <defs>
        <pattern id={`${uid}-water`} width="32" height="24" patternUnits="userSpaceOnUse"><path d="M 0 15 Q 8 9 16 15 T 32 15" fill="none" stroke="#bae6fd" strokeWidth="0.7" opacity="0.5"/></pattern>
        <marker id={`${uid}-arrow`} viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 Z" fill={leader===1?'#64748b':color.fill}/></marker>
        <marker id={`${uid}-small`} viewBox="0 0 10 10" refX="8" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 Z" fill="#94a3b8"/></marker>
      </defs>
      <rect width="720" height="350" fill={`url(#${uid}-water)`}/>
      <text x="22" y="28" fill="#0369a1" fontSize="12" fontWeight="700">1マーク・想定展開図</text>
      <text x="698" y="28" textAnchor="end" fill="#64748b" fontSize="11">{layout.label}・スタンド側から</text>
      <text x="330" y="55" textAnchor="middle" fill="#64748b" fontSize="10">← 2マーク方向</text>
      <path d="M 10 150 H 490" stroke="#cbd5e1" strokeWidth="1" strokeDasharray="4 7"/>
      <text x="25" y="140" textAnchor="start" fill="#94a3b8" fontSize="10">内側</text>
      <path d="M 165 172 V 318" stroke="#94a3b8" strokeWidth="1" strokeDasharray="4 5"/>
      <text x="165" y="337" textAnchor="middle" fill="#64748b" fontSize="10">スタート方向 →</text>
      {layout.order.map((boat,lane)=><path key={`lane-${boat}`} d={`M 120 ${180+lane*24} H 250`} stroke="#cbd5e1" strokeWidth="1" strokeDasharray="3 6"/>)}
      {benefits.map((boat,i)=><path key={`benefit-${boat}`} d={route(layout.order.indexOf(boat),i===0?'SASHI':'MAKURISASHI',true)} fill="none" stroke={COLORS[boat].fill==='#fff'?'#94a3b8':COLORS[boat].fill} strokeWidth="2.5" strokeDasharray="6 6" opacity="0.65" markerEnd={`url(#${uid}-small)`}/>)}
      {index>=0 && <>
        <path d={route(index,scenario.method)} fill="none" stroke="#fff" strokeWidth="9" strokeLinecap="round"/>
        <path d={route(index,scenario.method)} fill="none" stroke={leader===1?'#64748b':color.fill} strokeWidth="4" strokeLinecap="round" markerEnd={`url(#${uid}-arrow)`}/>
      </>}
      <ellipse cx="510" cy="154" rx="21" ry="7" fill="#bae6fd"/>
      <path d="M 510 123 L 498 151 L 522 151 Z" fill="#e8484c" stroke="#fff" strokeWidth="2"/>
      <path d="M 504 137 H 516 L 518 143 H 502 Z" fill="#fff"/>
      <text x="510" y="174" textAnchor="middle" fill="#64748b" fontSize="10">1M</text>
      {layout.order.map((boat,lane)=>{
        const y=180+lane*24, c=COLORS[boat];
        return <g key={boat}>
          <text x="41" y={y+4} textAnchor="middle" fill="#64748b" fontSize="10">{layout.valid?`${lane+1}コース`:`${boat}枠`}</text>
          <path d={`M 131 ${y} Q 118 ${y-12} 89 ${y-10} L 83 ${y} L 89 ${y+10} Q 118 ${y+12} 131 ${y} Z`} fill={c.fill} stroke={c.stroke} strokeWidth={boat===leader?2:1}/>
          <text x="106" y={y+4} textAnchor="middle" fill={c.text} fontSize="12" fontWeight="800">{boat}</text>
        </g>;
      })}
      <rect x="414" y="279" rx="8" width="280" height="45" fill="white" opacity="0.94"/>
      <text x="427" y="297" fill="#0f172a" fontSize="12" fontWeight="700">中心：{leader}号艇 {METHODS[scenario.method] || scenario.label}</text>
      <text x="427" y="314" fill="#64748b" fontSize="10">{benefits.length?`展開を利用する候補：${benefits.join('・')}号艇`:'想定進路の模式図です'}</text>
    </svg>
    {!compact && <figcaption className="border-t border-sky-100 bg-white/70 px-3 py-2 text-[11px] leading-5 text-slate-500">矢印は展開仮説の説明用です。位置・速度・本番の進入を再現したシミュレーションではありません。</figcaption>}
  </figure>;
}
