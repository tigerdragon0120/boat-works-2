// ============================================================
// 展示データマージャー
// BOATCAST展示データ + LOCAL展示データを統合
// 優先順位: 1. BOATCAST  2. LOCAL  3. 欠損
//
// 各フィールドのsourceを追跡:
//   exhibition_time_source: "BOATCAST" | "LOCAL" | null
//   exhibition_st_source: "BOATCAST" | "LOCAL" | null
//   exhibition_course_source: "BOATCAST" | "LOCAL" | null
//   exhibition_st_rank_source: "BOATCAST" | "CALCULATED" | null
//   tilt_source: "BOATCAST" | "LOCAL" | null
//   weight_source: "BOATCAST" | null
// ============================================================

function parseTilt(tilt) {
  if (tilt == null) return null;
  if (typeof tilt === 'number') return tilt;
  const s = String(tilt).replace(/\s+/g, '').replace('+', '');
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
}

function pickWithSource(bcVal, localVal, bcSource = 'BOATCAST', localSource = 'LOCAL') {
  if (bcVal != null) return { value: bcVal, source: bcSource };
  if (localVal != null) return { value: localVal, source: localSource };
  return { value: null, source: null };
}

// ============================================================
// メイン: BOATCAST展示 + LOCAL展示をマージ
//
// boatcastExhibition: normalizeExhibitionData()の出力 (or null)
// localEntries: RaceEntryの配列
// race: Raceレコード(venue_code, race_date, race_number用)
//
// 戻り値:
// {
//   entries: [...merged entries with _exhibition_sources],
//   exhibition_status: "WAITING" | "PARTIAL" | "READY",
//   active_count, ready_count,
//   boatcast_available: bool,
//   boatcast_fetched_at: string | null,
// }
// ============================================================
export function mergeExhibition(boatcastExhibition, localEntries, race) {
  const bcRacers = boatcastExhibition?.racers || [];
  const result = [];

  for (const localEntry of localEntries) {
    const boatNumber = Number(localEntry.boat_number);
    const bcRacer = bcRacers.find(r => r.lane === boatNumber);

    // 欠場チェック(LOCAL優先・BOATCASTでも確認)
    const isAbsent = !!(localEntry.is_absent || localEntry.is_scratched);

    const merged = {
      ...localEntry,
      is_absent: isAbsent,
      _exhibition_sources: {},
    };

    // exhibition_time
    const et = pickWithSource(bcRacer?.exhibition_time, localEntry.exhibition_time);
    merged.exhibition_time = et.value;
    merged._exhibition_sources.exhibition_time = et.source;

    // exhibition_st (スタート展示ST = stt.st)
    const est = pickWithSource(bcRacer?.st, localEntry.exhibition_st);
    merged.exhibition_st = est.value;
    merged._exhibition_sources.exhibition_st = est.source;

    // exhibition_course (実進入コース = stt.course)
    const ec = pickWithSource(bcRacer?.exhibition_course, localEntry.exhibition_course);
    merged.exhibition_course = ec.value;
    merged._exhibition_sources.exhibition_course = ec.source;

    // exhibition_st_rank (展示ST順)
    // BOATCASTに完成済みST順がないためCALCULATEDが基本
    if (bcRacer?.exhibition_start_rank != null) {
      merged.exhibition_st_rank = bcRacer.exhibition_start_rank;
      merged._exhibition_sources.exhibition_st_rank = bcRacer.exhibition_start_rank_source || 'BOATCAST';
    } else {
      merged.exhibition_st_rank = null;
      merged._exhibition_sources.exhibition_st_rank = null;
    }

    // tilt (補助特徴量)
    const bcTilt = parseTilt(bcRacer?.tilt);
    const tilt = pickWithSource(bcTilt, localEntry.tilt);
    merged.tilt = tilt.value;
    merged._exhibition_sources.tilt = tilt.source;

    // weight (BOATCASTのみ・補助特徴量)
    if (bcRacer?.weight != null) {
      merged.weight = bcRacer.weight;
      merged._exhibition_sources.weight = 'BOATCAST';
    } else {
      merged.weight = null;
      merged._exhibition_sources.weight = null;
    }

    // adjustment_weight (調整体重・BOATCASTに不存在)
    merged.adjustment_weight = null;
    merged._exhibition_sources.adjustment_weight = null;

    result.push(merged);
  }

  // exhibition_rank計算 (展示タイム順位・レース内相対比較)
  const validTimes = result
    .filter(e => !e.is_absent && e.exhibition_time != null)
    .sort((a, b) => a.exhibition_time - b.exhibition_time);
  for (let i = 0; i < validTimes.length; i++) {
    validTimes[i].exhibition_rank = i + 1;
  }
  // 欠場艇や展示タイム欠損艇はrank未設定

  // exhibition_st_rank計算 (CALCULATED)
  // BOATCASTにST順がない場合、展示STから計算
  // F flag付きは除外
  const needCalc = result.some(e =>
    !e.is_absent && e.exhibition_st != null && e.exhibition_st_rank == null
  );
  if (needCalc) {
    const validSts = result
      .filter(e => !e.is_absent && e.exhibition_st != null)
      .sort((a, b) => a.exhibition_st - b.exhibition_st);
    for (let i = 0; i < validSts.length; i++) {
      const entry = validSts[i];
      if (entry.exhibition_st_rank == null) {
        entry.exhibition_st_rank = i + 1;
        entry._exhibition_sources.exhibition_st_rank = 'CALCULATED';
      }
    }
  }

  // READY判定
  // 必須: exhibition_time + exhibition_st + exhibition_course (有効艇すべて)
  // 体重・チルトは補助情報なので欠損してもREADY
  const activeBoats = result.filter(e => !e.is_absent);
  const readyCount = activeBoats.filter(e =>
    e.exhibition_time != null && e.exhibition_st != null && e.exhibition_course != null
  ).length;

  let exhibitionStatus = 'WAITING';
  if (activeBoats.length > 0 && readyCount === activeBoats.length) {
    exhibitionStatus = 'READY';
  } else if (readyCount > 0) {
    exhibitionStatus = 'PARTIAL';
  }

  return {
    entries: result,
    exhibition_status: exhibitionStatus,
    active_count: activeBoats.length,
    ready_count: readyCount,
    boatcast_available: bcRacers.length > 0,
    boatcast_fetched_at: boatcastExhibition?.fetched_at || null,
  };
}