// 競艇オフィシャルTXT(B番組表/K結果)パーサー
// CP932/Shift-JISデコード → B/K自動判定 → 会場セクション検出 → 固定レイアウト解析
// 1ファイル = 1日分の全国複数会場対応(XXBBGN/XXKBGN セクション分割)

// === 競艇場コードマップ ===
const VENUE_MAP = {
  "01": "桐生", "02": "戸田", "03": "江戸川", "04": "平和島", "05": "多摩川",
  "06": "浜名湖", "07": "蒲郡", "08": "常滑", "09": "津", "10": "三国",
  "11": "びわこ", "12": "住之江", "13": "尼崎", "14": "鳴門", "15": "丸亀",
  "16": "児島", "17": "宮島", "18": "徳山", "19": "下関", "20": "若松",
  "21": "芦屋", "22": "福岡", "23": "唐津", "24": "大村",
};

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

// === 全角→半角正規化(数字・R・コロン・ハイフンのみ) ===
function normalizeWidth(str) {
  return str
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
    .replace(/Ｒ/g, "R")
    .replace(/：/g, ":")
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

// =====================================================
// 会場セクション検出(最重要修正)
// Bファイル: XXBBGN ... XXBEND
// Kファイル: XXKBGN ... XXKEND
// 次のXXBBGN/XXKBGNが出た時点で前のセクションを確定(終端マーカーなしでも対応)
// =====================================================
function splitVenueSections(lines, fileType) {
  const marker = fileType === "B" ? "B" : "K";
  const beginRe = new RegExp(`^(\\d{2})${marker}BGN$`, "i");
  const endRe = new RegExp(`^(\\d{2})${marker}END$`, "i");

  const sections = [];
  let current = null;

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim().toUpperCase();

    // 開始マーカー検出 → 前のセクション確定 + 新セクション開始
    const bMatch = trimmed.match(beginRe);
    if (bMatch) {
      if (current) sections.push(current);
      current = { venue_code: bMatch[1].padStart(2, "0"), lines: [] };
      continue;
    }

    // 終了マーカー検出 → セクション確定
    const eMatch = trimmed.match(endRe);
    if (eMatch && current) {
      sections.push(current);
      current = null;
      continue;
    }

    // セクション内の行を蓄積
    if (current) {
      current.lines.push(lines[i]);
    }
  }

  // 最後のセクション(終了マーカーなしの場合)
  if (current) sections.push(current);
  return sections;
}

