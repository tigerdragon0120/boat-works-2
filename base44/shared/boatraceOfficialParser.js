// boatrace.jp 公式HTML決定論的パーサー
// InvokeLLM不使用。正規表現・文字コード変換のみで公式データを構造化。
// FILE(B/K)と同じ正規化データ構造へ変換し、既存saveBFileData/saveKFileDataへ渡す。

const VENUE_MAP = {
  "01": "桐生", "02": "戸田", "03": "江戸川", "04": "平和島", "05": "多摩川",
  "06": "浜名湖", "07": "蒲郡", "08": "常滑", "09": "津", "10": "三国",
  "11": "びわこ", "12": "住之江", "13": "尼崎", "14": "鳴門", "15": "丸亀",
  "16": "児島", "17": "宮島", "18": "徳山", "19": "下関", "20": "若松",
  "21": "芦屋", "22": "福岡", "23": "唐津", "24": "大村",
};

const num = (v) => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const str = (v) => (v != null ? String(v).trim() : "");

// 全角→半角正規化
function normalizeWidth(s) {
  return String(s || "")
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
    .replace(/Ｒ/g, "R").replace(/：/g, ":").replace(/－/g, "-");
}

// HTMLタグ削除 → テキスト抽出
function stripTags(html) {
  return String(html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&yen;/g, "¥")
    .replace(/&#165;/g, "¥")
    .replace(/&#65509;/g, "￥")
    .replace(/[\s\u3000]+/g, " ")
    .trim();
}

// HTTP取得(指数バックオフ付き)
export async function fetchHtml(url, maxRetries = 3) {
  let lastError;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 30000);
      try {
        const res = await fetch(url, {
          signal: controller.signal,
          headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
            "Accept": "text/html,application/xhtml+xml",
            "Accept-Language": "ja,en;q=0.9",
          },
        });
        clearTimeout(timer);
        if (res.status === 429 || res.status >= 500) {
          throw new Error(`HTTP ${res.status}`);
        }
        if (res.status !== 200) {
          return { ok: false, status: res.status, html: "" };
        }
        const html = await res.text();
        return { ok: true, status: 200, html };
      } finally {
        clearTimeout(timer);
      }
    } catch (e) {
      lastError = e;
      if (attempt < maxRetries) {
        const delays = [2000, 5000, 15000];
        await new Promise((r) => setTimeout(r, delays[attempt] || 15000));
      }
    }
  }
  return { ok: false, status: 0, html: "", error: lastError?.message || "fetch failed" };
}

// URLビルダー
export function buildUrl(type, raceDate, venueCode, raceNumber) {
  const hd = raceDate.replace(/-/g, "");
  const jcd = venueCode.padStart(2, "0");
  const rno = raceNumber;
  switch (type) {
    case "index": return `https://boatrace.jp/owpc/pc/race/index?hd=${hd}`;
    case "racelist": return `https://boatrace.jp/owpc/pc/race/racelist?rno=${rno}&jcd=${jcd}&hd=${hd}`;
    case "raceresult": return `https://boatrace.jp/owpc/pc/race/raceresult?rno=${rno}&jcd=${jcd}&hd=${hd}`;
    case "beforeinfo": return `https://boatrace.jp/owpc/pc/race/beforeinfo?rno=${rno}&jcd=${jcd}&hd=${hd}`;
    case "odds3t": return `https://boatrace.jp/owpc/pc/race/odds3t?rno=${rno}&jcd=${jcd}&hd=${hd}`;
    case "resultlist": return `https://boatrace.jp/owpc/pc/race/resultlist?jcd=${jcd}&hd=${hd}`;
    default: return "";
  }
}

// =====================================================
// レース指数ページ解析 → 開催場リスト
// =====================================================
export function parseRaceIndex(html) {
  const venues = [];
  const seen = new Set();
  // raceindex?jcd=XX&hd=YYYYMMDD リンクから会場コード抽出
  // HTML内の & は &amp; とエンコードされている場合があるため両方にマッチ
  const pattern = /raceindex\?jcd=(\d{2})(?:&amp;|&)hd=(\d{8})/g;
  let match;
  while ((match = pattern.exec(html)) !== null) {
    const code = match[1];
    if (!seen.has(code)) {
      seen.add(code);
      venues.push({ venue_code: code, venue_name: VENUE_MAP[code] || code });
    }
  }
  return venues;
}

