// ============================================================
// BOATCAST正規化レイヤー
// BOATCAST → NORMALIZER → BW2標準データ → 予想エンジン
//
// BOATCASTの項目名をそのまま予想エンジンへ直接流さない。
// 今後データ源を変更しても予想エンジンを変更しなくて済むようにする。
// ============================================================

function toHalfWidth(s) {
  return String(s).replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0));
}

function parseNum(v) {
  if (v == null) return null;
  const n = parseFloat(toHalfWidth(String(v).trim()));
  return Number.isFinite(n) ? n : null;
}

function parseStr(v) {
  if (v == null) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
}

function normalizeName(s) {
  return String(s || '').replace(/[\s\u3000]/g, '');
}

function parseSt(s) {
  if (!s) return null;
  const cleaned = toHalfWidth(s).trim();
  if (cleaned === '' || cleaned === '-') return null;
  const st = parseFloat('0' + cleaned);
  return Number.isFinite(st) ? st : null;
}

function parseCourse(s) {
  if (!s) return null;
  const half = toHalfWidth(s).trim();
  if (half === '' || half === '-') return null;
  if (half === '不') return '不';
  const n = parseInt(half);
  return Number.isFinite(n) ? n : null;
}

// ============================================================
// str3テキストを解析・BW2標準形式へ正規化
//
// str3フィールド構成(0-indexed):
//  0: 登録番号
//  1: 選手名
//  2: 養成期
//  3: 支部:出身地
//  4: 年齢
//  5: 級別
//  6: (空)
//  7: Fフラグ (F or space)
//  8: Lフラグ (L or space)
//  9: 平均ST
// 10-12: 全国 勝率, 2連率, 3連率
// 13-15: 当地 勝率, 2連率, 3連率
// 16-19: モーター ?(常0), 番号, 2連率, 3連率
// 20-23: ボート ?(常0), 番号, 2連率, 3連率
// 24: 最新節間レース番号
// 25+: 節間成績 (raceNum,boatNum,finish,ST,course)
//
// ※公式boatrace.jpヘッダー構造と照合済み:
//   モーター列 = "No 2連率 3連率" → [17]=番号, [18]=2連率, [19]=3連率
//   ボート列 = "No 2連率 3連率" → [21]=番号, [22]=2連率, [23]=3連率
//   [16],[20]の"0"は公式サイトに表示なし(モーター/ボートF数の可能性)
// ============================================================
export function normalizeStr3(text, metadata) {
  const lines = text.split('\n').filter(l => l.trim() && l !== 'data=');
  // "1\t7" ヘッダー行を解析(シリーズ何日目か、シリーズ日数の可能性)
  const headerLine = lines[0] || '';
  const headerParts = headerLine.split('\t');
  const seriesDay = parseNum(headerParts[0]);
  const seriesTotalDays = parseNum(headerParts[1]);
  const racerLines = lines.slice(1);

  const racers = racerLines.map((line, idx) => {
    const parts = line.split('\t');
    const reg = parseStr(parts[0]);
    const name = normalizeName(parts[1]);
    const trainingTerm = parseStr(parts[2]);
    const branchBirth = parseStr(parts[3]);
    const [branchRaw, birthplaceRaw] = (branchBirth || '').split(':');
    const branch = branchRaw ? branchRaw.replace(/[\s\u3000]/g, '') : null;
    const birthplace = birthplaceRaw ? birthplaceRaw.replace(/[\s\u3000]/g, '') : null;
    const age = parseNum(parts[4]);
    const playerClass = parseStr(parts[5]);
    const fFlag = parseStr(parts[7]);
    const lFlag = parseStr(parts[8]);
    const avgSt = parseNum(parts[9]);

    const nationalWinRate = parseNum(parts[10]);
    const national2Rate = parseNum(parts[11]);
    const national3Rate = parseNum(parts[12]);
    const localWinRate = parseNum(parts[13]);
    const local2Rate = parseNum(parts[14]);
    const local3Rate = parseNum(parts[15]);

    const motorUnknown = parseNum(parts[16]); // 常に0(公式非表示)
    const motorNumber = parseNum(parts[17]);
    const motor2Rate = parseNum(parts[18]);
    const motor3Rate = parseNum(parts[19]);
    const boatUnknown = parseNum(parts[20]); // 常に0(公式非表示)
    const boatNumber = parseNum(parts[21]);
    const boat2Rate = parseNum(parts[22]);
    const boat3Rate = parseNum(parts[23]);

    const latestSectionRace = parseStr(parts[24]);

    // 節間成績
    const sectionRaces = [];
    for (let i = 25; i < parts.length; i++) {
      const raceData = parts[i]?.trim();
      if (!raceData || raceData === '-,-,-,-,-') {
        sectionRaces.push(null);
        continue;
      }
      const [raceNum, boatNum, finish, st, course] = raceData.split(',');
      sectionRaces.push({
        race_number: parseNum(raceNum),
        boat_number: parseNum(boatNum),
        finish_order: parseNum(finish),
        st: parseSt(st),
        course: parseCourse(course),
      });
    }

    return {
      lane: idx + 1,
      registration_number: reg,
      player_name: name,
      player_class: playerClass,
      branch_name: branch,
      birthplace,
      age,
      training_term: trainingTerm,
      f_flag: fFlag,
      l_flag: lFlag,
      avg_st: avgSt,
      national_win_rate: nationalWinRate,
      national_2rate: national2Rate,
      national_3rate: national3Rate,
      local_win_rate: localWinRate,
      local_2rate: local2Rate,
      local_3rate: local3Rate,
      motor_number: motorNumber,
      motor_2rate: motor2Rate,
      motor_3rate: motor3Rate,
      boat_number: boatNumber,
      boat_2rate: boat2Rate,
      boat_3rate: boat3Rate,
      latest_section_race: latestSectionRace,
      section_races: sectionRaces,
    };
  });

  return {
    source: 'BOATCAST',
    metadata,
    series_day: seriesDay,
    series_total_days: seriesTotalDays,
    racers,
  };
}