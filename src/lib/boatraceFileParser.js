// 競艇オフィシャルTXT(B番組表/K結果)パーサー
// CP932/Shift-JISデコード → B/K自動判定 → 固定レイアウト解析

// === 競艇場コードマップ(app内Home.jsxと同一) ===
const VENUE_MAP = {
  "01": "桐生", "02": "戸田", "03": "江戸川", "04": "平和島", "05": "多摩川",
  "06": "浜名湖", "07": "蒲郡", "08": "常滑", "09": "津", "10": "三国",
  "11": "びわこ", "12": "住之江", "13": "尼崎", "14": "鳴門", "15": "丸亀",
  "16": "児島", "17": "宮島", "18": "徳山", "19": "下関", "20": "若松",
  "21": "芦屋", "22": "福岡", "23": "唐津", "24": "大村",
};
const VENUE_NAME_TO_CODE = Object.entries(VENUE_MAP).reduce((a, [c, n]) => { a[n] = c; return a; }, {});

// === CP932/Shift-JISデコード ===
export function decodeFile(arrayBuffer) {
  try {
    const decoder = new TextDecoder("shift_jis");
    return decoder.decode(arrayBuffer);
  } catch {
    try {
      const decoder = new TextDecoder("utf-8");
      return decoder.decode(arrayBuffer);
    } catch {
      return "";
    }
  }
}

// === 全角→半角正規化(数字・R・コロンのみ) ===
function normalizeWidth(str) {
  return str
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
    .replace(/Ｒ/g, "R")
    .replace(/：/g, ":")
    .replace(/－/g, "-")
    .replace(/－/g, "-");
}

// === ファイル種別判定 ===
export function detectFileType(text) {
  const firstLine = text.split(/\r?\n/)[0].trim().toUpperCase();
  if (firstLine === "STARTB") return "B";
  if (firstLine === "STARTK") return "K";
  return null;
}

// === ファイル名から日付抽出 (B260909.TXT → 2026-09-09) ===
function extractDateFromFilename(filename) {
  const m = String(filename || "").match(/[BK](\d{6})\.TXT/i);
  if (m) {
    const yy = m[1].slice(0, 2), mm = m[1].slice(2, 4), dd = m[1].slice(4, 6);
    return `20${yy}-${mm}-${dd}`;
  }
  return null;
}

// === ヘッダから会場コード抽出 (24BBGN → 24) ===
function extractVenueCode(lines) {
  for (const line of lines.slice(0, 10)) {
    const m = line.match(/^(\d{2})[BK]BGN/i);
    if (m) return m[1].padStart(2, "0");
  }
  return null;
}

// === 会場名抽出 (ボートレース大村 → 大村) ===
function extractVenueName(lines) {
  for (const line of lines.slice(0, 10)) {
    const m = line.match(/ボートレース(.+)/);
    if (m) {
      const name = m[1].trim();
      return name;
    }
  }
  return null;
}

// === レース名(種別)抽出 ===
const RACE_TYPES = ["優勝戦", "準優勝戦", "特選", "選抜", "予選", "一般", "特別", "進入固定"];
function extractRaceType(text) {
  for (const t of RACE_TYPES) {
    if (text.includes(t)) return t;
  }
  return "一般";
}

// === レースヘッダ判定・解析 ===
function parseRaceHeader(line) {
  const normalized = normalizeWidth(line).trim();
  // "1R 予選 ..." or "12R 優勝戦 ..."
  const m = normalized.match(/^(\d{1,2})R\s+(.+)/);
  if (!m) return null;
  const raceNumber = parseInt(m[1]);
  const rest = m[2];
  const raceType = extractRaceType(rest);
  // 締切時刻: "電話投票締切予定15:15" or "締切予定15:15"
  const dl = rest.match(/締切(?:予定)?(\d{1,2}):(\d{2})/);
  const deadlineTime = dl ? `${dl[1].padStart(2, "0")}:${dl[2]}` : null;
  return { race_number: raceNumber, race_type: raceType, race_name: raceType, deadline_time: deadlineTime };
}