// =====================================================
// racelist上部の締切予定時刻(1R〜12R)を抽出
// =====================================================
export function parseDeadlineTimes(html) {
  const marker = String(html || '').indexOf('締切予定時刻');
  if (marker < 0) return [];
  // 締切行は短いtable行なので次の </tr> までに限定し、他の時刻を混ぜない。
  const tail = String(html || '').slice(marker);
  const rowEnd = tail.indexOf('</tr>');
  const row = rowEnd >= 0 ? tail.slice(0, rowEnd) : tail.slice(0, 5000);
  const times = [];
  const re = /(\d{1,2}:\d{2})/g;
  let m;
  while ((m = re.exec(normalizeWidth(stripTags(row)))) !== null) {
    if (!times.includes(m[1])) times.push(m[1]);
  }
  return times.slice(0, 12);
}

// =====================================================
// 出走表(racelist)解析 → Bファイル形式データ
// =====================================================
export function parseRaceCard(html, raceDate, venueCode, venueName, raceNumber = null) {
  const errors = [];
  const warnings = [];

  // レース名抽出 (h3見出し)
  let raceName = "";
  const nameMatch = html.match(/<h3[^>]*>([\s\S]*?)<\/h3>/);
  if (nameMatch) {
    raceName = stripTags(nameMatch[1]).replace(/\s+/g, " ").trim();
  }

  // レース種別
  const RACE_TYPES = ["優勝戦", "準優勝戦", "特選", "選抜", "予選", "一般", "特別", "進入固定"];
  let raceType = "一般";
  for (const t of RACE_TYPES) {
    if (raceName.includes(t)) { raceType = t; break; }
  }

  // 締切時刻抽出。公式racelistには「締切予定時刻」の1行に1R〜12Rが並ぶ。
  // 以前は先頭時刻だけを拾っていたため全レースが1Rの締切になっていた。
  const deadlineTimes = parseDeadlineTimes(html);
  let deadlineTime = null;
  if (raceNumber && deadlineTimes.length >= raceNumber) {
    deadlineTime = deadlineTimes[raceNumber - 1];
  } else if (deadlineTimes.length === 1) {
    deadlineTime = deadlineTimes[0];
  }

  // 選手データ抽出: racerphoto/XXXX.jpg をアンカーに6艇を特定
  const photoPattern = /racerphoto\/(\d{4})\.jpg/g;
  const regNumbers = [];
  let pm;
  while ((pm = photoPattern.exec(html)) !== null) {
    regNumbers.push(pm[1]);
  }

  if (regNumbers.length < 6) {
    errors.push(`選手${regNumbers.length}艇(6艇必要)`);
    return { ok: false, errors, warnings, data: null };
  }

  // 先頭6艇を使用(重複除去しつつ順序保持)
  const entries = [];
  for (let i = 0; i < Math.min(6, regNumbers.length); i++) {
    const regNum = regNumbers[i];
    const boatNumber = i + 1;

    // 各選手の周辺HTMLから統計値を抽出
    // racerphoto/XXXX.jpg の直後にある td セル群を探す
    const photoIdx = html.indexOf(`racerphoto/${regNum}.jpg`);
    if (photoIdx < 0) continue;

    // 選手行情報を含む広範囲HTML(前後3000文字)
    const start = Math.max(0, photoIdx - 200);
    const end = Math.min(html.length, photoIdx + 3000);
    const section = html.slice(start, end);
    const text = normalizeWidth(stripTags(section));

    // 級別抽出 (A1/A2/B1/B2)
    const classMatch = text.match(/(?:\/\s*)?(A[12]|B[12])/);
    const playerClass = classMatch ? classMatch[1] : null;

    // 選手名抽出 (登録番号の後の名前)
    const nameMatch2 = text.match(/\d{4}\s*\/\s*[AB][12]\s*([^\d\s][^\d]+)/);
    const playerName = nameMatch2 ? nameMatch2[1].trim().replace(/\s+/g, "") : "";

    // F数・L数・平均ST抽出
    const fMatch = text.match(/F(\d+)/);
    const lMatch = text.match(/L(\d+)/);
    const stMatch = text.match(/F\d+\s*L\d+\s*(\d+\.\d+)/);
    const fCount = fMatch ? num(fMatch[1]) : null;
    const lCount = lMatch ? num(lMatch[1]) : null;
    const avgSt = stMatch ? num(stMatch[1]) : null;

    // 全国勝率・2連率・3連率 (F/L/STの直後の3つの小数)
    const statsAfterSt = text.match(/F\d+\s*L\d+\s*\d+\.\d+\s*(\d+\.\d+)\s*(\d+\.\d+)\s*(\d+\.\d+)/);
    const nationalWinRate = statsAfterSt ? num(statsAfterSt[1]) : null;
    const national2rate = statsAfterSt ? num(statsAfterSt[2]) : null;
    const national3rate = statsAfterSt ? num(statsAfterSt[3]) : null;

    // 当地勝率・2連率・3連率 (全国の直後の3つ)
    const localMatch = statsAfterSt ? text.match(
      new RegExp(statsAfterSt[3].replace(".", "\\.") + "\\s*(\\d+\\.\\d+)\\s*(\\d+\\.\\d+)\\s*(\\d+\\.\\d+)")
    ) : null;
    const localWinRate = localMatch ? num(localMatch[1]) : null;
    const local2rate = localMatch ? num(localMatch[2]) : null;
    const local3rate = localMatch ? num(localMatch[3]) : null;

    // モーターNo・2連率・3連率 (当地の直後)
    const motorMatch = localMatch ? text.match(
      new RegExp(localMatch[3].replace(".", "\\.") + "\\s*(\\d+)\\s*(\\d+\\.\\d+)\\s*(\\d+\\.\\d+)")
    ) : null;
    const motorNumber = motorMatch ? num(motorMatch[1]) : null;
    const motor2rate = motorMatch ? num(motorMatch[2]) : null;
    const motor3rate = motorMatch ? num(motorMatch[3]) : null;

    // ボートNo・2連率・3連率 (モーターの直後)
    const boatMatch = motorMatch ? text.match(
      new RegExp(motorMatch[3].replace(".", "\\.") + "\\s*(\\d+)\\s*(\\d+\\.\\d+)\\s*(\\d+\\.\\d+)")
    ) : null;
    const boatNumberId = boatMatch ? String(boatMatch[1]) : null;
    const boat2rate = boatMatch ? num(boatMatch[2]) : null;
    const boat3rate = boatMatch ? num(boatMatch[3]) : null;

    entries.push({
      boat_number: boatNumber,
      registration_number: regNum,
      player_name: playerName,
      player_class: playerClass,
      national_win_rate: nationalWinRate,
      national_2rate: national2rate,
      national_f2_rate: national2rate,
      national_f3_rate: national3rate,
      national_3rate: national3rate,
      local_win_rate: localWinRate,
      local_2rate: local2rate,
      local_f2_rate: local2rate,
      local_f3_rate: local3rate,
      local_3rate: local3rate,
      motor_number: motorNumber,
      motor_2rate: motor2rate,
      motor_f2_rate: motor2rate,
      motor_f3_rate: motor3rate,
      motor_3rate: motor3rate,
      boat_number_id: boatNumberId,
      boat_2rate: boat2rate,
      boat_f2_rate: boat2rate,
      boat_f3_rate: boat3rate,
      boat_3rate: boat3rate,
      f_count: fCount,
      l_count: lCount,
      avg_st: avgSt,
    });
  }

  if (entries.length !== 6) {
    warnings.push(`解析艇数${entries.length}(6艇期待)`);
  }

  const data = {
    type: "B",
    race_date: raceDate,
    venues: [{
      venue_code: venueCode,
      venue_name: venueName || VENUE_MAP[venueCode] || venueCode,
      races: [{
        race_number: null, // 外部から設定
        race_name: raceName,
        race_type: raceType,
        deadline_time: deadlineTime,
        deadline_times: deadlineTimes,
        entries,
      }],
    }],
  };

  return { ok: errors.length === 0, errors, warnings, data };
}

