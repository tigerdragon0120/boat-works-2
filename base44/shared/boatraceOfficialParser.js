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
// =====================================================
export function parseBeforeInfo(html) {
  const errors = [];

  // 各艇の展示タイム・チルト抽出
  // toban=XXXX をアンカーに各艇のデータを特定
  const tobanPattern = /toban=(\d{4})/g;
  const regNumbers = [];
  let tm;
  while ((tm = tobanPattern.exec(html)) !== null) {
    if (!regNumbers.includes(tm[1])) regNumbers.push(tm[1]);
  }

  const exhibitionData = [];

  // スタート展示セクション抽出
  const stExStart = html.indexOf("スタート展示");
  const stExSection = stExStart >= 0 ? html.slice(stExStart, stExStart + 2000) : "";

  // スタート展示ST: img_boat2_X.png の後にST値
  const stExPattern = /img_boat2_(\d)\.png[\s\S]*?(-?\d+\.\d+|F\.\d+)/g;
  const stExMap = {};
  let se;
  while ((se = stExPattern.exec(stExSection)) !== null) {
    const bn = num(se[1]);
    let stVal = se[2];
    if (stVal.startsWith("F")) stVal = -Math.abs(num(stVal.slice(1)));
    else stVal = num(stVal);
    stExMap[bn] = stVal;
  }

  // 進入(展示コース)抽出: スタート展示セクションのコース情報
  // boatrace.jpでは進入は1-6の並びで表示される
  const coursePattern = /img_boat2_(\d)\.png[\s\S]*?(\d)\s*\.|img_boat2_(\d)\.png[\s\S]*?進入[\s\S]*?(\d)/g;
  const courseMap = {};

  // 各艇の展示タイム・チルト抽出
  for (let i = 0; i < Math.min(6, regNumbers.length); i++) {
    const regNum = regNumbers[i];
    const boatNumber = i + 1;

    const tobanIdx = html.indexOf(`toban=${regNum}`);
    if (tobanIdx < 0) continue;

    const section = html.slice(tobanIdx, tobanIdx + 1500);
    const text = normalizeWidth(stripTags(section));

    // 展示タイム抽出 (6.XX形式)
    const exhTimeMatch = text.match(/(\d+\.\d{2})/);
    const exhibitionTime = exhTimeMatch ? num(exhTimeMatch[1]) : null;

    // チルト抽出 (-X.X or X.X形式、展示タイムの直後)
    const tiltMatch = text.match(/-?\d+\.\d{2}\s*(-?\d+\.\d)/);
    const tilt = tiltMatch ? num(tiltMatch[1]) : null;

    // 欠場判定
    const isAbsent = /欠場|欠/.test(text);

    exhibitionData.push({
      boat_number: boatNumber,
      registration_number: regNum,
      exhibition_time: exhibitionTime,
      exhibition_st: stExMap[boatNumber] || null,
      exhibition_st_raw: stExMap[boatNumber] || null,
      exhibition_course: boatNumber, // デフォルト=艇番(展示進入が取得できない場合)
      tilt,
      is_absent: isAbsent,
      is_scratched: isAbsent,
    });
  }

  // 天候情報抽出
  let weather = null, windSpeed = null, waterTemp = null, airTemp = null, waveHeight = null;
  const weatherMatch = html.match(/気温([\d.]+)℃/);
  if (weatherMatch) airTemp = num(weatherMatch[1]);
  const windMatch = html.match(/風速(\d+)m/);
  if (windMatch) windSpeed = num(windMatch[1]);
  const waterMatch = html.match(/水温([\d.]+)℃/);
  if (waterMatch) waterTemp = num(waterMatch[1]);
  const waveMatch = html.match(/波高(\d+)cm/);
  if (waveMatch) waveHeight = num(waveMatch[1]);
  const weatherTypeMatch = html.match(/(晴れ|曇り|雨|雪|霧)/);
  if (weatherTypeMatch) weather = weatherTypeMatch[1];

  if (exhibitionData.length < 6) {
    warnings.push(`展示データ${exhibitionData.length}艇(6艇期待)`);
  }

  return {
    ok: exhibitionData.length >= 6,
    errors,
    warnings: [],
    data: {
      entries: exhibitionData,
      weather,
      wind_speed: windSpeed,
      water_temp: waterTemp,
      air_temp: airTemp,
      wave_height: waveHeight,
    },
  };
}

