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
  // カンマ付き数値("4,400"等)を正しく解析するためカンマを除去
  const cleaned = toHalfWidth(String(v).trim()).replace(/,/g, '');
  const n = parseFloat(cleaned);
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

// ============================================================
// tkzテキストを解析・BW2標準形式へ正規化
//
// tkzフィールド構成(0-indexed):
//  0: 選手名(全角スペース含む)
//  1: 展示タイム(秒)  例: 6.82  "-.--"=未確定
//  2: フラグ(0/1)  意味不明
//  3: コード(000/010等)  意味不明
//  4: 体重(kg)  例: 52.0
//  5: フラグ(0/1)  意味不明(調整体重関連の可能性)
//  6: チルト  例: "- 0.5", "+ 0.0"
//  7+: 節間成績等(任意)
//
// 最終行: スタート展示ST
//  "1\t.05\tF\t2\t.04\tF\t3\t.08\t\t4\t.03\tF\t5\t.07\tF\t6\t.01\tF"
//  → 艇番, ST, F flag の繰り返し
// ============================================================
export function normalizeTkz(text, metadata) {
  const lines = text.split('\n').filter(l => l.trim() && l !== 'data=');
  const racerLines = lines.filter(l => !/^\d\s*$/.test(l) && !/^\d\t\.\d/.test(l));
  const stLine = lines.find(l => /^\d\t\.\d/.test(l));

  const racers = racerLines.map((line, idx) => {
    const parts = line.split('\t');
    return {
      lane: idx + 1,
      racer_name: parseStr(parts[0])?.replace(/[\s\u3000]+/g, ' ').trim() || null,
      exhibition_time: parseNum(parts[1]),
      _raw_flag2: parseStr(parts[2]),
      _raw_code3: parseStr(parts[3]),
      weight: parseNum(parts[4]),
      _raw_flag5: parseStr(parts[5]),
      tilt: parseStr(parts[6])?.trim() || null,
      _raw_rest: parts.slice(7).filter(p => p && p.trim()),
    };
  });

  let start_exhibition_st = [];
  if (stLine) {
    const stParts = stLine.split('\t');
    for (let i = 0; i < stParts.length; i += 3) {
      const lane = parseInt(stParts[i]);
      if (!Number.isFinite(lane)) continue;
      start_exhibition_st.push({
        lane,
        st: parseNum(stParts[i + 1]),
        f_flag: parseStr(stParts[i + 2]) || null,
      });
    }
  }

  return {
    source: 'BOATCAST',
    metadata,
    racers,
    start_exhibition_st,
  };
}

// ============================================================
// sttテキストを解析・BW2標準形式へ正規化
//
// sttフィールド構成(0-indexed):
//  0: 艇番(1-6)
//  1: 進入コース(1-6)  ※艇番と異なる場合あり(進入変更)
//  2: 選手名
//  3: 展示ST(展示走行時)  例: .15
//  4: ST(スタート展示時)  例: .05
//  5: F flag  "F" or ""
//  6: 不明(3.5等)  意味不明
// ============================================================
export function normalizeStartExhibition(text, metadata) {
  const lines = text.split('\n').filter(l => l.trim() && l !== 'data=');
  const racerLines = lines.filter(l => /^\d\t\d/.test(l));

  const racers = racerLines.map(line => {
    const parts = line.split('\t');
    return {
      lane: parseInt(parts[0]),
      course: parseInt(parts[1]),
      racer_name: parseStr(parts[2])?.replace(/[\s\u3000]+/g, ' ').trim() || null,
      exhibition_st: parseNum(parts[3]),
      st: parseNum(parts[4]),
      f_flag: parseStr(parts[5]) || null,
      _raw_field6: parseNum(parts[6]),
    };
  });

  return {
    source: 'BOATCAST',
    metadata,
    racers,
  };
}