// =====================================================
// レース結果(raceresult)解析 → Kファイル形式データ
// =====================================================
export function parseResult(html, raceDate, venueCode, venueName) {
  const errors = [];
  const warnings = [];
  const text = normalizeWidth(stripTags(html));

  // 着順表抽出: 着順(1-6) + 枠 + 登録番号+氏名 + タイム
  // normalizeWidth後のため半角数字でマッチ。テキスト: "1 4 4992廣瀬　　篤哉 1'50"1"
  const finishPattern = /([1-6])\s+(\d)\s+(\d{4})\s*(\S+)\s+(\d['"]?\d+["']?\d*)/g;
  const entries = [];
  let fm;
  while ((fm = finishPattern.exec(text)) !== null) {
    const finishOrder = parseInt(fm[1], 10);
    const boatNumber = num(fm[2]);
    const regNum = fm[3];
    const playerName = fm[4].trim().replace(/\s+/g, "");
    const raceTime = fm[5];
    if (finishOrder >= 1 && finishOrder <= 6 && boatNumber >= 1 && boatNumber <= 6) {
      entries.push({ finish_order: finishOrder, boat_number: boatNumber, registration_number: regNum, player_name: playerName, race_time: raceTime });
    }
  }

  // 重複除去(着順順)
  const seenFin = new Set();
  const uniqueEntries = [];
  for (const e of entries) {
    if (!seenFin.has(e.finish_order)) {
      seenFin.add(e.finish_order);
      uniqueEntries.push(e);
    }
  }

  // 3連単結果・払戻抽出(テキストから)
  let resultTrifecta = null;
  let payout = null;
  // 3連単結果・払戻抽出(テキストから)
  // 組番に空白が入る場合に対応: "3連単 1 - 2 - 4 ¥1,830"
  const triMatch = text.match(/3連単\s+(\d\s*-\s*\d\s*-\s*\d)\s+[¥￥]?([\d,]+)/);
  if (triMatch) {
    resultTrifecta = triMatch[1].replace(/\s/g, "");
    payout = num(triMatch[2].replace(/,/g, ""));
  }

  // ST情報抽出: img_boat2_X.png の後にST値(.19やF.05形式に対応)
  const stPattern = /img_boat2_(\d)\.png[\s\S]*?(-?\d*\.\d+|F\.\d+)/g;
  const stMap = {};
  let sm;
  while ((sm = stPattern.exec(html)) !== null) {
    const bn = num(sm[1]);
    let stVal = sm[2];
    if (stVal.startsWith("F")) stVal = -Math.abs(num(stVal.slice(1)) || 0);
    else stVal = num(stVal);
    if (bn >= 1 && bn <= 6) stMap[bn] = stVal;
  }

  // 決まり手抽出
  let winningMethod = null;
  const methodMatch = text.match(/決まり手\s*(逃げ|まくり|差し|まくり差し|抜き|恵まれ|その他)/);
  if (methodMatch) winningMethod = methodMatch[1];

  // 天候情報抽出(テキストから)
  let weather = null, windSpeed = null, waterTemp = null, airTemp = null, waveHeight = null;
  const airTempMatch = text.match(/気温([\d.]+)℃/);
  if (airTempMatch) airTemp = num(airTempMatch[1]);
  const windMatch = text.match(/風速(\d+)m/);
  if (windMatch) windSpeed = num(windMatch[1]);
  const waterMatch = text.match(/水温([\d.]+)℃/);
  if (waterMatch) waterTemp = num(waterMatch[1]);
  const waveMatch = text.match(/波高(\d+)cm/);
  if (waveMatch) waveHeight = num(waveMatch[1]);
  const weatherTypeMatch = text.match(/(晴れ|曇り|雨|雪|霧)/);
  if (weatherTypeMatch) weather = weatherTypeMatch[1];

  // 結果のentriesにSTと決まり手を付与
  for (const e of uniqueEntries) {
    e.st = stMap[e.boat_number] ?? null;
    e.winning_method = e.finish_order === 1 ? winningMethod : null;
  }

  if (!resultTrifecta) {
    errors.push("3連単結果が見つかりません");
    return { ok: false, errors, warnings, data: null };
  }

  const finishOrder = uniqueEntries.sort((a, b) => a.finish_order - b.finish_order).map((e) => e.boat_number);

  const data = {
    type: "K",
    race_date: raceDate,
    venues: [{
      venue_code: venueCode,
      venue_name: venueName || VENUE_MAP[venueCode] || venueCode,
      results: [{
        race_number: null,
        result_trifecta: resultTrifecta,
        payout: payout || 0,
        entries: uniqueEntries,
        weather,
        wind_speed: windSpeed,
        water_temp: waterTemp,
        air_temp: airTemp,
        wave_height: waveHeight,
        finish_order: finishOrder,
      }],
    }],
  };

  return { ok: errors.length === 0, errors, warnings, data };
}

