// ============================================================
// BOATCAST欠場検知モジュール
// STR3(選手情報)とSTT(スタート展示)から欠場を検知する。
// 既存BOATCAST取得基盤(boatcastClient)を使用。新規スクレイピングなし。
//
// 検知方法:
//   STR3: 出身地フィールドに「欠場」表示、または成績フィールドが空
//   STT:  進入コースが「－」(ダッシュ)、ST値が空
//   TKZ:  展示タイム・体重・チルトが全て空
//
// 優先順位: STT(展示後) > STR3(出走表確定後)
// 締切前はSTTが最も確実。展示前はSTR3で検知可能。
// ============================================================

import { fetchBoatcastText } from './boatcastClient.js';

// ============================================================
// STR3パース: 選手基本情報から欠場検知
// STR3フォーマット:
//   data=
//   1\t6                          ← ヘッダ(枠数\t選手数)
//   4508\t野間　　大樹\t102期\t大　阪:大　阪\t37\tA2\t...
//   4104\t木下　　陽介\t88期\t欠　場:\t\tB1\t...  ← 欠場
//
// 欠場判定: 出身地フィールド(4番目)に「欠」または「欠場」が含まれる
// ============================================================
function detectScratchesFromStr3(str3Text) {
  if (!str3Text) return { scratchedBoats: [], source: 'STR3', reliable: false };

  const lines = str3Text.split('\n').map(l => l.trim()).filter(Boolean);
  const scratchedBoats = [];

  // ヘッダ行をスキップ(data= と 枠数\t選手数)
  let boatNumber = 1;
  for (const line of lines) {
    if (line === 'data=' || /^\d+\t\d+$/.test(line)) continue;

    const fields = line.split('\t');
    if (fields.length < 5) continue;

    // STR3フォーマット: 登録番号\t名前\t期\t出身地\t年齢\t級別...
    // 欠場の場合、出身地フィールドに「欠場」または「欠　場」が入る
    const birthplaceField = fields[3] || '';

    // 「欠」を含む場合は欠場
    if (birthplaceField.includes('欠')) {
      scratchedBoats.push(boatNumber);
    }

    boatNumber++;
    if (boatNumber > 6) break;
  }

  return {
    scratchedBoats,
    source: 'STR3',
    reliable: scratchedBoats.length > 0,
  };
}

// ============================================================
// STTパース: スタート展示から欠場検知
// STTフォーマット:
//   data=
//   1
//   1\t1\t野間　　大樹\t.21\t.05\t\t3.5      ← 正常
//   －\t2\t木下　　陽介\t\t\t                ← 欠場(進入=「－」, ST空)
//
// 欠場判定: 進入コース(1番目フィールド)が「－」または数字以外
// ============================================================
function detectScratchesFromStt(sttText) {
  if (!sttText) return { scratchedBoats: [], source: 'STT', reliable: false };

  // trimしない(末尾のタブが削除されフィールド数が減るのを防ぐ)
  const lines = sttText.split('\n').filter(l => l.length > 0);
  const scratchedBoats = [];

  // ヘッダスキップ(data= と 1)
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === 'data=' || trimmed === '1') continue;

    const fields = line.split('\t');
    if (fields.length < 2) continue;

    const courseField = (fields[0] || '').trim();
    const boatNum = parseInt((fields[1] || '').trim(), 10);

    // 進入コースが「－」または数字でない → 欠場
    if (boatNum >= 1 && boatNum <= 6) {
      if (courseField === '－' || courseField === '-' || courseField === '' || courseField === '—' || isNaN(Number(courseField))) {
        scratchedBoats.push(boatNum);
      }
    }
  }

  return {
    scratchedBoats,
    source: 'STT',
    reliable: true, // STTは展示後なので最も確実
  };
}

// ============================================================
// TKZパース: 展示タイムから欠場検知(補助)
// TKZフォーマット:
//   data=
//   1
//   野間　　大樹\t6.79\t0\t000\t52.0\t1\t- 0.5\t...
//   木下　　陽介\t\t\t\t\t\t...              ← 欠場(全フィールド空)
//
// 欠場判定: 展示タイム(2番目)が空
// ============================================================
function detectScratchesFromTkz(tkzText) {
  if (!tkzText) return { scratchedBoats: [], source: 'TKZ', reliable: false };

  // trimしない(末尾のタブが削除されフィールド数が減るのを防ぐ)
  const lines = tkzText.split('\n').filter(l => l.length > 0);
  const scratchedBoats = [];

  let boatNumber = 1;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === 'data=' || trimmed === '1') continue;
    // 最後の行はST一覧(数字.数字形式)をスキップ
    if (/^\d+\.\d+/.test(trimmed)) continue;
    // 選手名のみの行(展示データなし)はスキップしない

    const fields = line.split('\t');
    if (fields.length < 1) continue;

    // 展示タイム(2番目フィールド)が空 → 欠場
    const exhibitionTime = (fields[1] || '').trim();
    if (exhibitionTime === '' || isNaN(Number(exhibitionTime))) {
      scratchedBoats.push(boatNumber);
    }

    boatNumber++;
    if (boatNumber > 6) break;
  }

  return {
    scratchedBoats,
    source: 'TKZ',
    reliable: scratchedBoats.length > 0,
  };
}

