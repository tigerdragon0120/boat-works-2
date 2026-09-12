import { createClientFromRequest } from 'npm:@base44/sdk@0.8.44';

// BOATCAST結果・払戻dataTypeプローブ
// 候補URLを複数試し、取得成功したものを報告する

const BOATCAST_HP_BASE = 'https://race.boatcast.jp/hp_txt';
const BOATCAST_TXT_BASE = 'https://race.boatcast.jp/txt';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';

const hd = '20260912';
const vc = '20';
const rn = '10';

// JSから発見したパターンを中心に試す
const discoveredResultCandidates = [
  { name: 'bc_rc1', base: 'hp' },
  { name: 'bc_rc1', base: 'txt' },
  { name: 'bc_j_rc1', base: 'hp' },
  { name: 'bc_kakutei_rc1', base: 'txt' },
  { name: 'bc_rs2', base: 'hp' },
  { name: 'bc_rs2', base: 'txt' },
  { name: 'bc_j_rs2', base: 'hp' },
  { name: 'bc_kakutei_rs2', base: 'txt' },
  { name: 'bc_vod', base: 'hp' },
  { name: 'bc_vod', base: 'txt' },
  { name: 'bc_kai', base: 'hp' },
  { name: 'bc_kai', base: 'txt' },
  { name: 'bc_dstime', base: 'hp' },
  { name: 'bc_dstime', base: 'txt' },
  // 結果系追加候補(txt base中心)
  { name: 'bc_rs1', base: 'txt' },
  { name: 'bc_j_rs1', base: 'txt' },
  { name: 'bc_kakutei_rs1', base: 'txt' },
  { name: 'bc_j_sk', base: 'txt' },
  { name: 'bc_kakutei_sk', base: 'txt' },
  { name: 'bc_j_st', base: 'txt' },
  { name: 'bc_kakutei_st', base: 'txt' },
  { name: 'bc_j_seisai', base: 'txt' },
  { name: 'bc_kakutei_seisai', base: 'txt' },
  { name: 'bc_j_1r', base: 'txt' },
  { name: 'bc_kakutei_1r', base: 'txt' },
  { name: 'bc_j_kt', base: 'txt' },
  { name: 'bc_kakutei_kt', base: 'txt' },
  { name: 'bc_j_cyaku', base: 'txt' },
  { name: 'bc_kakutei_cyaku', base: 'txt' },
  { name: 'bc_j_race', base: 'txt' },
  { name: 'bc_kakutei_race', base: 'txt' },
  { name: 'bc_j_all', base: 'txt' },
  { name: 'bc_kakutei_all', base: 'txt' },
  { name: 'bc_j_info', base: 'txt' },
  { name: 'bc_kakutei_info', base: 'txt' },
];

// 候補dataType名(結果系)
const resultCandidates = [
  { name: 'bc_j_rs1', base: 'hp' },
  { name: 'bc_kakutei_rs1', base: 'txt' },
  { name: 'bc_j_rs2', base: 'hp' },
  { name: 'bc_kakutei_rs2', base: 'txt' },
  { name: 'bc_j_rs1_2', base: 'hp' },
  { name: 'bc_kakutei_rs1_2', base: 'txt' },
  { name: 'bc_j_result', base: 'hp' },
  { name: 'bc_kakutei_result', base: 'txt' },
  { name: 'bc_j_raceresult', base: 'hp' },
  { name: 'bc_kakutei_raceresult', base: 'txt' },
  { name: 'bc_j_kekka', base: 'hp' },
  { name: 'bc_kakutei_kekka', base: 'txt' },
  { name: 'bc_j_kkk', base: 'hp' },
  { name: 'bc_kakutei_kkk', base: 'txt' },
  { name: 'bc_j_k', base: 'hp' },
  { name: 'bc_kakutei_k', base: 'txt' },
  { name: 'bc_j_rst', base: 'hp' },
  { name: 'bc_kakutei_rst', base: 'txt' },
  { name: 'bc_j_finish', base: 'hp' },
  { name: 'bc_kakutei_finish', base: 'txt' },
  { name: 'bc_j_arrive', base: 'hp' },
  { name: 'bc_kakutei_arrive', base: 'txt' },
  { name: 'bc_j_chakujun', base: 'hp' },
  { name: 'bc_kakutei_chakujun', base: 'txt' },
  { name: 'bc_j_chaku', base: 'hp' },
  { name: 'bc_kakutei_chaku', base: 'txt' },
  { name: 'bc_j_race', base: 'hp' },
  { name: 'bc_kakutei_race', base: 'txt' },
  { name: 'bc_j_r', base: 'hp' },
  { name: 'bc_kakutei_r', base: 'txt' },
  { name: 'bc_j_syusso', base: 'hp' },
  { name: 'bc_kakutei_syusso', base: 'txt' },
  { name: 'bc_j_1r', base: 'hp' },
  { name: 'bc_kakutei_1r', base: 'txt' },
  { name: 'bc_j_sekkei', base: 'hp' },
  { name: 'bc_kakutei_sekkei', base: 'txt' },
  { name: 'bc_j_skt', base: 'hp' },
  { name: 'bc_kakutei_skt', base: 'txt' },
  { name: 'bc_j_hr', base: 'hp' },
  { name: 'bc_kakutei_hr', base: 'txt' },
  { name: 'bc_j_kc', base: 'hp' },
  { name: 'bc_kakutei_kc', base: 'txt' },
];