// =====================================================
// 直前情報(beforeinfo)解析 → 展示データ
// HTML構造(boatrace.jp/owpc/pc/race/beforeinfo):
//   選手行: toban=XXXX → 選手名 → 体重 → 展示タイム → チルト → ...
//   スタート展示: table1_boatImage1Number is-typeX → 艇番
//                  table1_boatImage1Time → ST値(.06, F.01等)
// =====================================================
export function parseBeforeInfo(html) {
  const errors = [];
  const warnings = [];

  // toban=XXXX から登録番号を6艇分抽出(重複除去・順序保持)
  const tobanPattern = /toban=(\d{4})/g;
  const regNumbers = [];
  let tm;
  while ((tm = tobanPattern.exec(html)) !== null) {
    if (!regNumbers.includes(tm[1])) regNumbers.push(tm[1]);
  }

  // スタート展示ST抽出: table1_boatImage1Number is-typeX → 艇番, table1_boatImage1Time → ST
  const stExMap = {};
  const stExPattern = /table1_boatImage1Number\s+is-type(\d)[^>]*>(\d)<\/span>[\s\S]*?table1_boatImage1Time[^>]*>([^<]+)<\/span>/g;
  let se;
  while ((se = stExPattern.exec(html)) !== null) {
    const bn = num(se[2]);
    let stStr = se[3].trim();
    let stVal = null;
    if (stStr.startsWith("F")) {
      // "F.01" → -0.01, "F.03" → -0.03 (F後の数値は hundredths)
      const afterF = stStr.replace(/^F\.?/, "");
      stVal = -Math.abs(num("0." + afterF) || 0);
    } else {
      // ".06" → 0.06, "0.06" → 0.06
      stVal = num(stStr.replace(/^\./, "0."));
    }
    if (bn >= 1 && bn <= 6) stExMap[bn] = stVal;
  }

  // スタート展示進入コース抽出: is-typeX のXがコース番号
  const courseMap = {};
  const coursePattern = /table1_boatImage1Number\s+is-type(\d)[^>]*>(\d)<\/span>/g;
  let ce;
  while ((ce = coursePattern.exec(html)) !== null) {
    const course = num(ce[1]);
    const bn = num(ce[2]);
    if (bn >= 1 && bn <= 6) courseMap[bn] = course;
  }

  const exhibitionData = [];

  for (let i = 0; i < Math.min(6, regNumbers.length); i++) {
    const regNum = regNumbers[i];
    const boatNumber = i + 1;

    // toban=XXXX の直後のHTMLから展示タイム・チルトを抽出
    // 構造: <td rowspan="4">展示タイム</td><td rowspan="4">チルト</td>
    const tobanIdx = html.indexOf(`toban=${regNum}`);
    if (tobanIdx < 0) continue;

    // 選手名の後の td 要素を順に抽出
    const section = html.slice(tobanIdx, tobanIdx + 2000);
    const tdRe = /<td[^>]*rowspan="(\d+)"[^>]*>([\s\S]*?)<\/td>/g;
    const tdValues = [];
    let td;
    while ((td = tdRe.exec(section)) !== null) {
      const text = stripTags(td[2]).replace(/&nbsp;/g, "").trim();
      tdValues.push(text);
    }

    // tdValuesの構造: [艇番, 選手名(リンク内), 体重, 展示タイム, チルト, ...]
    // 展示タイムは "6.71" 形式、チルトは "0.0" 形式
    let exhibitionTime = null;
    let tilt = null;
    for (const v of tdValues) {
      if (exhibitionTime === null && /^\d+\.\d{2}$/.test(v) && num(v) >= 5 && num(v) <= 9) {
        exhibitionTime = num(v);
      } else if (tilt === null && exhibitionTime !== null && /^-?\d+\.\d$/.test(v)) {
        tilt = num(v);
      }
      if (exhibitionTime !== null && tilt !== null) break;
    }

    // 欠場判定
    const isAbsent = /欠場|返還/.test(section);

    exhibitionData.push({
      boat_number: boatNumber,
      registration_number: regNum,
      exhibition_time: exhibitionTime,
      exhibition_st: stExMap[boatNumber] ?? null,
      exhibition_st_raw: stExMap[boatNumber] ?? null,
      exhibition_course: courseMap[boatNumber] || boatNumber,
      tilt,
      is_absent: isAbsent,
      is_scratched: isAbsent,
    });
  }

  // 天候情報抽出
  let weather = null, windSpeed = null, waterTemp = null, airTemp = null, waveHeight = null;
  const airTempMatch = html.match(/気温([\d.]+)℃/);
  if (airTempMatch) airTemp = num(airTempMatch[1]);
  const windMatch = html.match(/風速(\d+)m/);
  if (windMatch) windSpeed = num(windMatch[1]);
  const waterMatch = html.match(/水温([\d.]+)℃/);
  if (waterMatch) waterTemp = num(waterMatch[1]);
  const waveMatch = html.match(/波高(\d+)cm/);
  if (waveMatch) waveHeight = num(waveMatch[1]);
  const weatherTypeMatch = html.match(/(晴れ|曇り|雨|雪|霧)/);
  if (weatherTypeMatch) weather = weatherTypeMatch[1];

  // 実展示値(展示タイム+ST)が6艇揃った場合のみOK
  const realCount = exhibitionData.filter(
    (e) => e.exhibition_time != null && e.exhibition_st != null
  ).length;

  if (exhibitionData.length < 6) {
    warnings.push(`展示データ${exhibitionData.length}艇(6艇期待)`);
  }
  if (realCount < 6) {
    warnings.push(`実展示値${realCount}艇(展示タイム+ST必要)`);
  }

  return {
    ok: exhibitionData.length >= 6 && realCount >= 6,
    errors,
    warnings,
    data: {
      entries: exhibitionData,
      weather,
      wind_speed: windSpeed,
      water_temp: waterTemp,
      air_temp: airTemp,
      wave_height: waveHeight,
      real_exhibition_count: realCount,
    },
  };
}

