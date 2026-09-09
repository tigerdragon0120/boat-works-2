// 競艇オフィシャル「レーサー期別成績」パーサー
// ファン手帳固定長レイアウト（CP932/Shift-JIS）に対応
// 公式レイアウト: https://www.boatrace.jp/owpc/pc/extra/data/layout.html

// === CP932/Shift-JIS デコード ===
function decodeBytes(uint8, start, len) {
  const slice = uint8.subarray(start, start + len);
  try {
    return new TextDecoder("shift_jis").decode(slice).trim();
  } catch {
    return new TextDecoder("utf-8").decode(slice).trim();
  }
}

function decodeAll(uint8) {
  try {
    return new TextDecoder("shift_jis").decode(uint8);
  } catch {
    return new TextDecoder("utf-8").decode(uint8);
  }
}

// === 数値パース ===
const toInt = (s) => {
  const n = parseInt(s, 10);
  return Number.isFinite(n) ? n : null;
};
// 勝率など小数2桁: "0756" → 7.56
const toDec2 = (s) => {
  const n = parseInt(s, 10);
  return Number.isFinite(n) ? n / 100 : null;
};
// 複勝率など小数1桁: "0459" → 45.9
const toDec1 = (s) => {
  const n = parseInt(s, 10);
  return Number.isFinite(n) ? n / 10 : null;
};
// 平均ST: "016" → 0.16
const toST = (s) => {
  const n = parseInt(s, 10);
  return Number.isFinite(n) ? n / 100 : null;
};
// 平均ST順位: "240" → 2.40
const toSTRank = (s) => {
  const n = parseInt(s, 10);
  return Number.isFinite(n) ? n / 100 : null;
};

// YYYYMMDD → YYYY-MM-DD
const toDate = (s) => {
  const v = String(s || "").trim();
  if (v.length !== 8 || !/^\d{8}$/.test(v)) return null;
  return `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}`;
};

// === ファイル全体をデコードして行配列に分割 ===
function splitLines(uint8) {
  // CRLF/LFで行を分割（バイトレベル）
  const lines = [];
  let start = 0;
  for (let i = 0; i < uint8.length; i++) {
    if (uint8[i] === 0x0a) {
      let end = i;
      if (end > start && uint8[end - 1] === 0x0d) end--;
      if (end > start) lines.push(uint8.subarray(start, end));
      start = i + 1;
    }
  }
  if (start < uint8.length) lines.push(uint8.subarray(start));
  return lines;
}

