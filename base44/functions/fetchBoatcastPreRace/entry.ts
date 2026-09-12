import { createClientFromRequest } from 'npm:@base44/sdk@0.8.44';
import { fetchBoatcastText } from '../../shared/boatcastClient.js';
import { normalizeStr3 } from '../../shared/boatcastNormalizer.js';

function normalizeName(s: any): string {
  return String(s || '').replace(/[\s\u3000]/g, '');
}

// 項目ごとの照合: MATCH / MISMATCH / BOATCAST_ONLY / LOCAL_ONLY / MISSING
function compareField(boatcastVal: any, localVal: any): string {
  if (boatcastVal == null && localVal == null) return 'MISSING';
  if (boatcastVal == null) return 'LOCAL_ONLY';
  if (localVal == null) return 'BOATCAST_ONLY';
  if (typeof boatcastVal === 'number' && typeof localVal === 'number') {
    return Math.abs(boatcastVal - localVal) < 0.05 ? 'MATCH' : 'MISMATCH';
  }
  return String(boatcastVal) === String(localVal) ? 'MATCH' : 'MISMATCH';
}

export default async function (req: Request) {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ ok: false, error: 'Unauthorized' }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const venueCode = String(body.venue_code || '').padStart(2, '0');
    const raceDateRaw = String(body.race_date || '');
    const raceDate = raceDateRaw.replace(/-/g, '');
    const raceNumber = Number(body.race_number);

    if (!venueCode || !raceDate || !raceNumber) {
      return Response.json({ ok: false, error: 'venue_code, race_date, race_number required' }, { status: 400 });
    }

    // ── 1. BOATCAST str3取得(共通クライアント経由) ──
    const str3Result = await fetchBoatcastText({
      venueCode,
      raceDate,
      raceNumber,
      dataType: 'STR3',
    });

    if (!str3Result.ok) {
      return Response.json({ ok: false, error: str3Result.error, metadata: str3Result.metadata }, { status: 502 });
    }

    // ── 2. 正規化(BOATCAST → BW2標準形式) ──
    const normalized = normalizeStr3(str3Result.text, str3Result.metadata);

    // ── 3. LOCALデータ取得(RaceEntry) ──
    const sr = base44.asServiceRole.entities;
    const dateFormatted = raceDateRaw.includes('-') ? raceDateRaw :
      `${raceDate.slice(0,4)}-${raceDate.slice(4,6)}-${raceDate.slice(6,8)}`;
    const raceKey = `${dateFormatted}_${venueCode}_${raceNumber}`;

    let localEntries: any[] = [];
    try {
      localEntries = await sr.RaceEntry.filter({ race_key: raceKey }, 'boat_number', 10);
    } catch {}

    // ── 4. 項目別照合 ──
    const comparisons = [];
    for (const bcRacer of normalized.racers) {
      const localEntry = localEntries.find((e: any) => Number(e.boat_number) === bcRacer.lane);
      const localReg = String(localEntry?.register_number || localEntry?.registration_number || '');

      const fields = [
        { field: 'registration_number', bc: bcRacer.registration_number, local: localReg || null },
        { field: 'player_name', bc: bcRacer.player_name, local: normalizeName(localEntry?.player_name || localEntry?.racer_name) || null },
        { field: 'player_class', bc: bcRacer.player_class, local: localEntry?.player_class || localEntry?.grade_class || null },
        { field: 'branch_name', bc: bcRacer.branch_name, local: null },
        { field: 'age', bc: bcRacer.age, local: null },
        { field: 'national_win_rate', bc: bcRacer.national_win_rate, local: localEntry?.national_win_rate ?? null },
        { field: 'national_2rate', bc: bcRacer.national_2rate, local: localEntry?.national_f2_rate ?? localEntry?.national_2rate ?? null },
        { field: 'national_3rate', bc: bcRacer.national_3rate, local: localEntry?.national_f3_rate ?? localEntry?.national_3rate ?? null },
        { field: 'local_win_rate', bc: bcRacer.local_win_rate, local: localEntry?.local_win_rate ?? null },
        { field: 'local_2rate', bc: bcRacer.local_2rate, local: localEntry?.local_f2_rate ?? localEntry?.local_2rate ?? null },
        { field: 'local_3rate', bc: bcRacer.local_3rate, local: localEntry?.local_f3_rate ?? localEntry?.local_3rate ?? null },
        { field: 'avg_st', bc: bcRacer.avg_st, local: localEntry?.avg_st ?? null },
        { field: 'f_flag', bc: bcRacer.f_flag, local: localEntry?.f_count != null ? (localEntry.f_count > 0 ? 'F' : ' ') : null },
        { field: 'l_flag', bc: bcRacer.l_flag, local: localEntry?.l_count != null ? (localEntry.l_count > 0 ? 'L' : ' ') : null },
      ];

      const fieldResults: any = {};
      for (const { field, bc, local } of fields) {
        fieldResults[field] = { boatcast: bc, local, status: compareField(bc, local) };
      }

      comparisons.push({
        lane: bcRacer.lane,
        registration_number: bcRacer.registration_number,
        player_name: bcRacer.player_name,
        fields: fieldResults,
        section_races: bcRacer.section_races,
      });
    }

    // ── 5. 集計 ──
    const summary: any = { MATCH: 0, MISMATCH: 0, BOATCAST_ONLY: 0, LOCAL_ONLY: 0, MISSING: 0 };
    for (const c of comparisons) {
      for (const f of Object.values(c.fields)) {
        summary[(f as any).status] = ((summary[(f as any).status] || 0) + 1);
      }
    }

    return Response.json({
      ok: true,
      metadata: str3Result.metadata,
      boatcast_racer_count: normalized.racers.length,
      local_entry_count: localEntries.length,
      comparisons,
      summary,
    });
  } catch (e: any) {
    return Response.json({ ok: false, error: e.message }, { status: 500 });
  }
}