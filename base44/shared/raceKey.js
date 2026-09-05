// 共通race_key生成 + BOAT WORKS→BOAT WORKS 2 フィールドマッピング

export function buildRaceKey(race_date, venue_code, race_number) {
  const d = String(race_date || "").slice(0, 10);
  const v = String(venue_code ?? "");
  const n = String(race_number ?? "").padStart(2, "0");
  return `${d}_${v}_${n}`;
}

// race_key("2026-09-05_13_12")から race_date/venue_code/race_number を逆算する。
// 同期元のentry個別データにこれらが欠けている場合の保険。
export function parseRaceKey(key) {
  const parts = String(key || "").split("_");
  if (parts.length < 3) return { race_date: null, venue_code: null, race_number: null };
  const race_number = parts.pop();
  const venue_code = parts.pop();
  const race_date = parts.join("_"); // 万一date部に_が含まれても安全なように残りを結合
  return {
    race_date: race_date || null,
    venue_code: venue_code || null,
    race_number: race_number ? Number(race_number) : null,
  };
}

// 数値化(文字列も許容)
const num = (v) => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const str = (v) => (v === null || v === undefined ? null : String(v));

// BOAT WORKS Race → BOAT WORKS 2 Race
export function mapRace(bw) {
  const race_date = str(bw.race_date) || str(bw.date);
  const venue_code = str(bw.venue_code) || str(bw.venue);
  const race_number = num(bw.race_number) || num(bw.race_no);
  const race_key = bw.race_key || buildRaceKey(race_date, venue_code, race_number);
  return {
    race_key,
    race_date,
    venue_code,
    venue: str(bw.venue_name) || str(bw.venue) || "",
    venue_name: str(bw.venue_name) || str(bw.venue) || "",
    race_number,
    race_name: str(bw.race_name) || "",
    event_name: str(bw.event_name) || "",
    series_day: num(bw.series_day),
    series_total_days: num(bw.series_total_days),
    is_final_day: !!bw.is_final_day,
    is_womens: /レディース|女子|ヴィーナス|オールレディース/i.test(str(bw.event_name) || ""),
    race_type: str(bw.race_type) || str(bw.race_phase) || "一般",
    race_phase: str(bw.race_phase) || str(bw.race_type) || "",
    grade: str(bw.grade) || "",
    time_slot: str(bw.time_slot) || "",
    deadline: str(bw.deadline) || null,
    weather: str(bw.weather) || null,
    wind_dir: str(bw.wind_dir) || null,
    wind_speed: num(bw.wind_speed),
    wave_height: num(bw.wave_height),
    water_temp: num(bw.water_temperature) != null ? num(bw.water_temperature) : num(bw.water_temp),
    air_temp: num(bw.air_temperature) != null ? num(bw.air_temperature) : num(bw.air_temp),
    exhibition_ready: !!bw.exhibition_ready,
    scratched_boats: Array.isArray(bw.scratched_boats) ? bw.scratched_boats.map((n) => num(n)).filter((n) => n !== null) : [],
    status: str(bw.status) || "scheduled",
  };
}

