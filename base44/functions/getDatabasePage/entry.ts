import { createClientFromRequest } from 'npm:@base44/sdk@0.8.44';

async function paged(entity:any, query:any, sort:string, max=100000) {
  const out:any[] = [];
  const limit = 500;
  for (let skip=0; skip<max; skip+=limit) {
    const rows = await entity.filter(query || {}, sort, limit, skip).catch((e:any)=>{ throw e; });
    if (!rows?.length) break;
    out.push(...rows);
    if (rows.length < limit) break;
  }
  return out;
}

export default async function(req:Request) {
  const base44 = createClientFromRequest(req);
  try {
    await base44.auth.me();
    const sr = base44.asServiceRole.entities;
    const body = await req.json().catch(()=>({}));
    const mode = body.mode || 'summary';

    if (mode === 'summary') {
      // 期別成績を一度だけ順次取得。巨大なProfile全件との同時読込を避ける。
      const terms = await paged(sr.RacerTermStats, {}, '-term_year', 100000);
      const termCounts:any = {};
      const latestByReg = new Map<string, any>();
      for (const r of terms) {
        if (r.term_key) termCounts[r.term_key] = (termCounts[r.term_key] || 0) + 1;
        const reg = String(r.registration_number || '').trim();
        if (!reg) continue;
        const prev = latestByReg.get(reg);
        if (!prev || String(r.term_key || '') > String(prev.term_key || '')) latestByReg.set(reg, r);
      }
      return Response.json({ ok:true, term_counts:termCounts, term_total:terms.length, profile_count:latestByReg.size });
    }

    const termKey = String(body.term_key || '').trim();
    const q = String(body.q || '').trim().toLowerCase();
    const page = Math.max(1, Number(body.page || 1));
    const pageSize = Math.min(200, Math.max(20, Number(body.page_size || 100)));

    // Profile表示はRacerProfileではなく、完全に揃っているRacerTermStatsから最新期を選ぶ。
    let source:any[];
    if (mode === 'profiles') {
      const allTerms = await paged(sr.RacerTermStats, {}, '-term_year', 100000);
      const latest = new Map<string,any>();
      for (const r of allTerms) {
        const reg = String(r.registration_number || '').trim();
        if (!reg) continue;
        const prev = latest.get(reg);
        if (!prev || String(r.term_key || '') > String(prev.term_key || '')) latest.set(reg, r);
      }
      source = [...latest.values()];
    } else {
      source = await paged(sr.RacerTermStats, termKey ? { term_key: termKey } : {}, 'registration_number', 100000);
    }

    if (q) source = source.filter((x:any) => [x.racer_name,x.player_name,x.registration_number,x.branch_name,x.branch,x.player_class,x.grade_class,x.term_key,x.source_file].filter(v=>v!=null).join(' ').toLowerCase().includes(q));
    source.sort((a:any,b:any)=>Number(a.registration_number||0)-Number(b.registration_number||0));
    const total = source.length;
    const start = (page-1)*pageSize;
    return Response.json({ ok:true, total, page, page_size:pageSize, rows:source.slice(start,start+pageSize) });
  } catch (e:any) {
    return Response.json({ ok:false, error:e?.message || String(e) }, { status:500 });
  }
}