// ============================================================
// tkz + stt を統合して標準直前情報を生成
// ============================================================
export function normalizeExhibitionData(tkzResult, sttResult, metadata) {
  const tkz = tkzResult?.racers || [];
  const stt = sttResult?.racers || [];
  const tkzSt = tkzResult?.start_exhibition_st || [];

  // ST順位計算(CALCULATED)
  // BOATCASTに完成済みST順がないため、stt.stから計算
  const validSts = stt.filter(s => s.st != null && s.f_flag !== 'F');
  const sortedBySt = [...validSts].sort((a, b) => a.st - b.st);
  const stRankMap = {};
  sortedBySt.forEach((s, idx) => { stRankMap[s.lane] = idx + 1; });

  const racers = tkz.map(tkzRacer => {
    const sttRacer = stt.find(s => s.lane === tkzRacer.lane);
    const stData = tkzSt.find(s => s.lane === tkzRacer.lane);
    return {
      lane: tkzRacer.lane,
      racer_name: tkzRacer.racer_name,
      exhibition_time: tkzRacer.exhibition_time,
      exhibition_course: sttRacer?.course ?? null,
      exhibition_st: sttRacer?.exhibition_st ?? null,
      st: sttRacer?.st ?? stData?.st ?? null,
      exhibition_start_rank: stRankMap[tkzRacer.lane] ?? null,
      exhibition_start_rank_source: stRankMap[tkzRacer.lane] ? 'CALCULATED' : null,
      weight: tkzRacer.weight,
      adjustment_weight: null,
      tilt: tkzRacer.tilt,
      f_flag: sttRacer?.f_flag ?? stData?.f_flag ?? null,
    };
  });

  const validCount = racers.filter(r =>
    r.exhibition_time != null && r.exhibition_course != null
  ).length;
  let status = 'WAITING';
  if (validCount === 6) status = 'COMPLETE';
  else if (validCount > 0) status = 'PARTIAL';

  return {
    race_date: metadata?.race_date || null,
    venue_code: metadata?.venue_code || null,
    race_number: metadata?.race_number || null,
    racers,
    conditions: null,
    status,
    source: 'BOATCAST',
    fetched_at: metadata?.fetched_at || new Date().toISOString(),
  };
}

// ============================================================
// tokuten_hayamiテキストを解析・BW2標準形式へ正規化
//
// tokuten_hayamiフィールド構成(0-indexed):
//  0: 枠番
//  1: 級別
//  2: 登録番号
//  3: 選手名
//  4: フラグ(00/01)
//  5: 現在得点率
//  6: 現在順位
//  7: 不明(出走回数ではない・着順別得点率から逆算可能)
//  8,10,12,14,16,18: 1着〜6着時の得点率
//  9,11,13,15,17: 不明(着順別の何らかのカウント)
//  19: (空)
//  20: 最新節間レース番号
//
// ※total_points, race_countは元データに直接存在しないためnull
// ※semifinal_border_rank, semifinal_statusも元データに不存在のためnull
// ============================================================
export function normalizeTokutenHayami(text, metadata) {
  const lines = text.split('\n').filter(l => l.trim() && l !== 'data=');
  const racerLines = lines.filter(l => /^\d\t/.test(l));

  const racers = racerLines.map((line) => {
    const parts = line.split('\t');
    const lane = parseInt(parts[0]);
    const playerClass = parseStr(parts[1]);
    const reg = parseStr(parts[2]);
    const name = normalizeName(parts[3]);
    const flag = parseStr(parts[4]);
    const pointRate = parseNum(parts[5]);
    const rank = parseNum(parts[6]);
    const unknownField7 = parseNum(parts[7]);

    const finish1stRate = parseNum(parts[8]);
    const finish1stCount = parseNum(parts[9]);
    const finish2ndRate = parseNum(parts[10]);
    const finish2ndCount = parseNum(parts[11]);
    const finish3rdRate = parseNum(parts[12]);
    const finish3rdCount = parseNum(parts[13]);
    const finish4thRate = parseNum(parts[14]);
    const finish4thCount = parseNum(parts[15]);
    const finish5thRate = parseNum(parts[16]);
    const finish5thCount = parseNum(parts[17]);
    const finish6thRate = parseNum(parts[18]);
    const finish6thCount = parseNum(parts[19]);
    const latestSectionRace = parseStr(parts[20]);

    return {
      lane,
      registration_number: reg,
      player_name: name,
      player_class: playerClass,
      point_rate: pointRate,
      rank,
      total_points: null, // 元データに直接不存在
      race_count: null, // 元データに直接不存在(field[7]は別値)
      semifinal_border_rank: null,
      semifinal_status: null,
      finish_scenarios: {
        first: finish1stRate,
        second: finish2ndRate,
        third: finish3rdRate,
        fourth: finish4thRate,
        fifth: finish5thRate,
        sixth: finish6thRate,
      },
      // 補助情報(元データの意味不明フィールドも保持)
      _raw_flag: flag,
      _raw_field7: unknownField7,
      _raw_finish_counts: {
        first: finish1stCount,
        second: finish2ndCount,
        third: finish3rdCount,
        fourth: finish4thCount,
        fifth: finish5thCount,
        sixth: finish6thCount,
      },
      _raw_latest_section_race: latestSectionRace,
    };
  });

  return {
    source: 'BOATCAST',
    metadata,
    racers,
  };
}