// BOAT WORKS RaceEntry + SeriesRacerPoint → BOAT WORKS 2 RaceEntry
export function mapEntry(bw, series = {}) {
  const race_key = bw.race_key || buildRaceKey(str(bw.race_date), str(bw.venue_code), num(bw.race_number));
  // entry個別に race_date/venue_code/race_number が無い場合、race_keyから逆算して補う。
  const fallback = parseRaceKey(race_key);
  const race_date = str(bw.race_date) ?? fallback.race_date;
  const venue_code = str(bw.venue_code) ?? fallback.venue_code;
  const race_number = num(bw.race_number) ?? fallback.race_number;
  const is_scratched = !!bw.is_scratched || !!bw.scratched;
  return {
    race_key,
    race_date,
    venue_code,
    race_number,
    boat_number: num(bw.boat_number),
    player_name: str(bw.racer_name) || str(bw.player_name) || "",
    racer_name: str(bw.racer_name) || str(bw.player_name) || "",
    register_number: str(bw.registration_number) || str(bw.register_number) || "",
    registration_number: str(bw.registration_number) || str(bw.register_number) || "",
    player_class: str(bw.grade_class) || str(bw.player_class) || "",
    grade_class: str(bw.grade_class) || str(bw.player_class) || "",
    national_win_rate: num(bw.national_win_rate),
    local_win_rate: num(bw.local_win_rate),
    national_f2_rate: num(bw.national_2rate) != null ? num(bw.national_2rate) : num(bw.national_f2_rate),
    national_2rate: num(bw.national_2rate),
    national_f3_rate: num(bw.national_3rate) != null ? num(bw.national_3rate) : num(bw.national_f3_rate),
    national_3rate: num(bw.national_3rate),
    local_f2_rate: num(bw.local_2rate) != null ? num(bw.local_2rate) : num(bw.local_f2_rate),
    local_2rate: num(bw.local_2rate),
    local_f3_rate: num(bw.local_3rate) != null ? num(bw.local_3rate) : num(bw.local_f3_rate),
    local_3rate: num(bw.local_3rate),
    avg_st: num(bw.avg_st),
    f_count: num(bw.f_count),
    l_count: num(bw.l_count),
    motor_number: num(bw.motor_number),
    motor_f2_rate: num(bw.motor_2rate) != null ? num(bw.motor_2rate) : num(bw.motor_f2_rate),
    motor_2rate: num(bw.motor_2rate),
    motor_f3_rate: num(bw.motor_3rate) != null ? num(bw.motor_3rate) : num(bw.motor_f3_rate),
    motor_3rate: num(bw.motor_3rate),
    boat_number_id: str(bw.boat_number_id),
    boat_f2_rate: num(bw.boat_2rate) != null ? num(bw.boat_2rate) : num(bw.boat_f2_rate),
    boat_2rate: num(bw.boat_2rate),
    boat_f3_rate: num(bw.boat_3rate) != null ? num(bw.boat_3rate) : num(bw.boat_f3_rate),
    boat_3rate: num(bw.boat_3rate),
    entry_course: num(bw.entry_course),
    exhibition_time: num(bw.exhibition_time),
    exhibition_rank: num(bw.exhibition_rank),
    exhibition_st: num(bw.exhibition_st),
    exhibition_st_raw: num(bw.exhibition_st_raw),
    exhibition_course: num(bw.exhibition_course) != null ? num(bw.exhibition_course) : num(bw.entry_course),
    tilt: num(bw.tilt),
    // 節間情報(SeriesRacerPoint) → エンジン/UIが読む節間項目へマップ
    // 得点率があれば優先。無い一般戦などはシリーズ指数を代替表示する。
    section_points: num(series.point_rate) != null ? num(series.point_rate)
      : (num(series.total_points) != null ? num(series.total_points)
      : (num(series.series_score) != null ? num(series.series_score) : num(bw.section_points))),
    section_momentum: num(series.series_momentum_score) != null ? num(series.series_momentum_score) : num(bw.section_momentum),
    section_finishes: Array.isArray(series.finish_history) ? series.finish_history.join("-") : (str(series.finish_history) || str(bw.section_finishes) || str(bw.finish_history) || ""),
    section_st: (() => {
      const hist = Array.isArray(series.lane_finish_history) ? series.lane_finish_history : [];
      const sts = hist.map((x) => num(x?.st)).filter((x) => x !== null && x >= 0);
      if (sts.length) return Math.round((sts.reduce((a, b) => a + b, 0) / sts.length) * 1000) / 1000;
      return num(bw.section_st);
    })(),
    series_score: num(series.series_score),
    series_label: str(series.series_label),
    series_momentum_score: num(series.series_momentum_score),
    result_quality_score: num(series.result_quality_score),
    rank_pressure_score: num(series.rank_pressure_score),
    point_rate: num(series.point_rate),
    series_rank: num(series.rank),
    finish_history: str(series.finish_history),
    lane_history: str(series.lane_history),
    program_intent: str(bw.program_intent) || "",
    gamble_level: num(bw.gamble_level),
    is_scratched,
    is_absent: is_scratched,
  };
}

// BOAT WORKS RaceResult → BOAT WORKS 2 RaceResult
export function mapResult(bw) {
  const trifecta = str(bw.trifecta) || (bw.result_1 && bw.result_2 && bw.result_3 ? `${bw.result_1}-${bw.result_2}-${bw.result_3}` : null);
  const finish_order = [bw.result_1, bw.result_2, bw.result_3].map((n) => num(n)).filter((n) => n !== null);
  return {
    race_key: bw.race_key,
    result_trifecta: trifecta,
    finish_order,
    payout: num(bw.payout_trifecta) != null ? num(bw.payout_trifecta) : num(bw.payout),
    is_finished: !!trifecta,
  };
}