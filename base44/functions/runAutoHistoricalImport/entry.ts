import { createClientFromRequest } from 'npm:@base44/sdk@0.8.44';
import { secrets } from 'base44:runtime';
import { syncAndPredict } from '../../shared/predictionService.js';

function addDays(date, offset) {
  const d = new Date(`${date}T00:00:00+09:00`);
  d.setDate(d.getDate() + offset);
  return new Intl.DateTimeFormat('en-CA', { timeZone:'Asia/Tokyo', year:'numeric', month:'2-digit', day:'2-digit' }).format(d);
}
function monthsAgo(n) {
  const d = new Date(Date.now() + 9 * 3600000);
  d.setUTCMonth(d.getUTCMonth() - n);
  return d.toISOString().slice(0,10);
}
async function setStatus(sr, patch) {
  const rows = await sr.HistoricalImportStatus.filter({ name:'default' }, '-updated_date', 1).catch(()=>[]);
  const doc = { name:'default', ...patch };
  return rows?.[0] ? sr.HistoricalImportStatus.update(rows[0].id, doc) : sr.HistoricalImportStatus.create(doc);
}

export default async function(req) {
  const base44 = createClientFromRequest(req);
  const sr = base44.asServiceRole.entities;
  const now = new Date().toISOString();
  try {
    const body = await req.json().catch(()=>({}));
    const floor = body.from_date || monthsAgo(6);

    // BOAT WORKS 2で現在保持している最古日の1日前を次ターゲットにする。
    const oldest = (await sr.Race.filter({ race_date:{ $gte:floor } }, 'race_date', 1).catch(()=>[]))[0];
    const targetDate = body.date || (oldest?.race_date ? addDays(oldest.race_date, -1) : addDays(new Date().toISOString().slice(0,10), -1));
    if (targetDate < floor) {
      await setStatus(sr,{last_attempt_at:now,status:'success',next_target_date:targetDate,message:'6か月分の自動取込が完了しています'});
      return Response.json({status:'complete',target_date:targetDate,floor});
    }

    await setStatus(sr,{last_attempt_at:now,status:'running',next_target_date:targetDate,message:`${targetDate} を確認中`});

    const base = secrets.get('BOAT_WORKS_API_BASE');
    const key = secrets.get('BOAT_WORKS_API_KEY');
    if (!base || !key) throw new Error('BOAT_WORKS_API_BASE / BOAT_WORKS_API_KEY が未設定です');
    const normalized = String(base).replace(/\/$/,'');
    const endpoint = normalized.includes('exportBoatWorksData') ? normalized : `${normalized}/exportBoatWorksData`;
    // 指数バックオフ付きfetch(Rate limit回避)
    const fetchWithRetry = async (url, maxRetries = 3) => {
      let lastError = null;
      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), 60000);
          let res;
          try {
            res = await fetch(url, { headers: { Authorization: `Bearer ${key}` }, signal: controller.signal });
          } finally { clearTimeout(timer); }
          if (res.status === 429 || res.status >= 500) {
            lastError = new Error(`Rate limit exceeded (HTTP ${res.status})`);
            if (attempt < maxRetries) {
              const delay = Math.min(10000 * Math.pow(2, attempt), 120000);
              await new Promise(r => setTimeout(r, delay));
              continue;
            }
            const detail = await res.text().catch(() => '');
            throw new Error(`BOAT WORKS API ${res.status}: ${detail.slice(0, 300)}`);
          }
          if (!res.ok) {
            const detail = await res.text().catch(() => '');
            throw new Error(`BOAT WORKS API ${res.status}: ${detail.slice(0, 300)}`);
          }
          return await res.json();
        } catch (e) {
          lastError = e;
          if (e.name === 'AbortError' || /fetch|network|timeout|rate limit/i.test(e.message || '')) {
            if (attempt < maxRetries) {
              const delay = Math.min(10000 * Math.pow(2, attempt), 120000);
              await new Promise(r => setTimeout(r, delay));
              continue;
            }
          }
          throw e;
        }
      }
      throw lastError || new Error('fetch failed');
    };

    const manifest = await fetchWithRetry(`${endpoint}?date=${encodeURIComponent(targetDate)}&manifest=1`);
    const venueCodes = Array.isArray(manifest.venue_codes) ? manifest.venue_codes.map(v=>String(v).padStart(2,'0')) : [];
    const raceCount = Number(manifest.race_count || 0);
    if (!raceCount || !venueCodes.length) {
      await setStatus(sr,{last_attempt_at:now,status:'source_not_ready',next_target_date:targetDate,race_count:0,venue_count:0,message:`BOAT WORKS側の${targetDate}フルデータがまだ未生成です`});
      return Response.json({status:'source_not_ready',target_date:targetDate,race_count:0});
    }

    // 全場一括取得(1回のAPI呼び出し)でRate limit回避
    let importedRaces = 0, importedResults = 0, errors = [];
    try {
      const payload = await fetchWithRetry(`${endpoint}?date=${encodeURIComponent(targetDate)}`);
      const summary = await syncAndPredict(base44, payload, { mode: 'auto_backfill', skip_predictions: true, skip_verification: true });
      importedRaces = Number(summary?.races_upserted || 0);
      importedResults = Number(summary?.results_saved || 0);
      if (Array.isArray(summary?.errors) && summary.errors.length) errors.push(...summary.errors);
    } catch (e: any) {
      errors.push({ message: e?.message || String(e) });
    }

    // 集計DBも自動更新。内部呼び出しが失敗しても履歴取込自体は成功扱いにする。
    try { await base44.asServiceRole.functions.invoke('refreshDatabase',{}); } catch {}

    const ok = importedRaces > 0 && errors.length === 0;
    await setStatus(sr,{
      last_attempt_at:now,last_success_date: importedRaces>0 ? targetDate : undefined,
      next_target_date: importedRaces>0 ? addDays(targetDate,-1) : targetDate,
      status: ok ? 'success' : (importedRaces>0 ? 'success' : 'failed'),
      race_count:importedRaces,venue_count:venueCodes.length,
      message:`${targetDate}: ${importedRaces}レース / 結果${importedResults}件 取込${errors.length ? `（警告${errors.length}件）` : '完了'}`
    });
    return Response.json({status: importedRaces>0?'success':'failed',target_date:targetDate,venues:venueCodes.length,races:importedRaces,results:importedResults,errors:errors.slice(0,20)});
  } catch(error) {
    await setStatus(sr,{last_attempt_at:now,status:'failed',message:error?.message||String(error)}).catch(()=>{});
    return Response.json({status:'error',message:error?.message||String(error)},{status:500});
  }
}