// === 1行を固定長レイアウトでパース ===
// レイアウト定義: [フィールド名, 開始位置, バイト数, パース関数]
const LAYOUT = [
  // Part1: 基本情報
  ["registration_number", 0, 4, toInt],
  ["racer_name", 4, 16, "text"],
  ["racer_name_kana", 20, 15, "text"],
  ["branch_name", 35, 4, "text"],
  ["player_class", 39, 2, "text"],
  ["birth_era", 41, 1, "text"],
  ["birth_date_raw", 42, 6, "text"],
  ["gender", 48, 1, toInt],
  ["age", 49, 2, toInt],
  ["height", 51, 3, toInt],
  ["weight", 54, 2, toInt],
  ["blood_type", 56, 2, "text"],
  ["win_rate", 58, 4, toDec2],
  ["fukusho_rate", 62, 4, toDec1],
  ["first_count", 66, 3, toInt],
  ["second_count", 69, 3, toInt],
  ["race_count", 72, 3, toInt],
  ["yushutsu_count", 75, 2, toInt],
  ["yusho_count", 77, 2, toInt],
  ["avg_st", 79, 3, toST],
  // Part2: コース別基本 (1コース: 82-94, 各13バイト)
  ["c1_entries", 82, 3, toInt], ["c1_fukusho", 85, 4, toDec1], ["c1_avg_st", 89, 3, toST], ["c1_avg_st_rank", 92, 3, toSTRank],
  ["c2_entries", 95, 3, toInt], ["c2_fukusho", 98, 4, toDec1], ["c2_avg_st", 102, 3, toST], ["c2_avg_st_rank", 105, 3, toSTRank],
  ["c3_entries", 108, 3, toInt], ["c3_fukusho", 111, 4, toDec1], ["c3_avg_st", 115, 3, toST], ["c3_avg_st_rank", 118, 3, toSTRank],
  ["c4_entries", 121, 3, toInt], ["c4_fukusho", 124, 4, toDec1], ["c4_avg_st", 128, 3, toST], ["c4_avg_st_rank", 131, 3, toSTRank],
  ["c5_entries", 134, 3, toInt], ["c5_fukusho", 137, 4, toDec1], ["c5_avg_st", 141, 3, toST], ["c5_avg_st_rank", 144, 3, toSTRank],
  ["c6_entries", 147, 3, toInt], ["c6_fukusho", 150, 4, toDec1], ["c6_avg_st", 154, 3, toST], ["c6_avg_st_rank", 157, 3, toSTRank],
  // Part3: 期情報
  ["prev_class", 160, 2, "text"],
  ["prev2_class", 162, 2, "text"],
  ["prev3_class", 164, 2, "text"],
  ["prev_ability_index", 166, 4, toDec2],
  ["current_ability_index", 170, 4, toDec2],
  ["term_year", 174, 4, toInt],
  ["term_half_raw", 178, 1, toInt], // 1=前期, 2=後期
  ["term_start_raw", 179, 8, "text"],
  ["term_end_raw", 187, 8, "text"],
  ["training_term", 195, 3, toInt],
  // Part4: コース別着別回数 (各34バイト)
  // Course1: 198-231
  ["c1_first", 198, 3, toInt], ["c1_second", 201, 3, toInt], ["c1_third", 204, 3, toInt],
  ["c1_fourth", 207, 3, toInt], ["c1_fifth", 210, 3, toInt], ["c1_sixth", 213, 3, toInt],
  ["c1_f", 216, 2, toInt], ["c1_l0", 218, 2, toInt], ["c1_l1", 220, 2, toInt],
  ["c1_k0", 222, 2, toInt], ["c1_k1", 224, 2, toInt],
  ["c1_s0", 226, 2, toInt], ["c1_s1", 228, 2, toInt], ["c1_s2", 230, 2, toInt],
  // Course2: 232-265
  ["c2_first", 232, 3, toInt], ["c2_second", 235, 3, toInt], ["c2_third", 238, 3, toInt],
  ["c2_fourth", 241, 3, toInt], ["c2_fifth", 244, 3, toInt], ["c2_sixth", 247, 3, toInt],
  ["c2_f", 250, 2, toInt], ["c2_l0", 252, 2, toInt], ["c2_l1", 254, 2, toInt],
  ["c2_k0", 256, 2, toInt], ["c2_k1", 258, 2, toInt],
  ["c2_s0", 260, 2, toInt], ["c2_s1", 262, 2, toInt], ["c2_s2", 264, 2, toInt],
  // Course3: 266-299
  ["c3_first", 266, 3, toInt], ["c3_second", 269, 3, toInt], ["c3_third", 272, 3, toInt],
  ["c3_fourth", 275, 3, toInt], ["c3_fifth", 278, 3, toInt], ["c3_sixth", 281, 3, toInt],
  ["c3_f", 284, 2, toInt], ["c3_l0", 286, 2, toInt], ["c3_l1", 288, 2, toInt],
  ["c3_k0", 290, 2, toInt], ["c3_k1", 292, 2, toInt],
  ["c3_s0", 294, 2, toInt], ["c3_s1", 296, 2, toInt], ["c3_s2", 298, 2, toInt],
  // Course4: 300-333
  ["c4_first", 300, 3, toInt], ["c4_second", 303, 3, toInt], ["c4_third", 306, 3, toInt],
  ["c4_fourth", 309, 3, toInt], ["c4_fifth", 312, 3, toInt], ["c4_sixth", 315, 3, toInt],
  ["c4_f", 318, 2, toInt], ["c4_l0", 320, 2, toInt], ["c4_l1", 322, 2, toInt],
  ["c4_k0", 324, 2, toInt], ["c4_k1", 326, 2, toInt],
  ["c4_s0", 328, 2, toInt], ["c4_s1", 330, 2, toInt], ["c4_s2", 332, 2, toInt],
  // Course5: 334-367
  ["c5_first", 334, 3, toInt], ["c5_second", 337, 3, toInt], ["c5_third", 340, 3, toInt],
  ["c5_fourth", 343, 3, toInt], ["c5_fifth", 346, 3, toInt], ["c5_sixth", 349, 3, toInt],
  ["c5_f", 352, 2, toInt], ["c5_l0", 354, 2, toInt], ["c5_l1", 356, 2, toInt],
  ["c5_k0", 358, 2, toInt], ["c5_k1", 360, 2, toInt],
  ["c5_s0", 362, 2, toInt], ["c5_s1", 364, 2, toInt], ["c5_s2", 366, 2, toInt],
  // Course6: 368-401
  ["c6_first", 368, 3, toInt], ["c6_second", 371, 3, toInt], ["c6_third", 374, 3, toInt],
  ["c6_fourth", 377, 3, toInt], ["c6_fifth", 380, 3, toInt], ["c6_sixth", 383, 3, toInt],
  ["c6_f", 386, 2, toInt], ["c6_l0", 388, 2, toInt], ["c6_l1", 390, 2, toInt],
  ["c6_k0", 392, 2, toInt], ["c6_k1", 394, 2, toInt],
  ["c6_s0", 396, 2, toInt], ["c6_s1", 398, 2, toInt], ["c6_s2", 400, 2, toInt],
  // Part5: コースなし + 出身地
  ["no_course_l0", 402, 2, toInt],
  ["no_course_l1", 404, 2, toInt],
  ["no_course_k0", 406, 2, toInt],
  ["no_course_k1", 408, 2, toInt],
  ["birthplace", 410, 6, "text"],
];