// === Bファイル 選手行解析 ===
// 例: "1 4174赤坂俊輔43長崎51A1 6.38 44.44 6.41 43.72 17 39.34 51 35.82 ..."
function parseBEntryLine(line) {
  const normalized = normalizeWidth(line).trim();
  // 級別(A1/A2/B1/B2)をアンカーとして前後を分割
  const classMatch = normalized.match(/\s(A[12]|B[12])\s/);
  if (!classMatch) return null;
  const idx = classMatch.index;
  const before = normalized.slice(0, idx).trim();
  const playerClass = classMatch[1];
  const after = normalized.slice(idx + classMatch[0].length).trim();

  // before: "1 4174赤坂俊輔43長崎51" or "1 4174 赤坂俊輔 43 長崎 51"
  const beforeParts = before.split(/\s+/);
  const boatNumber = parseInt(beforeParts[0]);
  if (!boatNumber || boatNumber < 1 || boatNumber > 6) return null;
  // 残りを結合して正規表現で分解
  const personal = beforeParts.slice(1).join("");
  const pm = personal.match(/^(\d{4})(\D+?)(\d{2})(\D+?)(\d{2})$/);
  if (!pm) return null;
  const [, registrationNumber, playerName, age, branch, weight] = pm;

  // after: 数値フィールド群
  const stats = after.split(/\s+/).map((s) => {
    const n = parseFloat(s);
    return Number.isFinite(n) ? n : null;
  });

  return {
    boat_number: boatNumber,
    registration_number: registrationNumber,
    player_name: playerName.trim(),
    age: parseInt(age),
    branch_name: branch.trim(),
    weight: parseInt(weight),
    player_class: playerClass,
    national_win_rate: stats[0] ?? null,
    national_2rate: stats[1] ?? null,
    local_win_rate: stats[2] ?? null,
    local_2rate: stats[3] ?? null,
    motor_number: stats[4] != null ? Math.round(stats[4]) : null,
    motor_2rate: stats[5] ?? null,
    boat_number_id: stats[6] != null ? String(Math.round(stats[6])) : null,
    boat_2rate: stats[7] ?? null,
    section_finishes: stats.slice(8).filter((s) => s != null).join("-") || null,
  };
}

// === Kファイル 選手行解析 ===
// 例: "01 3 3716 石渡鉄兵 45 12 7.00 3 0.27 1.52.5"
function parseKEntryLine(line) {
  const normalized = normalizeWidth(line).trim();
  const parts = normalized.split(/\s+/);
  if (parts.length < 9) return null;
  const finishOrder = parseInt(parts[0]);
  const boatNumber = parseInt(parts[1]);
  const registrationNumber = parts[2];
  if (!finishOrder || !boatNumber || !registrationNumber) return null;
  // 末尾6トークン: モーター ボート 展示 進入 ST タイム
  const raceTime = parts[parts.length - 1];
  const st = parts[parts.length - 2];
  const course = parts[parts.length - 3];
  const exhibitionTime = parts[parts.length - 4];
  const boatId = parts[parts.length - 5];
  const motorNumber = parts[parts.length - 6];
  const playerName = parts.slice(3, parts.length - 6).join(" ").trim();

  // finish_status判定
  let finishStatus = "";
  let isAbsent = false, isDisqualified = false;
  const nameUpper = playerName.toUpperCase();
  if (nameUpper.includes("F") || nameUpper.includes("フライング")) { finishStatus = "F"; }
  else if (nameUpper.includes("L") || nameUpper.includes("出遅")) { finishStatus = "L"; }
  else if (nameUpper.includes("K") || nameUpper.includes("落水")) { finishStatus = "K"; isDisqualified = true; }
  else if (nameUpper.includes("S") || nameUpper.includes("事故")) { finishStatus = "S"; isDisqualified = true; }
  else if (nameUpper.includes("欠場") || nameUpper.includes("中止")) { isAbsent = true; finishStatus = "ABS"; }

  return {
    finish_order: finishOrder,
    boat_number: boatNumber,
    registration_number: registrationNumber,
    player_name: playerName.replace(/\s+/g, ""),
    motor_number: parseInt(motorNumber) || null,
    boat_number_id: boatId,
    exhibition_time: parseFloat(exhibitionTime) || null,
    course: parseInt(course) || null,
    st: parseFloat(st) || null,
    race_time: raceTime,
    finish_status: finishStatus,
    is_absent: isAbsent,
    is_disqualified: isDisqualified,
  };
}

// === Kファイル 払戻行解析 ===
// 例: "1R 3-1-2 4490"
function parsePayoutLine(line) {
  const normalized = normalizeWidth(line).trim();
  const m = normalized.match(/^(\d{1,2})R\s+(\d-\d-\d)\s+(\d+)/);
  if (!m) return null;
  return { race_number: parseInt(m[1]), result_trifecta: m[2], payout: parseInt(m[3]) };
}

