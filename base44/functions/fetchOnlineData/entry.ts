import { createClientFromRequest } from 'npm:@base44/sdk@0.8.44';
import { upsertResultAndVerify, getSettings, runAndSavePrediction } from '../../shared/predictionService.js';
import { buildRaceKey } from '../../shared/raceKey.js';

const num = (v: any) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const str = (v: any) => (v != null ? String(v).trim() : '');

// === boatrace.jp URLビルダー ===
function buildUrl(fetchType: string, raceDate: string, venueCode: string, raceNumber: number): string {
  const hd = raceDate.replace(/-/g, '');
  const rjcd = venueCode.padStart(2, '0');
  const rno = raceNumber;
  switch (fetchType) {
    case 'exhibition':
      return `https://boatrace.jp/owpc/pc/race/exhibition?rjcd=${rjcd}&hd=${hd}&rno=${rno}`;
    case 'odds':
      return `https://boatrace.jp/owpc/pc/odds/3t?rjcd=${rjcd}&hd=${hd}&rno=${rno}`;
    case 'result':
      return `https://boatrace.jp/owpc/pc/race/result?rjcd=${rjcd}&hd=${hd}&rno=${rno}`;
    default:
      return '';
  }
}

// === InvokeLLM用スキーマ ===
function getLlmSchema(fetchType: string): object {
  switch (fetchType) {
    case 'exhibition':
      return {
        type: 'object',
        properties: {
          entries: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                boat_number: { type: 'number' },
                exhibition_time: { type: 'number' },
                exhibition_st: { type: 'number' },
                exhibition_course: { type: 'number' },
                tilt: { type: 'number' },
                is_absent: { type: 'boolean' },
                is_flying: { type: 'boolean' },
              },
            },
          },
        },
      };
    case 'odds':
      return {
        type: 'object',
        properties: {
          odds_list: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                combination: { type: 'string', description: '3連単組み合わせ 例 1-2-3' },
                odds: { type: 'number' },
              },
            },
          },
        },
      };
    case 'result':
      return {
        type: 'object',
        properties: {
          result_trifecta: { type: 'string', description: '3連単結果 例 1-3-5' },
          finish_order: { type: 'array', items: { type: 'number' } },
          payout: { type: 'number' },
          entries: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                boat_number: { type: 'number' },
                course: { type: 'number' },
                st: { type: 'number' },
                winning_method: { type: 'string' },
              },
            },
          },
        },
      };
    default:
      return { type: 'object', properties: {} };
  }
}

function getLlmPrompt(fetchType: string): string {
  const typeLabel = { exhibition: '展示', odds: '3連単オッズ', result: 'レース結果' }[fetchType] || '';
  return `以下のHTMLは競艇の${typeLabel}ページです。このHTMLから${typeLabel}データを抽出し、指定されたJSONスキーマに従って構造化データを返してください。数値は適切に数値型に変換してください。不明な値はnullにしてください。`;
}

// === エラー繰り返し防止: 直近5分以内の同レース同fetch_typeの失敗をスキップ ===
async function shouldSkipRecentFailure(base44: any, fetchType: string, raceDate: string, venueCode: string, raceNumber: number): Promise<boolean> {
  const sr = base44.asServiceRole.entities;
  try {
    const logs = await sr.OnlineFetchLog.filter(
      { fetch_type: fetchType, race_date: raceDate, venue_code: venueCode, race_number: raceNumber },
      '-fetched_at', 3
    );
    if (!logs || !logs.length) return false;
    const last = logs[0];
    if (last.status === 'failed' || last.status === 'no_data') {
      const fetchedAt = new Date(last.fetched_at).getTime();
      const fiveMinAgo = Date.now() - 5 * 60 * 1000;
      if (fetchedAt > fiveMinAgo) return true;
    }
    return false;
  } catch { return false; }
}