function parseFixedLine(lineBytes) {
  const raw = {};
  for (const [name, start, len, parser] of LAYOUT) {
    if (lineBytes.length < start + len) {
      raw[name] = parser === "text" ? "" : null;
      continue;
    }
    if (parser === "text") {
      raw[name] = decodeBytes(lineBytes, start, len).trim();
    } else {
      const s = decodeBytes(lineBytes, start, len).trim();
      raw[name] = parser(s);
    }
  }
  return raw;
}

// === raw → RacerTermStats構造に変換 ===
function buildCourseStats(raw) {
  const cs = {};
  for (let c = 1; c <= 6; c++) {
    const p = String(c);
    const entries = raw[`c${c}_entries`] || 0;
    const first = raw[`c${c}_first`] || 0;
    const second = raw[`c${c}_second`] || 0;
    const third = raw[`c${c}_third`] || 0;
    const fourth = raw[`c${c}_fourth`] || 0;
    const fifth = raw[`c${c}_fifth`] || 0;
    const sixth = raw[`c${c}_sixth`] || 0;
    const f = raw[`c${c}_f`] || 0;
    const winRate = entries > 0 ? Math.round(first / entries * 1000) / 10 : null;
    const top2 = entries > 0 ? Math.round((first + second) / entries * 1000) / 10 : null;
    const top3 = entries > 0 ? Math.round((first + second + third) / entries * 1000) / 10 : null;
    cs[p] = {
      entries,
      fukusho_rate: raw[`c${c}_fukusho`],
      avg_st: raw[`c${c}_avg_st`],
      avg_st_rank: raw[`c${c}_avg_st_rank`],
      first_count: first,
      second_count: second,
      third_count: third,
      fourth_count: fourth,
      fifth_count: fifth,
      sixth_count: sixth,
      f_count: f,
      l0_count: raw[`c${c}_l0`] || 0,
      l1_count: raw[`c${c}_l1`] || 0,
      k0_count: raw[`c${c}_k0`] || 0,
      k1_count: raw[`c${c}_k1`] || 0,
      s0_count: raw[`c${c}_s0`] || 0,
      s1_count: raw[`c${c}_s1`] || 0,
      s2_count: raw[`c${c}_s2`] || 0,
      win_rate: winRate,
      top2_rate: top2,
      top3_rate: top3,
    };
  }
  return cs;
}

function rawToRecord(raw) {
  const termYear = raw.term_year;
  const termHalf = raw.term_half_raw === 1 ? "FIRST" : raw.term_half_raw === 2 ? "SECOND" : null;
  if (!termYear || !termHalf) return null;
  const reg = String(raw.registration_number || "").trim();
  if (!reg || !/^\d{3,5}$/.test(reg)) return null;

  // F/L回数全体集計
  let totalF = 0, totalL = 0;
  for (let c = 1; c <= 6; c++) {
    totalF += raw[`c${c}_f`] || 0;
    totalL += (raw[`c${c}_l0`] || 0) + (raw[`c${c}_l1`] || 0);
  }

  return {
    registration_number: reg,
    racer_name: raw.racer_name,
    racer_name_kana: raw.racer_name_kana,
    term_year: termYear,
    term_half: termHalf,
    term_key: `${termYear}_${termHalf}`,
    term_start_date: toDate(raw.term_start_raw),
    term_end_date: toDate(raw.term_end_raw),
    player_class: raw.player_class,
    prev_class: raw.prev_class,
    prev2_class: raw.prev2_class,
    prev3_class: raw.prev3_class,
    branch_name: raw.branch_name,
    birth_era: raw.birth_era,
    birth_date: raw.birth_date_raw,
    gender: raw.gender,
    age: raw.age,
    height: raw.height,
    weight: raw.weight,
    blood_type: raw.blood_type,
    birthplace: raw.birthplace,
    training_term: raw.training_term,
    win_rate: raw.win_rate,
    fukusho_rate: raw.fukusho_rate,
    first_count: raw.first_count,
    second_count: raw.second_count,
    race_count: raw.race_count,
    yushutsu_count: raw.yushutsu_count,
    yusho_count: raw.yusho_count,
    avg_st: raw.avg_st,
    prev_ability_index: raw.prev_ability_index,
    current_ability_index: raw.current_ability_index,
    f_count: totalF,
    l_count: totalL,
    course_stats: buildCourseStats(raw),
    no_course_l0: raw.no_course_l0,
    no_course_l1: raw.no_course_l1,
    no_course_k0: raw.no_course_k0,
    no_course_k1: raw.no_course_k1,
  };
}