// === Bファイル解析 ===
function parseBFile(text, filename) {
  const lines = text.split(/\r?\n/);
  const errors = [], warnings = [];
  const raceDate = extractDateFromFilename(filename);
  let venueCode = extractVenueCode(lines);
  const venueName = extractVenueName(lines);
  // 会場名から会場コードを補完
  if (!venueCode && venueName) {
    venueCode = VENUE_NAME_TO_CODE[venueName] || null;
  }
  if (!raceDate) errors.push("開催日を抽出できません(ファイル名: BYYMMDD.TXT)");
  if (!venueCode) errors.push("会場コードを抽出できません");

  const races = [];
  let currentRace = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    // レースヘッダ判定
    const header = parseRaceHeader(line);
    if (header) {
      if (currentRace) races.push(currentRace);
      currentRace = { ...header, entries: [] };
      continue;
    }
    // 選手行判定(先頭が1-6 + 空白 + 4桁数字)
    if (currentRace && /^[1-6]\s+\d{4}/.test(normalizeWidth(line))) {
      const entry = parseBEntryLine(line);
      if (entry) currentRace.entries.push(entry);
    }
  }
  if (currentRace) races.push(currentRace);

  // 整合性チェック
  const validRaces = races.filter((r) => r.race_number >= 1 && r.race_number <= 12);
  if (validRaces.length === 0) errors.push("レースが検出できませんでした");
  const raceNumbers = validRaces.map((r) => r.race_number);
  const dupes = raceNumbers.filter((n, i) => raceNumbers.indexOf(n) !== i);
  if (dupes.length) errors.push(`レース番号重複: ${dupes.join(", ")}`);

  let totalEntries = 0;
  for (const r of validRaces) {
    if (r.entries.length !== 6) warnings.push(`R${r.race_number}: ${r.entries.length}艇(6艇期待)`);
    const boats = r.entries.map((e) => e.boat_number);
    const boatDupes = boats.filter((b, i) => boats.indexOf(b) !== i);
    if (boatDupes.length) warnings.push(`R${r.race_number}: 艇番重複 ${boatDupes.join(",")}`);
    totalEntries += r.entries.length;
  }

  const data = {
    type: "B",
    race_date: raceDate,
    venue_code: venueCode,
    venue_name: venueName,
    races: validRaces.map((r) => ({
      race_number: r.race_number,
      race_name: r.race_name,
      race_type: r.race_type,
      deadline_time: r.deadline_time,
      entries: r.entries,
    })),
  };

  return {
    ok: errors.length === 0,
    errors, warnings,
    data,
    preview: {
      type: "番組表(B)",
      race_date: raceDate,
      venue: venueName ? `${venueName}(${venueCode})` : venueCode,
      race_count: validRaces.length,
      entry_count: totalEntries,
    },
  };
}

// === Kファイル解析 ===
function parseKFile(text, filename) {
  const lines = text.split(/\r?\n/);
  const errors = [], warnings = [];
  const raceDate = extractDateFromFilename(filename);
  let venueCode = extractVenueCode(lines);
  const venueName = extractVenueName(lines);
  if (!venueCode && venueName) venueCode = VENUE_NAME_TO_CODE[venueName] || null;
  if (!raceDate) errors.push("開催日を抽出できません(ファイル名: KYYMMDD.TXT)");
  if (!venueCode) errors.push("会場コードを抽出できません");

  // 払戻セクション解析
  const payouts = {};
  let inPayout = false;
  const results = [];
  let currentResult = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    if (line.includes("払戻")) { inPayout = true; continue; }
    if (inPayout) {
      const p = parsePayoutLine(line);
      if (p) { payouts[p.race_number] = p; continue; }
      // 払戻セクション終了判定(レースヘッダが出てきたら)
      if (parseRaceHeader(line)) { inPayout = false; }
    }
    if (!inPayout) {
      const header = parseRaceHeader(line);
      if (header) {
        if (currentResult) results.push(currentResult);
        currentResult = { race_number: header.race_number, race_name: header.race_type, entries: [] };
        continue;
      }
      // 選手行判定(先頭が2桁数字 + 空白 + 1桁数字 + 空白 + 4桁数字)
      if (currentResult && /^\d{2}\s+\d\s+\d{4}/.test(normalizeWidth(line))) {
        const entry = parseKEntryLine(line);
        if (entry) currentResult.entries.push(entry);
      }
    }
  }
  if (currentResult) results.push(currentResult);

  // 払戻を結果にマージ
  for (const r of results) {
    const p = payouts[r.race_number];
    if (p) { r.result_trifecta = p.result_trifecta; r.payout = p.payout; }
  }

  // 整合性チェック
  const validResults = results.filter((r) => r.race_number >= 1 && r.race_number <= 12);
  if (validResults.length === 0) errors.push("結果が検出できませんでした");
  for (const r of validResults) {
    if (!r.result_trifecta) warnings.push(`R${r.race_number}: 3連単結果なし`);
    const finishes = r.entries.map((e) => e.finish_order);
    const dupes = finishes.filter((f, i) => finishes.indexOf(f) !== i);
    if (dupes.length) warnings.push(`R${r.race_number}: 着順重複 ${dupes.join(",")}`);
  }

  const data = {
    type: "K",
    race_date: raceDate,
    venue_code: venueCode,
    venue_name: venueName,
    results: validResults,
  };

  return {
    ok: errors.length === 0,
    errors, warnings,
    data,
    preview: {
      type: "結果(K)",
      race_date: raceDate,
      venue: venueName ? `${venueName}(${venueCode})` : venueCode,
      race_count: validResults.length,
      entry_count: validResults.reduce((a, r) => a + r.entries.length, 0),
    },
  };
}

// === メインエントリ: ArrayBuffer → 解析 ===
export function parseBoatraceFile(arrayBuffer, filename) {
  const text = decodeFile(arrayBuffer);
  if (!text.trim()) {
    return { ok: false, errors: ["ファイルが空です"], warnings: [], data: null, preview: null };
  }
  const type = detectFileType(text);
  if (type === "B") return parseBFile(text, filename);
  if (type === "K") return parseKFile(text, filename);
  return {
    ok: false,
    errors: ["競艇オフィシャルTXT(STARTB/STARTK)ではありません"],
    warnings: [],
    data: null,
    preview: null,
  };
}