// === 展示データ処理 ===
async function processExhibition(base44: any, race: any, entries: any[], parsed: any) {
  const sr = base44.asServiceRole.entities;
  const parsedEntries = parsed.entries || [];
  for (const pe of parsedEntries) {
    const bn = num(pe.boat_number);
    if (!bn) continue;
    const existing = await sr.RaceEntry.filter({ race_id: race.id, boat_number: bn }, 'boat_number', 1);
    if (!existing || !existing[0]) continue;
    const update: any = {
      exhibition_time: num(pe.exhibition_time),
      exhibition_st: num(pe.exhibition_st),
      exhibition_course: num(pe.exhibition_course) || bn,
      tilt: num(pe.tilt),
      is_absent: !!pe.is_absent,
      is_scratched: !!pe.is_absent,
    };
    if (pe.is_flying && num(pe.exhibition_st) != null) {
      update.exhibition_st_raw = -Math.abs(num(pe.exhibition_st));
    } else {
      update.exhibition_st_raw = num(pe.exhibition_st);
    }
    await sr.RaceEntry.update(existing[0].id, update);
  }
  // Race展示取得済フラグ
  await sr.Race.update(race.id, { exhibition_ready: true });
  // FINAL予想生成
  if (entries.length >= 6) {
    try {
      const settings = await getSettings(base44);
      const profiles = await sr.RacerPerformanceProfile.filter({}, '-updated_at', 5000).catch(() => []);
      const profileByReg = new Map(profiles.map((p: any) => [p.registration_number, p]));
      const updatedEntries = await sr.RaceEntry.filter({ race_id: race.id }, 'boat_number', 6);
      await runAndSavePrediction(base44, race, updatedEntries, settings, 'FINAL', {}, profileByReg);
    } catch {}
  }
}

// === オッズデータ処理 ===
async function processOdds(base44: any, race: any, parsed: any) {
  const sr = base44.asServiceRole.entities;
  const oddsList = parsed.odds_list || [];
  const oddsMap: any = {};
  for (const o of oddsList) {
    const comb = str(o.combination);
    if (comb) oddsMap[comb] = num(o.odds);
  }
  // OddsSnapshot保存(時系列履歴)
  await sr.OddsSnapshot.create({
    race_id: race.id, stage: 'FINAL', odds_map: oddsMap,
    captured_at: new Date().toISOString(),
  });
  // TrifectaPredictionのactual_odds更新
  const preds = await sr.RacePrediction.filter({ race_id: race.id, stage: 'FINAL' }, '-computed_at', 1);
  if (preds && preds[0]) {
    const trifectas = await sr.TrifectaPrediction.filter({ prediction_id: preds[0].id }, 'rank', 120);
    for (const t of trifectas) {
      const actualOdds = oddsMap[t.combination] || null;
      const ev = actualOdds ? Math.round(t.probability * actualOdds * 10) / 10 : null;
      await sr.TrifectaPrediction.update(t.id, { actual_odds: actualOdds, expected_value: ev });
    }
  }
  return { odds_count: Object.keys(oddsMap).length };
}

// === レース結果処理 ===
async function processResult(base44: any, race: any, parsed: any) {
  const resultTrifecta = str(parsed.result_trifecta);
  const finishOrder = parsed.finish_order || (resultTrifecta ? resultTrifecta.split('-').map(Number) : []);
  const payout = num(parsed.payout) || 0;
  if (!resultTrifecta) throw new Error('結果データが見つかりません');
  await upsertResultAndVerify(base44, race, {
    result_trifecta: resultTrifecta,
    finish_order: finishOrder,
    payout,
  });
  // RacerRaceHistory蓄積
  const sr = base44.asServiceRole.entities;
  const entries = parsed.entries || [];
  const raceEntries = await sr.RaceEntry.filter({ race_id: race.id }, 'boat_number', 6).catch(() => []);
  for (const pe of entries) {
    const bn = num(pe.boat_number);
    if (!bn) continue;
    const re = raceEntries.find((e: any) => e.boat_number === bn);
    const reg = re ? str(re.registration_number || re.register_number) : '';
    if (!reg) continue;
    const histKey = { registration_number: reg, race_date: race.race_date, venue_code: race.venue_code, race_number: race.race_number };
    const existingHist = await sr.RacerRaceHistory.filter(histKey, '-created_date', 1).catch(() => []);
    const histDoc = {
      registration_number: reg,
      race_date: race.race_date,
      venue_code: race.venue_code,
      race_number: race.race_number,
      boat_number: bn,
      course: num(pe.course) || undefined,
      finish_order: finishOrder.indexOf(bn) + 1 || undefined,
      st: num(pe.st) || undefined,
      winning_method: str(pe.winning_method) || undefined,
    };
    if (existingHist && existingHist[0]) {
      await sr.RacerRaceHistory.update(existingHist[0].id, histDoc);
    } else {
      await sr.RacerRaceHistory.create(histDoc);
    }
  }
  return { result_trifecta: resultTrifecta, payout };
}