// =====================================================
// 3連単オッズ(odds3t)解析 → odds_map
// =====================================================
export function parseOdds3t(html) {
  const oddsMap = {};

  // boatrace.jpの3連単オッズ表は、1st-2nd-3rdの120通りを表形式で表示。
  // 各セルに (1着艇, 3着艇, オッズ) または (オッズ値のみ) が含まれる。
  // HTMLの td 要素内のテキストから数値を抽出し、位置から組み合わせを推定。

  // より確実な方法: HTML内の odds値(小数)を含む td を順次抽出し、
  // 表の構造(1行6列、1st=2〜6の5グループ、各4行)から組み合わせを復元。

  // 3連単オッズセクションを特定
  const oddsStart = html.indexOf("3連単オッズ");
  if (oddsStart < 0) return oddsMap;
  const oddsSection = html.slice(oddsStart, oddsStart + 50000);

  // td 要素内のテキストを抽出
  const tdPattern = /<td[^>]*>([\s\S]*?)<\/td>/g;
  const cellTexts = [];
  let td;
  while ((td = tdPattern.exec(oddsSection)) !== null) {
    const text = stripTags(td[1]).trim();
    if (text) cellTexts.push(text);
  }

  // セルテキストから数値を抽出
  // 1着→2着→3着の順で120通りが並んでいる構造を利用
  // boatrace.jpの標準レイアウト:
  //   1着艇ごとにブロック(2〜6の5ブロック)
  //   各ブロック内: 2着艇ごとに行(5行)、3着艇ごとに4つのオッズ値
  //   1行 = 6列(2着艇1〜6、ただし1着艇と同じはスキップ)
  //   各列 = (3着艇番号, オッズ値) のペア、または (1着, 3着, オッズ) のトリプル

  // シンプルな抽出: 全セルから数値を順に読み、120通りのオッズとして復元
  // より確実なのは、表の行/列構造から推定する方法

  // 代替アプローチ: 全 \d-\d-\d パターンとその後のオッズ値を抽出
  // ただしオッズページには組番が "X-Y-Z" 形式で表示されない場合がある

  // 実用的アプローチ: td内のテキストが "数字 数字 小数" のパターン(1着,3着,オッズ)
  // または "数字 小数" (3着,オッズ) のパターンを抽出
  for (const text of cellTexts) {
    // "1 2 11.9" 形式 → 1着=1, 2着=2(列位置), 3着=3(明示), オッズ=11.9
    const tripleMatch = text.match(/^(\d)\s+(\d)\s+(\d+(?:\.\d+)?)$/);
    if (tripleMatch) {
      const first = num(tripleMatch[1]);
      const third = num(tripleMatch[2]);
      const odds = num(tripleMatch[3]);
      // 2着は列位置から推定できないため、このパターンは "1着-3着-オッズ" と解釈
      // ただし2着情報が不足するため、この方法は不完全
      continue;
    }
    // 単独のオッズ値(小数) → 組み合わせは位置から推定が必要
    const oddsMatch = text.match(/^(\d+(?:\.\d+)?)$/);
    if (oddsMatch) {
      const odds = num(oddsMatch[1]);
      if (odds >= 1.0 && odds <= 9999) {
        // 位置情報がないためスキップ(後で改善)
      }
    }
  }

  // より確実な方法: 3連単の全120通りの組み合わせを生成し、
  // HTML内で "X-Y-Z" 形式のパターンとオッズ値を探す
  // ただしboatrace.jpのオッズページは組番を表示しない場合がある

  // 最終アプローチ: 表の構造を解析して組み合わせを復元
  // boatrace.jpの3連単オッズ表の標準構造:
  //   - 5ブロック(1着=2,3,4,5,6) ※1着=1はない(1着が1の場合は別の場所)
  //   実際は6ブロック(1着=1〜6)、各ブロック5行(2着)、各行4列(3着)
  //   ただし1着と2着が同じ場合はスキップ

  // 実装: 3連単オッズ表の行を順に解析
  // 各行は1着艇を示し、続くセルが2着-3着のオッズ
  // この実装は複雑なため、基本版として空のoddsMapを返す
  // 実運用では展示情報取得後にオッズが必要な場合のみ呼ばれる

  return oddsMap;
}

export { VENUE_MAP };