const validNumber = value => {
  if (typeof value !== 'number' && (typeof value !== 'string' || !/^[1-6]$/.test(value.trim()))) return null;
  const number=Number(value);
  return Number.isInteger(number)&&number>=1&&number<=6?number:null;
};
const absent = boat => boat?.active === false || boat?.is_absent === true || boat?.is_scratched === true;

// A forecast snapshot can retain six slots, including explicitly absent boats.
// Every actual starter must have a unique recorded course; missing data is not filled.
export function getScenarioLayout(boats,stage) {
  const source=Array.isArray(boats)?boats:[], rows=source.filter(boat=>!absent(boat));
  const field=stage==='FINAL'?'observed_course':'expected_course';
  const valid=rows.length>=3&&rows.length<=6
    && rows.every(boat=>validNumber(boat?.boat_number)!=null&&validNumber(boat?.[field])!=null)
    && new Set(rows.map(boat=>Number(boat.boat_number))).size===rows.length
    && new Set(rows.map(boat=>Number(boat[field]))).size===rows.length;
  const sorted=valid?[...rows].sort((a,b)=>Number(a[field])-Number(b[field])):[];
  const order=sorted.map(boat=>Number(boat.boat_number)),courses=sorted.map(boat=>Number(boat[field]));
  const assumption=rows.some(boat=>boat?.expected_course_basis==='FRAME_ORDER_ASSUMPTION');
  const base=stage==='FINAL'?'展示進入':assumption?'想定進入・枠なりを仮定':'想定進入';
  return {valid,order,courses,activeCount:rows.length,
    laneByBoat:Object.fromEntries(sorted.map(boat=>[Number(boat.boat_number),Number(boat[field])-1])),
    absentBoats:source.filter(absent).map(boat=>validNumber(boat?.boat_number)).filter(boat=>boat!=null),
    label:valid?base+(rows.length<6?`・${rows.length}艇出走`:''):'進入未確認'};
}