export default async function(req: Request) {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });
    if (user.role !== 'admin') return Response.json({ error: 'Forbidden: admin only' }, { status: 403 });

    const body = await req.json();
    const { fetch_type, race_date, venue_code, race_number, race_id } = body;
    if (!fetch_type || !race_date || !venue_code || !race_number) {
      return Response.json({ error: 'fetch_type, race_date, venue_code, race_number are required' }, { status: 400 });
    }

    const sr = base44.asServiceRole.entities;
    const now = new Date().toISOString();

    // エラー繰り返し防止
    const skip = await shouldSkipRecentFailure(base44, fetch_type, race_date, str(venue_code), num(race_number));
    if (skip) {
      await sr.OnlineFetchLog.create({
        fetch_type, race_date, venue_code: str(venue_code), race_number: num(race_number),
        status: 'skipped', fetched_at: now, error_message: '直近5分以内に失敗のためスキップ',
      });
      return Response.json({ ok: false, status: 'skipped', message: '直近5分以内に失敗のためスキップしました' });
    }

    // Race検索
    const raceKey = buildRaceKey(race_date, str(venue_code), num(race_number));
    let race = null;
    if (race_id) {
      race = await sr.Race.get(race_id).catch(() => null);
    }
    if (!race) {
      const races = await sr.Race.filter({ race_key: raceKey }, '-updated_date', 1);
      race = races && races[0] ? races[0] : null;
    }
    if (!race) {
      await sr.OnlineFetchLog.create({
        fetch_type, race_date, venue_code: str(venue_code), race_number: num(race_number),
        status: 'failed', fetched_at: now, error_message: '対象Raceが見つかりません',
      });
      return Response.json({ ok: false, status: 'failed', message: '対象Raceが見つかりません' });
    }

    // HTML取得
    const url = buildUrl(fetch_type, race_date, str(venue_code), num(race_number));
    let httpStatus = 0;
    let html = '';
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 30000);
      let res: Response;
      try {
        res = await fetch(url, { signal: controller.signal });
      } finally { clearTimeout(timer); }
      httpStatus = res.status;
      html = await res.text();
      if (res.status !== 200 || !html) {
        await sr.OnlineFetchLog.create({
          fetch_type, race_id: race.id, race_date, venue_code: str(venue_code), race_number: num(race_number),
          status: 'no_data', fetched_at: now, http_status: httpStatus, error_message: `HTTP ${res.status}`,
        });
        return Response.json({ ok: false, status: 'no_data', message: `HTTP ${res.status} - データが未公開の可能性` });
      }
    } catch (e: any) {
      await sr.OnlineFetchLog.create({
        fetch_type, race_id: race.id, race_date, venue_code: str(venue_code), race_number: num(race_number),
        status: 'failed', fetched_at: now, error_message: e.message,
      });
      return Response.json({ ok: false, status: 'failed', message: e.message });
    }

    // HTMLを切り詰め(コスト削減)
    const truncatedHtml = html.slice(0, 80000);
    const prompt = `${getLlmPrompt(fetch_type)}\n\nHTML:\n${truncatedHtml}`;

    // InvokeLLMでHTML解析
    let parsed: any;
    try {
      const llmResult = await base44.asServiceRole.integrations.Core.InvokeLLM({
        prompt,
        response_json_schema: getLlmSchema(fetch_type),
        model: 'gpt_5_mini',
      });
      parsed = typeof llmResult === 'string' ? JSON.parse(llmResult) : llmResult;
    } catch (e: any) {
      await sr.OnlineFetchLog.create({
        fetch_type, race_id: race.id, race_date, venue_code: str(venue_code), race_number: num(race_number),
        status: 'failed', fetched_at: now, http_status: httpStatus, error_message: 'LLM解析失敗: ' + e.message,
      });
      return Response.json({ ok: false, status: 'failed', message: 'LLM解析失敗: ' + e.message });
    }

    // データ処理
    try {
      const entries = await sr.RaceEntry.filter({ race_id: race.id }, 'boat_number', 6).catch(() => []);
      let resultData: any = {};
      switch (fetch_type) {
        case 'exhibition':
          await processExhibition(base44, race, entries, parsed);
          resultData = { entries_updated: (parsed.entries || []).length };
          break;
        case 'odds':
          resultData = await processOdds(base44, race, parsed);
          break;
        case 'result':
          resultData = await processResult(base44, race, parsed);
          break;
      }

      await sr.OnlineFetchLog.create({
        fetch_type, race_id: race.id, race_date, venue_code: str(venue_code), race_number: num(race_number),
        status: 'success', fetched_at: now, http_status: httpStatus,
      });

      return Response.json({
        ok: true, status: 'success', fetch_type, race_id: race.id,
        ...resultData,
        message: `${fetch_type}データ取得完了`,
      });
    } catch (e: any) {
      await sr.OnlineFetchLog.create({
        fetch_type, race_id: race.id, race_date, venue_code: str(venue_code), race_number: num(race_number),
        status: 'failed', fetched_at: now, http_status: httpStatus, error_message: 'データ処理失敗: ' + e.message,
      });
      return Response.json({ ok: false, status: 'failed', message: 'データ処理失敗: ' + e.message });
    }
  } catch (error: any) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}