// 候補dataType名(払戻系)
const payoutCandidates = [
  { name: 'bc_j_hairetu', base: 'hp' },
  { name: 'bc_kakutei_hairetu', base: 'txt' },
  { name: 'bc_j_haifu', base: 'hp' },
  { name: 'bc_kakutei_haifu', base: 'txt' },
  { name: 'bc_j_pay', base: 'hp' },
  { name: 'bc_kakutei_pay', base: 'txt' },
  { name: 'bc_j_payout', base: 'hp' },
  { name: 'bc_kakutei_payout', base: 'txt' },
  { name: 'bc_j_harai', base: 'hp' },
  { name: 'bc_kakutei_harai', base: 'txt' },
  { name: 'bc_j_3ren', base: 'hp' },
  { name: 'bc_kakutei_3ren', base: 'txt' },
  { name: 'bc_j_od3', base: 'hp' },
  { name: 'bc_kakutei_od3', base: 'txt' },
];

async function tryFetch(url: string) {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(8000),
    });
    if (res.status === 200) {
      const text = await res.text();
      return { ok: true, status: 200, text, length: text.length };
    }
    return { ok: false, status: res.status, text: null, length: 0 };
  } catch (e: any) {
    return { ok: false, status: null, error: e.message, text: null, length: 0 };
  }
}