// =====================================================
// 3連単オッズ(odds3t)解析 → odds_map
// HTML構造(boatrace.jp/owpc/pc/race/odds3t):
//   thead: 6列グループ(2着=1〜6)、各グループ3列(2着番号, 選手名, ...)
//   tbody: 20行(5ブロック×4行)、各行6グループ
//     各グループ: (1着 rowspan="4"), 3着, oddsPoint
//     rowspan=4の1着値は4行分継続
//   組み合わせ: 1着-2着-3着 = odds
// =====================================================
export function parseOdds3t(html) {
  const oddsMap = {};

  const oddsStart = html.indexOf("3連単オッズ");
  if (oddsStart < 0) return oddsMap;

  // テーブル範囲を特定
  const tableStart = html.indexOf("<table", oddsStart);
  if (tableStart < 0) return oddsMap;
  const tableEnd = html.indexOf("</table>", tableStart);
  const tableHtml = html.slice(tableStart, tableEnd + 10);

  // theadから2着艇番(1-6)を抽出
  const theadStart = tableHtml.indexOf("<thead");
  const theadEnd = tableHtml.indexOf("</thead>");
  const theadHtml = theadStart >= 0 ? tableHtml.slice(theadStart, theadEnd + 8) : "";
  const secondBoatNumbers = [];
  const headerBoatRe = /is-boatColor(\d)[^>]*>(\d)</g;
  let hm;
  while ((hm = headerBoatRe.exec(theadHtml)) !== null) {
    secondBoatNumbers.push(num(hm[2]));
  }
  if (secondBoatNumbers.length < 6) return oddsMap;

  // tbodyを取得
  const tbodyStart = tableHtml.indexOf("<tbody");
  if (tbodyStart < 0) return oddsMap;
  const tbodyEnd = tableHtml.indexOf("</tbody>", tbodyStart);
  const tbodyHtml = tableHtml.slice(tbodyStart, tbodyEnd + 8);

  // trごとに分割
  const trRe = /<tr[^>]*>([\s\S]*?)<\/tr>/g;
  const rows = [];
  let tr;
  while ((tr = trRe.exec(tbodyHtml)) !== null) {
    rows.push(tr[1]);
  }

  // 各列グループの現在の1着値(rowspan追跡用)
  const currentFirst = [null, null, null, null, null, null];
  const remainingRowspan = [0, 0, 0, 0, 0, 0];

  for (const rowHtml of rows) {
    // 行内の全tdを抽出(属性付き)
    const tdRe = /<td([^>]*)>([\s\S]*?)<\/td>/g;
    const cells = [];
    let td;
    while ((td = tdRe.exec(rowHtml)) !== null) {
      const attrs = td[1];
      const text = stripTags(td[2]).replace(/&nbsp;/g, "").trim();
      const rowspanMatch = attrs.match(/rowspan="(\d+)"/);
      const rowspan = rowspanMatch ? parseInt(rowspanMatch[1], 10) : 0;
      const isBoatColor = /is-boatColor/.test(attrs);
      const isOddsPoint = /oddsPoint/.test(attrs);
      cells.push({ text, rowspan, isBoatColor, isOddsPoint });
    }

    // 列グループ(0-5)ごとに処理
    // 各グループは3セル: (1着+rowspan or 継続), 3着, odds
    // rowspanがある場合は1着が新しい値、ない場合は前の1着を継続
    let colGroup = 0;
    let cellIdx = 0;
    while (cellIdx < cells.length && colGroup < 6) {
      // rowspan残りが0の場合、次のセルが1着(rowspan付き)
      if (remainingRowspan[colGroup] <= 0) {
        // 1着セルを探す
        if (cellIdx < cells.length && cells[cellIdx].rowspan > 0) {
          currentFirst[colGroup] = num(cells[cellIdx].text);
          remainingRowspan[colGroup] = cells[cellIdx].rowspan;
          cellIdx++;
        }
      }

      if (remainingRowspan[colGroup] > 0) {
        // 3着 + odds のペアを抽出
        if (cellIdx + 1 < cells.length) {
          const thirdBoat = num(cells[cellIdx].text);
          const oddsVal = num(cells[cellIdx + 1].text.replace(/,/g, ""));
          const firstBoat = currentFirst[colGroup];
          const secondBoat = secondBoatNumbers[colGroup];

          if (firstBoat && secondBoat && thirdBoat &&
              firstBoat !== secondBoat && firstBoat !== thirdBoat && secondBoat !== thirdBoat &&
              oddsVal && oddsVal >= 1.0) {
            oddsMap[`${firstBoat}-${secondBoat}-${thirdBoat}`] = oddsVal;
          }
          cellIdx += 2;
        }
      }
      colGroup++;
    }

    // rowspan カウントダウン
    for (let i = 0; i < 6; i++) {
      if (remainingRowspan[i] > 0) remainingRowspan[i]--;
    }
  }

  return oddsMap;
}

export { VENUE_MAP };