// === 会場名抽出(セクション内先頭20行から) ===
function extractVenueNameFromLines(lines) {
  for (const line of lines.slice(0, 20)) {
    const m = line.match(/ボートレース(.+)/);
    if (m) {
      return m[1].trim().replace(/[\s　]+$/, "");
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
  const m = normalized.match(/^(\d{1,2})R\s+(.+)/);
  if (!m) return null;
  const raceNumber = parseInt(m[1]);
  const rest = m[2];
  const raceType = extractRaceType(rest);
  const dl = rest.match(/締切(?:予定)?(\d{1,2}):(\d{2})/);
  const deadlineTime = dl ? `${dl[1].padStart(2, "0")}:${dl[2]}` : null;
  return { race_number: raceNumber, race_type: raceType, race_name: raceType, deadline_time: deadlineTime };
}

// === Bファイル 選手行解析 ===
function parseBEntryLine(line) {
  const normalized = normalizeWidth(line).trim();
  const classMatch = normalized.match(/(\d{2})(A[12]|B[12])\s/);
  if (!classMatch) return null;
  const idx = classMatch.index;
  const before = normalized.slice(0, idx + 2).trim();
  const playerClass = classMatch[2];
  const after = normalized.slice(idx + classMatch[0].length).trim();

  const beforeParts = before.split(/\s+/);
  const boatNumber = parseInt(beforeParts[0]);
  if (!boatNumber || boatNumber < 1 || boatNumber > 6) return null;
  const personal = beforeParts.slice(1).join("");
  const pm = personal.match(/^(\d{4})(\D+?)(\d{2})(\D+?)(\d{2})$/);
  if (!pm) return null;
  const [, registrationNumber, playerName, age, branch, weight] = pm;

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
function parseKEntryLine(line) {
  const normalized = normalizeWidth(line).trim();
  const parts = normalized.split(/\s+/);
  if (parts.length < 9) return null;

  // 着順欄は通常 01〜06 だが、事故時は F / L0 / L1 / K0 / K1 / S0 / S1 / S2 等になる。
  // 数字だけを許可すると事故艇が履歴から消えるため、状態コードも正式に扱う。
  const finishToken = String(parts[0] || "").toUpperCase();
  const numericFinish = /^\d{1,2}$/.test(finishToken) ? parseInt(finishToken, 10) : null;
  const boatNumber = parseInt(parts[1], 10);
  const registrationNumber = String(parts[2] || "").trim();
  if (!boatNumber || boatNumber < 1 || boatNumber > 6 || !/^\d{4}$/.test(registrationNumber)) return null;

  const raceTime = parts[parts.length - 1];
  const stToken = String(parts[parts.length - 2] || "").toUpperCase();
  const course = parts[parts.length - 3];
  const exhibitionTime = parts[parts.length - 4];
  const boatId = parts[parts.length - 5];
  const motorNumber = parts[parts.length - 6];
  const playerName = parts.slice(3, parts.length - 6).join(" ").trim();

  let finishStatus = numericFinish ? "" : finishToken;
  let isAbsent = false;
  let isDisqualified = false;

  if (/^F$/.test(finishToken)) finishStatus = "F";
  else if (/^L[01]?$/.test(finishToken)) finishStatus = finishToken;
  else if (/^K[01]?$/.test(finishToken)) { finishStatus = finishToken; isDisqualified = true; }
  else if (/^S[012]?$/.test(finishToken)) { finishStatus = finishToken; isDisqualified = true; }
  else if (/^(欠|欠場|中止|ABS)$/i.test(finishToken)) { finishStatus = "ABS"; isAbsent = true; }

  // STは通常 0.12、フライング時は F0.03。Fは負数として保存して情報を失わない。
  let st = null;
  if (/^F\d*\.?\d+$/.test(stToken)) {
    const v = parseFloat(stToken.slice(1));
    st = Number.isFinite(v) ? -Math.abs(v) : null;
  } else {
    const v = parseFloat(stToken);
    st = Number.isFinite(v) ? v : null;
  }

  return {
    finish_order: numericFinish,
    boat_number: boatNumber,
    registration_number: registrationNumber,
    player_name: playerName.replace(/\s+/g, ""),
    motor_number: parseInt(motorNumber, 10) || null,
    boat_number_id: boatId,
    exhibition_time: Number.isFinite(parseFloat(exhibitionTime)) ? parseFloat(exhibitionTime) : null,
    course: parseInt(course, 10) || null,
    st,
    race_time: raceTime,
    finish_status: finishStatus,
    is_absent: isAbsent,
    is_disqualified: isDisqualified,
  };
}

// === Kファイル 払戻行解析 ===
function parsePayoutLine(line) {
  const normalized = normalizeWidth(line).trim();
  const m = normalized.match(/^(\d{1,2})R\s+(\d-\d-\d)\s+(\d+)/);
  if (!m) return null;
  return { race_number: parseInt(m[1]), result_trifecta: m[2], payout: parseInt(m[3]) };
}

// =====================================================
// Bファイル解析(全会場対応)
// =====================================================
function parseBFile(text, filename) {
  const lines = text.split(/\r?\n/);
  const errors = [], warnings = [];
  const raceDate = extractDateFromFilename(filename);
  if (!raceDate) errors.push("開催日を抽出できません(ファイル名: BYYMMDD.TXT)");

  const sections = splitVenueSections(lines, "B");
  if (sections.length === 0) {
    errors.push("会場セクション(XXBBGN)を検出できません");
  }

  const venues = [];
  const globalKeys = new Set();

  for (const section of sections) {
    const venueCode = section.venue_code;
    const venueName = VENUE_MAP[venueCode] || extractVenueNameFromLines(section.lines) || venueCode;

    const races = [];
    let currentRace = null;

    for (const line of section.lines) {
      if (!line.trim()) continue;
      const header = parseRaceHeader(line);
      if (header) {
        if (currentRace) races.push(currentRace);
        currentRace = { ...header, entries: [] };
        continue;
      }
      // 公式TXTの艇データ行には先頭空白が入ることがある。
      // trimStart()せず ^ で判定すると正しい行を全件取りこぼすため、必ず左空白を除去して判定する。
      const normalizedLine = normalizeWidth(line).trimStart();
      if (currentRace && /^[1-6]\s+\d{4}/.test(normalizedLine)) {
        const entry = parseBEntryLine(line);
        if (entry) currentRace.entries.push(entry);
      }
    }
    if (currentRace) races.push(currentRace);

    // 会場内バリデーション
    const validRaces = races.filter((r) => r.race_number >= 1 && r.race_number <= 12);
    if (validRaces.length === 0) warnings.push(`${venueName}: レースが検出できません`);

    const raceNumbers = validRaces.map((r) => r.race_number);
    const dupes = raceNumbers.filter((n, i) => raceNumbers.indexOf(n) !== i);
    if (dupes.length) errors.push(`${venueName}: レース番号重複 ${dupes.join(",")}`);

    for (const r of validRaces) {
      if (r.entries.length !== 6) warnings.push(`${venueName} R${r.race_number}: ${r.entries.length}艇(6艇期待)`);
      const boats = r.entries.map((e) => e.boat_number);
      const boatDupes = boats.filter((b, i) => boats.indexOf(b) !== i);
      if (boatDupes.length) warnings.push(`${venueName} R${r.race_number}: 艇番重複 ${boatDupes.join(",")}`);

      // 全国全体のRaceKey重複チェック
      const key = `${raceDate}_${venueCode}_${r.race_number}`;
      if (globalKeys.has(key)) errors.push(`RaceKey重複: ${key}`);
      globalKeys.add(key);
    }

    venues.push({
      venue_code: venueCode,
      venue_name: venueName,
      races: validRaces.map((r) => ({
        race_number: r.race_number,
        race_name: r.race_name,
        race_type: r.race_type,
        deadline_time: r.deadline_time,
        entries: r.entries,
      })),
    });
  }

  const totalRaces = venues.reduce((a, v) => a + v.races.length, 0);
  const totalEntries = venues.reduce((a, v) => a + v.races.reduce((s, r) => s + r.entries.length, 0), 0);

  const data = {
    type: "B",
    race_date: raceDate,
    venues,
  };

  return {
    ok: errors.length === 0,
    errors, warnings,
    data,
    preview: {
      type: "番組表(B)",
      race_date: raceDate,
      venue_count: venues.length,
      race_count: totalRaces,
      entry_count: totalEntries,
      venues: venues.map((v) => ({
        venue_code: v.venue_code,
        venue_name: v.venue_name,
        race_count: v.races.length,
        entry_count: v.races.reduce((s, r) => s + r.entries.length, 0),
      })),
    },
  };
}

// === K結果1Rの厳格検査 ===
// 元TXT自体が壊れているケースを予想学習へ混ぜないため、異常レースは保存対象から除外する。
function validateKResult(r, venueName) {
  const reasons = [];
  const entries = Array.isArray(r.entries) ? r.entries : [];
  if (entries.length !== 6) reasons.push(`選手行${entries.length}艇（6艇必要）`);

  const boats = entries.map((e) => Number(e.boat_number));
  const validBoats = boats.every((b) => Number.isInteger(b) && b >= 1 && b <= 6);
  if (!validBoats) reasons.push("艇番不正");
  if (new Set(boats).size !== entries.length) reasons.push("艇番重複");
  if (entries.length === 6 && ![1,2,3,4,5,6].every((b) => boats.includes(b))) reasons.push("1〜6号艇が揃っていない");

  const regs = entries.map((e) => String(e.registration_number || "").trim());
  if (regs.some((x) => !/^\d{4}$/.test(x))) reasons.push("登録番号不正/欠損");
  if (regs.filter(Boolean).length && new Set(regs).size !== regs.length) reasons.push("登録番号重複");

  const tri = String(r.result_trifecta || "").trim();
  if (!/^([1-6])-([1-6])-([1-6])$/.test(tri)) reasons.push("3連単結果不正/欠損");
  else {
    const nums = tri.split("-").map(Number);
    if (new Set(nums).size !== 3) reasons.push("3連単結果の艇番重複");
    const finishByPos = entries.filter((e) => [1,2,3].includes(Number(e.finish_order))).sort((a,b) => Number(a.finish_order)-Number(b.finish_order)).map((e) => Number(e.boat_number));
    if (finishByPos.length === 3 && finishByPos.join("-") !== tri) reasons.push(`着順と3連単不一致(${finishByPos.join("-")}≠${tri})`);
  }

  if (r.payout != null && (!Number.isFinite(Number(r.payout)) || Number(r.payout) < 0)) reasons.push("払戻金不正");
  return reasons;
}

// =====================================================
// Kファイル解析(全会場対応)
// =====================================================
function parseKFile(text, filename) {
  const lines = text.split(/\r?\n/);
  const errors = [], warnings = [];
  const raceDate = extractDateFromFilename(filename);
  if (!raceDate) errors.push("開催日を抽出できません(ファイル名: KYYMMDD.TXT)");

  const sections = splitVenueSections(lines, "K");
  if (sections.length === 0) {
    errors.push("会場セクション(XXKBGN)を検出できません");
  }

  const venues = [];
  const globalKeys = new Set();

  for (const section of sections) {
    const venueCode = section.venue_code;
    const venueName = VENUE_MAP[venueCode] || extractVenueNameFromLines(section.lines) || venueCode;

    const payouts = {};
    let inPayout = false;
    const results = [];
    let currentResult = null;

    for (const line of section.lines) {
      if (!line.trim()) continue;
      if (line.includes("払戻")) { inPayout = true; continue; }
      if (inPayout) {
        const p = parsePayoutLine(line);
        if (p) { payouts[p.race_number] = p; continue; }
        if (parseRaceHeader(line)) { inPayout = false; }
      }
      if (!inPayout) {
        const header = parseRaceHeader(line);
        if (header) {
          if (currentResult) results.push(currentResult);
          currentResult = { race_number: header.race_number, race_name: header.race_type, entries: [] };
          continue;
        }
        // K公式TXTの選手行は通常「  01  3 3716 ...」のように先頭空白を含む。
        // 旧実装は ^\d で直接判定していたため、結果Rだけ取れて6艇データを全件取りこぼしていた。
        const normalizedLine = normalizeWidth(line).trimStart();
        if (currentResult && /^(?:\d{2}|F|L[01]?|K[01]?|S[012]?|欠|欠場|中止)\s+\d\s+\d{4}(?:\s|$)/i.test(normalizedLine)) {
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

    // 会場内バリデーション。壊れた1Rが混ざっていても、正常Rまで捨てない。
    const detectedResults = results.filter((r) => r.race_number >= 1 && r.race_number <= 12);
    if (detectedResults.length === 0) warnings.push(`${venueName}: 結果が検出できません`);

    const validResults = [];
    const rejectedResults = [];
    for (const r of detectedResults) {
      const reasons = validateKResult(r, venueName);
      if (reasons.length) {
        rejectedResults.push({ race_number: r.race_number, reasons });
        warnings.push(`${venueName} R${r.race_number}: 元データ破損疑いのため除外 — ${reasons.join(" / ")}`);
        continue;
      }

      const key = `${raceDate}_${venueCode}_${r.race_number}`;
      if (globalKeys.has(key)) {
        rejectedResults.push({ race_number: r.race_number, reasons: ["RaceKey重複"] });
        warnings.push(`${venueName} R${r.race_number}: RaceKey重複のため除外`);
        continue;
      }
      globalKeys.add(key);
      validResults.push(r);
    }

    venues.push({
      venue_code: venueCode,
      venue_name: venueName,
      results: validResults,
      rejected_results: rejectedResults,
    });
  }

  const totalResults = venues.reduce((a, v) => a + v.results.length, 0);
  const totalEntries = venues.reduce((a, v) => a + v.results.reduce((s, r) => s + r.entries.length, 0), 0);
  const rejectedCount = venues.reduce((a, v) => a + (v.rejected_results || []).length, 0);

  const data = {
    type: "K",
    race_date: raceDate,
    venues,
  };

  return {
    ok: errors.length === 0,
    errors, warnings,
    data,
    preview: {
      type: "結果(K)",
      race_date: raceDate,
      venue_count: venues.length,
      race_count: totalResults,
      entry_count: totalEntries,
      rejected_count: rejectedCount,
      venues: venues.map((v) => ({
        venue_code: v.venue_code,
        venue_name: v.venue_name,
        race_count: v.results.length,
        entry_count: v.results.reduce((s, r) => s + r.entries.length, 0),
        rejected_count: (v.rejected_results || []).length,
      })),
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