// ============================================================
// メイン: BOATCASTから欠場検知
// 複数ソースを統合し、最も確実な結果を返す。
//
// 優先順位:
//   1. STT(展示後) - 進入コース「－」で確実検知
//   2. TKZ(展示後) - 展示タイム空で検知
//   3. STR3(出走表) - 「欠場」表示で検知
//
// 複数ソースで一致すれば信頼度MAX
// ============================================================
export async function detectScratchedBoats(venueCode, raceDate, raceNumber) {
  const results = {
    scratched_boats: [],
    sources: {},
    reliable: false,
    detected_at: new Date().toISOString(),
  };

  // 並行取得
  const [str3Res, sttRes, tkzRes] = await Promise.all([
    fetchBoatcastText({ venueCode, raceDate, raceNumber, dataType: 'STR3' }).catch(() => null),
    fetchBoatcastText({ venueCode, raceDate, raceNumber, dataType: 'STT' }).catch(() => null),
    fetchBoatcastText({ venueCode, raceDate, raceNumber, dataType: 'TKZ' }).catch(() => null),
  ]);

  const detections = [];

  if (str3Res?.ok) {
    const str3Result = detectScratchesFromStr3(str3Res.text);
    results.sources.STR3 = str3Result.scratchedBoats;
    if (str3Result.scratchedBoats.length > 0) detections.push(str3Result);
  }

  if (sttRes?.ok) {
    const sttResult = detectScratchesFromStt(sttRes.text);
    results.sources.STT = sttResult.scratchedBoats;
    if (sttResult.scratchedBoats.length > 0) detections.push(sttResult);
  }

  if (tkzRes?.ok) {
    const tkzResult = detectScratchesFromTkz(tkzRes.text);
    results.sources.TKZ = tkzResult.scratchedBoats;
    if (tkzResult.scratchedBoats.length > 0) detections.push(tkzResult);
  }

  // 複数ソースの統合: いずれかのソースで欠場判定された艇を統合
  const scratchSet = new Set();
  for (const d of detections) {
    for (const boat of d.scratchedBoats) {
      scratchSet.add(boat);
    }
  }

  // STTが取得できている場合(展示後): STTの結果を最優先
  if (results.sources.STT !== undefined) {
    results.scratched_boats = [...new Set(results.sources.STT)].sort((a, b) => a - b);
    results.reliable = true;
  } else if (results.sources.TKZ !== undefined) {
    // TKZが取得できている場合(展示後): TKZの結果を使用
    results.scratched_boats = [...new Set(results.sources.TKZ)].sort((a, b) => a - b);
    results.reliable = true;
  } else if (detections.length > 0) {
    // STR3のみ: 検知された艇を使用
    results.scratched_boats = [...scratchSet].sort((a, b) => a - b);
    results.reliable = detections.some(d => d.reliable);
  } else {
    // 全ソース取得済みだが欠場なし
    const allFetched = str3Res?.ok || sttRes?.ok || tkzRes?.ok;
    if (allFetched) {
      results.scratched_boats = [];
      results.reliable = true;
    }
  }

  return results;
}

// ============================================================
// 欠場艇を予想計算対象から除外するヘルパー
// 各予想エンジンで使用: is_scratched || is_absent || Race.scratched_boatsに含まれる
// ============================================================
export function isBoatScratched(entry, race) {
  if (entry?.is_scratched) return true;
  if (entry?.is_absent) return true;
  const scratchedBoats = race?.scratched_boats || [];
  if (Array.isArray(scratchedBoats) && scratchedBoats.includes(entry?.boat_number)) {
    return true;
  }
  return false;
}

// エントリーリストから欠場艇を除外
export function filterActiveEntries(entries, race) {
  return (entries || []).filter(e => !isBoatScratched(e, race) && e.boat_number);
}