// ============================================================
// rs1テキストを解析・BW2標準形式へ正規化(レース結果)
//
// rs1フィールド構成:
//  Line 0: "data="
//  Line 1: ステータス("1"=available)
//  Line 2-7: 着順データ(6艇分)
//    [0]: 着順(全角数字)
//    [1]: 艇番(1-6)
//    [2]: 選手名
//    [3]: レースタイム(1'51"2等, 未完走時は空)
//  Line 8-13: STデータ(6艇分)
//    [0]: 艇番
//    [1]: ST(.08等)
//    [2]: F flag("F" or "")
//    [3]: 決まり手(1着艇のみ, "逃げ"等)
//  Line 14: 進入コース(艇番順に6値)
//  Line 15: 天候・風・波
//    [0]: 天候
//    [1]: 風速
//    [2]: 波高
//    [3]: 風向
// ============================================================
export function normalizeRs1(text, metadata) {
  const lines = text.split('\n').filter(l => l.trim() && l !== 'data=');
  if (lines.length < 7) return { ok: false, error: `insufficient lines: ${lines.length}` };

  const status = lines[0].trim();
  if (status !== '1') return { ok: false, error: `not available: status=${status}`, status };

  const finishLines = lines.slice(1, 7);
  const stLines = lines.slice(7, 13);
  const courseLine = lines[13] || '';
  const conditionLine = lines[14] || '';

  // 着順データ解析
  const results = finishLines.map((line, idx) => {
    const parts = line.split('\t');
    const finishOrder = idx + 1; // 1着から順に並んでいる
    const boatNumber = parseNum(parts[1]);
    const racerName = parseStr(parts[2])?.replace(/[\s\u3000]+/g, ' ').trim() || null;
    const raceTime = parseStr(parts[3]) || null;
    return {
      finish_order: finishOrder,
      boat_number: boatNumber,
      racer_name: racerName,
      race_time: raceTime,
    };
  });

  // STデータ解析
  const stData = stLines.map(line => {
    const parts = line.split('\t');
    return {
      boat_number: parseNum(parts[0]),
      st: parseSt(parts[1]),
      f_flag: parseStr(parts[2]) || null,
      winning_method: parseStr(parts[3])?.replace(/[\s\u3000]+/g, '') || null,
    };
  });

  // 進入コース解析(艇番順に6値)
  const courseParts = courseLine.split('\t').map(p => parseNum(p));
  const courseMap = {};
  for (let i = 0; i < 6; i++) {
    if (courseParts[i] != null) courseMap[i + 1] = courseParts[i];
  }

  // 天候情報
  const condParts = conditionLine.split('\t');
  const conditions = {
    weather: parseStr(condParts[0]),
    wind_speed: parseNum(condParts[1]),
    wave_height: parseNum(condParts[2]),
    wind_dir: parseStr(condParts[3]),
  };

  // 結果統合(艇番ごと)
  const boats = results.map(r => {
    const st = stData.find(s => s.boat_number === r.boat_number);
    return {
      boat_number: r.boat_number,
      finish_order: r.finish_order,
      racer_name: r.racer_name,
      race_time: r.race_time,
      st: st?.st ?? null,
      f_flag: st?.f_flag ?? null,
      course: courseMap[r.boat_number] ?? null,
      winning_method: r.finish_order === 1 ? st?.winning_method : null,
      result_status: 'NORMAL',
    };
  });

  // 3連単確定(1-2-3着の艇番)
  const top3 = boats.filter(b => b.finish_order >= 1 && b.finish_order <= 3).sort((a, b) => a.finish_order - b.finish_order);
  const trifecta = top3.length === 3 ? `${top3[0].boat_number}-${top3[1].boat_number}-${top3[2].boat_number}` : null;

  return {
    ok: true,
    source: 'BOATCAST',
    race_date: metadata?.race_date || null,
    venue_code: metadata?.venue_code || null,
    race_number: metadata?.race_number || null,
    status: 'RESULT_FINAL',
    trifecta,
    boats,
    winning_method: boats.find(b => b.finish_order === 1)?.winning_method || null,
    conditions,
    fetched_at: metadata?.fetched_at || new Date().toISOString(),
  };
}