// === 異常値チェック ===
function validateRecord(rec) {
  const warnings = [];
  if (rec.win_rate != null && rec.win_rate > 20) warnings.push(`勝率異常: ${rec.win_rate}`);
  if (rec.avg_st != null && rec.avg_st > 5) warnings.push(`ST異常: ${rec.avg_st}`);
  if (rec.race_count != null && rec.race_count > 999) warnings.push(`出走回数異常: ${rec.race_count}`);
  return warnings;
}

// === 期の自動判定（ファイル名から） ===
export function detectTermFromFilename(filename) {
  const fn = String(filename || "").toUpperCase();
  // パターン1: "2026後期" / "2026前期"
  const m1 = fn.match(/(20\d{2}).*(前|後)期/);
  if (m1) {
    const year = parseInt(m1[1], 10);
    const half = m1[2] === "前" ? "FIRST" : "SECOND";
    return { term_year: year, term_half: half, term_key: `${year}_${half}` };
  }
  // パターン2: fan2604 → 2026後期, fan2510 → 2025後期
  // ファイル名規則: fan{YY}{MM} で MM=04→後期(当年), MM=10→翌年前期
  const m2 = fn.match(/FAN(\d{2})(\d{2})/);
  if (m2) {
    const yy = parseInt(m2[1], 10);
    const mm = parseInt(m2[2], 10);
    const year = 2000 + yy;
    // 04→当年後期, 10→翌年前期
    if (mm === "04") return { term_year: year, term_half: "SECOND", term_key: `${year}_SECOND` };
    if (mm === "10") return { term_year: year + 1, term_half: "FIRST", term_key: `${year + 1}_FIRST` };
  }
  // パターン3: "2026_FIRST" / "2026_SECOND"
  const m3 = fn.match(/(20\d{2})[_-]?(FIRST|SECOND|1|2)/);
  if (m3) {
    const year = parseInt(m3[1], 10);
    const half = m3[2] === "1" || m3[2] === "FIRST" ? "FIRST" : "SECOND";
    return { term_year: year, term_half: half, term_key: `${year}_${half}` };
  }
  return null;
}

// === メインパース関数 ===
export function parseRacerTermFile(arrayBuffer, filename) {
  const uint8 = new Uint8Array(arrayBuffer);
  const lines = splitLines(uint8);

  // 空行・短すぎる行を除外
  const validLines = lines.filter((l) => l.length >= 180);
  if (!validLines.length) {
    return {
      ok: false,
      errors: ["有効なデータ行が見つかりません。固定長フォーマット(416バイト/行)を確認してください。"],
      warnings: [],
      data: null,
      preview: null,
    };
  }

  const records = [];
  const errors = [];
  const warnings = [];
  const termDetected = detectTermFromFilename(filename);

  for (let i = 0; i < validLines.length; i++) {
    try {
      const raw = parseFixedLine(validLines[i]);
      const rec = rawToRecord(raw);
      if (!rec) {
        errors.push(`行${i + 1}: 登録番号または期情報の解析失敗`);
        continue;
      }
      // ファイル名からの期判定とデータ内の期が不一致なら警告
      if (termDetected && termDetected.term_key !== rec.term_key) {
        // データ内の期を優先
      }
      const w = validateRecord(rec);
      if (w.length) warnings.push(`選手${rec.registration_number}: ${w.join(", ")}`);
      records.push(rec);
    } catch (e) {
      errors.push(`行${i + 1}: ${e.message}`);
    }
  }

  // 期のサマリー
  const termSet = new Set(records.map((r) => r.term_key));
  const terms = [...termSet].sort();

  return {
    ok: records.length > 0,
    errors,
    warnings,
    data: {
      type: "RACER_TERM",
      records,
      term_detected: termDetected,
      terms_found: terms,
    },
    preview: {
      type: "選手期別成績",
      racer_count: records.length,
      terms_found: terms,
      errors: errors.length,
      warnings: warnings.length,
      encoding: "CP932/Shift-JIS",
      sample: records.slice(0, 3).map((r) => ({
        registration_number: r.registration_number,
        racer_name: r.racer_name,
        term_key: r.term_key,
        player_class: r.player_class,
        win_rate: r.win_rate,
        avg_st: r.avg_st,
        race_count: r.race_count,
      })),
    },
  };
}