export default async function(req: Request) {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me().catch(() => null);
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });
    if (user.role !== 'admin') return Response.json({ error: 'Forbidden' }, { status: 403 });

    const results: any[] = [];
    const payouts: any[] = [];

    // 発見パターン優先プローブ
    const discoveredResults: any[] = [];
    for (const c of discoveredResultCandidates) {
      const base = c.base === 'hp' ? BOATCAST_HP_BASE : BOATCAST_TXT_BASE;
      const url = `${base}/${vc}/${c.name}_${hd}_${vc}_${rn}.txt`;
      const r = await tryFetch(url);
      discoveredResults.push({
        candidate: c.name,
        base: c.base,
        url,
        ok: r.ok,
        status: r.status,
        length: r.length,
        error: r.error || null,
        preview: r.ok ? r.text.slice(0, 800) : null,
      });
      await new Promise((resolve) => setTimeout(resolve, 200));
    }

    // 結果系プローブ
    for (const c of resultCandidates) {
      const base = c.base === 'hp' ? BOATCAST_HP_BASE : BOATCAST_TXT_BASE;
      const url = `${base}/${vc}/${c.name}_${hd}_${vc}_${rn}.txt`;
      const r = await tryFetch(url);
      results.push({
        candidate: c.name,
        base: c.base,
        url,
        ok: r.ok,
        status: r.status,
        length: r.length,
        error: r.error || null,
        preview: r.ok ? r.text.slice(0, 500) : null,
      });
      // 連続リクエストを避ける
      await new Promise((resolve) => setTimeout(resolve, 200));
    }

    // 払戻系プローブ
    for (const c of payoutCandidates) {
      const base = c.base === 'hp' ? BOATCAST_HP_BASE : BOATCAST_TXT_BASE;
      const url = `${base}/${vc}/${c.name}_${hd}_${vc}_${rn}.txt`;
      const r = await tryFetch(url);
      payouts.push({
        candidate: c.name,
        base: c.base,
        url,
        ok: r.ok,
        status: r.status,
        length: r.length,
        error: r.error || null,
        preview: r.ok ? r.text.slice(0, 500) : null,
      });
      await new Promise((resolve) => setTimeout(resolve, 200));
    }

    // ディレクトリリスティング試行
    let dirListingHp = null, dirListingTxt = null;
    try {
      const r1 = await tryFetch(`${BOATCAST_HP_BASE}/${vc}/`);
      dirListingHp = { ok: r1.ok, status: r1.status, preview: r1.ok ? r1.text.slice(0, 2000) : null };
    } catch (e: any) { dirListingHp = { error: e.message }; }
    try {
      const r2 = await tryFetch(`${BOATCAST_TXT_BASE}/${vc}/`);
      dirListingTxt = { ok: r2.ok, status: r2.status, preview: r2.ok ? r2.text.slice(0, 2000) : null };
    } catch (e: any) { dirListingTxt = { error: e.message }; }

    // BOATCASTメインページHTMLからデータファイル参照を抽出
    let mainPage = null;
    let jsFiles: string[] = [];
    try {
      const r3 = await tryFetch('https://race.boatcast.jp/');
      if (r3.ok) {
        const html = r3.text || '';
        // bc_j_ または bc_kakutei_ パターンを抽出
        const patterns = [...html.matchAll(/bc_(?:j|kakutei)_[a-z0-9_]+/gi)];
        const uniquePatterns = [...new Set(patterns.map(m => m[0]))];
        // script src, link href を抽出
        const srcPatterns = [...html.matchAll(/(?:src|href)=["']([^"']+)["']/gi)];
        const srcs = srcPatterns.map(m => m[1]).filter(s => /\.js|\.css/i.test(s));
        mainPage = { ok: true, status: r3.status, length: html.length, data_patterns: uniquePatterns.slice(0, 50), html_preview: html.slice(0, 2000) };
        jsFiles = srcs;
      } else {
        mainPage = { ok: false, status: r3.status };
      }
    } catch (e: any) { mainPage = { error: e.message }; }

    // JSファイルからデータファイル参照を抽出
    let jsDataPatterns: string[] = [];
    let mainJsContent = null;
    let resultJsPatterns: string[] = [];
    for (const jsf of jsFiles.slice(0, 5)) {
      try {
        const fullUrl = jsf.startsWith('http') ? jsf : `https://race.boatcast.jp${jsf}`;
        const r = await tryFetch(fullUrl);
        if (r.ok) {
          const patterns = [...r.text.matchAll(/bc_(?:j|kakutei|smt)_[a-z0-9_]+/gi)];
          jsDataPatterns.push(...new Set(patterns.map(m => m[0])));
          if (jsf.includes('main.js')) {
            // 結果・払戻関連の文字列を含む周辺を抽出
            const resultContexts = [];
            const resultPattern = /result|kekka|harai|payout|hairetu|cyakujun|finish|arrive/gi;
            let match;
            while ((match = resultPattern.exec(r.text)) !== null) {
              const start = Math.max(0, match.index - 80);
              const end = Math.min(r.text.length, match.index + 80);
              resultContexts.push(r.text.slice(start, end));
              if (resultContexts.length >= 20) break;
            }
            mainJsContent = { length: r.text.length, result_contexts: resultContexts };
          }
        }
      } catch {}
    }
    jsDataPatterns = [...new Set(jsDataPatterns)];

    // TodayRaceResultList.js と PastRaces.js を取得してbc_パターンを探す
    const additionalJsFiles = [
      '/assets/js/TodayRaceResultList.js',
      '/assets/js/PastRaces.js',
      '/assets/js/TodayRaceList.js',
    ];
    for (const jsf of additionalJsFiles) {
      try {
        const r = await tryFetch(`https://race.boatcast.jp${jsf}`);
        if (r.ok) {
          const patterns = [...r.text.matchAll(/bc_[a-z0-9_]+/gi)];
          resultJsPatterns.push(...new Set(patterns.map(m => m[0])));
        }
      } catch {}
    }
    resultJsPatterns = [...new Set(resultJsPatterns)];

    // BOATCAST APIエンドポイント候補も試す
    let apiProbe = null;
    try {
      const r4 = await tryFetch(`https://race.boatcast.jp/api/race/${hd}/${vc}/${rn}`);
      apiProbe = { ok: r4.ok, status: r4.status, preview: r4.ok ? r4.text.slice(0, 1000) : null };
    } catch (e: any) { apiProbe = { error: e.message }; }

    const successResults = results.filter(r => r.ok);
    const successPayouts = payouts.filter(p => p.ok);

    return Response.json({
      js_data_patterns: jsDataPatterns,
      result_js_patterns: resultJsPatterns,
      discovered_results: discoveredResults.filter(r => r.ok),
      result_success: successResults.length,
      payout_success: successPayouts.length,
      ok: true,
      target: { hd, vc, rn },
      result_candidates: results.length,
      result_success: successResults.length,
      result_hits: successResults,
      payout_candidates: payouts.length,
      payout_success: successPayouts.length,
      payout_hits: successPayouts,
    });
  } catch (error: any) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}