// ============================================================
// rs2テキストを解析・BW2標準形式へ正規化(払戻データ)
//
// rs2フィールド構成:
//  Line 0: "data="
//  Line 1: ステータス("1\t0" 等, 1=available)
//  Line 2+: 払戻データ
//    2連単: "1\t-\t2\t1,280\t円\t7" (艇1-艇2, 払戻, 単位, 人気)
//    2連複: "1\t=\t2\t800\t円\t4"
//    3連単: "1\t2\t4\t4,400\t円\t21" (3数値, 1行目)
//    3連複: "1\t2\t4\t1,290\t円\t8" (3数値, 2行目)
//    拡連複: "1\t=\t2\t290\t円\t6" (=区切り, 3行目以降)
// ============================================================
export function normalizeRs2(text, metadata) {
  const lines = text.split('\n').filter(l => l.trim() && l !== 'data=');
  if (lines.length < 2) return { ok: false, error: `insufficient lines: ${lines.length}` };

  const statusParts = lines[0].split('\t');
  const status = statusParts[0]?.trim();
  if (status !== '1') return { ok: false, error: `not available: status=${status}`, status };

  const payoutLines = lines.slice(1);
  const payouts = {
    trifecta: null,      // 3連単
    trifecta_quinella: null, // 3連複
    exacta: null,        // 2連単
    quinella: null,      // 2連複
    wide: [],            // 拡連複
  };

  let threeNumCount = 0; // 3数値行のカウント(1回目=3連単, 2回目=3連複)
  let equalCount = 0;    // =区切り行のカウント(1回目=2連複, 2回目以降=拡連複)

  for (const line of payoutLines) {
    const parts = line.split('\t');
    const hasDash = parts.includes('-');
    const hasEqual = parts.includes('=');

    if (hasDash) {
      // 2連単: "1 - 2 1280 円 7"
      const b1 = parseNum(parts[0]);
      const b2 = parseNum(parts[2]);
      const payout = parseNum(parts[3]);
      const popularity = parseNum(parts[5]);
      if (b1 && b2 && payout) {
        payouts.exacta = { combination: `${b1}-${b2}`, payout, popularity };
      }
    } else if (hasEqual) {
      // 2連複 or 拡連複
      equalCount++;
      const b1 = parseNum(parts[0]);
      const b2 = parseNum(parts[2]);
      const payout = parseNum(parts[3]);
      const popularity = parseNum(parts[5]);
      if (b1 && b2 && payout) {
        if (equalCount === 1) {
          payouts.quinella = { combination: `${b1}=${b2}`, payout, popularity };
        } else {
          payouts.wide.push({ combination: `${b1}=${b2}`, payout, popularity });
        }
      }
    } else {
      // 3連単 or 3連複(3数値行)
      threeNumCount++;
      const b1 = parseNum(parts[0]);
      const b2 = parseNum(parts[1]);
      const b3 = parseNum(parts[2]);
      const payout = parseNum(parts[3]);
      const popularity = parseNum(parts[5]);
      if (b1 && b2 && b3 && payout) {
        if (threeNumCount === 1) {
          // 3連単
          payouts.trifecta = { combination: `${b1}-${b2}-${b3}`, payout, popularity };
        } else {
          // 3連複
          payouts.trifecta_quinella = { combination: `${b1}=${b2}=${b3}`, payout, popularity };
        }
      }
    }
  }

  return {
    ok: true,
    source: 'BOATCAST',
    race_date: metadata?.race_date || null,
    venue_code: metadata?.venue_code || null,
    race_number: metadata?.race_number || null,
    status: 'RESULT_FINAL',
    payouts,
    fetched_at: metadata?.fetched_at || new Date().toISOString(),
  };
}

// ============================================================
// rs1 + rs2 を統合して標準レース結果を生成
// ============================================================
export function normalizeRaceResult(rs1Result, rs2Result, metadata) {
  const rs1 = rs1Result?.ok ? rs1Result : null;
  const rs2 = rs2Result?.ok ? rs2Result : null;

  if (!rs1) return { ok: false, error: 'rs1 not available' };

  const boats = rs1.boats || [];
  const trifecta = rs1.trifecta;
  const payout = rs2?.payouts?.trifecta?.payout || null;
  const popularity = rs2?.payouts?.trifecta?.popularity || null;

  return {
    ok: true,
    source: 'BOATCAST',
    race_date: metadata?.race_date || rs1.race_date,
    venue_code: metadata?.venue_code || rs1.venue_code,
    race_number: metadata?.race_number || rs1.race_number,
    status: 'RESULT_FINAL',
    result_trifecta: trifecta,
    finish_order: boats.map(b => b.boat_number),
    boats,
    winning_method: rs1.winning_method,
    conditions: rs1.conditions,
    payout,
    popular_trifecta: popularity != null ? `${popularity}番人気` : null,
    payouts: rs2?.payouts || null,
    fetched_at: metadata?.fetched_at || new Date().toISOString(),
  };
}

// ============================================================
// od3テキストを解析・BW2標準形式へ正規化
//
// od3フィールド構成(艇ごと1行):
//  0: 選手名(全角スペース含む)
//  1-20: 3連単オッズ(20通り)
//    順序: 2着=2→3着=3,4,5,6 / 2着=3→3着=2,4,5,6 / ...
//  21-25: 欠場フラグ(1=欠場, 0=出走)
//
// 先頭行: ステータスコード("1"=available, "0"/"2"=waiting, "3"=cancelled)
// ============================================================
export function normalizeOd3(text, metadata) {
  const lines = text.split('\n').filter(l => l.trim() && l !== 'data=');
  if (lines.length < 7) return { ok: false, error: `insufficient lines: ${lines.length}` };

  const status = lines[0].trim();
  const racerLines = lines.slice(1, 7);
  const racerNames = [];
  const odds = [];

  for (let first = 1; first <= 6; first++) {
    const parts = racerLines[first - 1].split('\t');
    racerNames.push(parts[0]?.trim() || '');
    const withdrawalFlags = parts.slice(21, 26).map(f => f === '1');

    let idx = 1;
    for (let second = 1; second <= 6; second++) {
      if (second === first) continue;
      for (let third = 1; third <= 6; third++) {
        if (third === first || third === second) continue;
        const oddsVal = parseNum(parts[idx]);
        odds.push({
          combination: `${first}-${second}-${third}`,
          first, second, third,
          odds: oddsVal != null && oddsVal > 0 ? oddsVal : null,
          is_withdraw: withdrawalFlags[second - 1] || withdrawalFlags[third - 1],
        });
        idx++;
      }
    }
  }

  const combos = odds.map(o => o.combination);
  const uniqueCombos = new Set(combos);

  return {
    ok: true,
    source: 'BOATCAST',
    race_date: metadata?.race_date || null,
    venue_code: metadata?.venue_code || null,
    race_number: metadata?.race_number || null,
    odds_type: 'TRIFECTA',
    status,
    racer_names: racerNames,
    odds,
    fetched_at: metadata?.fetched_at || new Date().toISOString(),
    count: odds.length,
    integrity: {
      total: odds.length,
      unique: uniqueCombos.size,
      duplicates: odds.length - uniqueCombos.size,
      null_odds: odds.filter(o => o.odds == null).length,
      withdraw: odds.filter(o => o.is_withdraw).length,
      all_valid: (odds.length - uniqueCombos.size) === 0 && odds.length === 120,
    },
  };
}