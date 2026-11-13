// =====================================================
// V7 予想生成の追跡記録(診断専用)
//
// 「FINALがなぜ保存されなかったか」を後から追えるように、
// 展示データの取得時刻・生成開始・生成できなかった理由・保存結果を
// レース×段階ごとに1行だけ残す。
//
// 守るルール:
//  1. この記録は予想の生成・保存・判定には一切使わない
//  2. 予想(PredictionV7)の更新・削除は行わない
//  3. 締切を過ぎた組は生成せず、BLOCKED(deadline_passed)として残す
//  4. 保存済みの組は、あとから別の理由で上書きしない
//  5. 状態が変わったときだけ書き込む(実行のたびに全行を更新しない)
// =====================================================

const PAIR = (key, stage) => `${key}::${stage}`;

// 暫定順位づけに足りる展示の有無(最終品質の証拠ではない)
// 生成可否の判定でもこの関数を使う(判定基準を二重に持たない)
export function hasPartialExhibition(entries, race) {
  const scratched = new Set((race && race.scratched_boats ? race.scratched_boats : []).map(Number));
  const active = (entries || []).filter((e) => !e.is_absent && !e.is_scratched && !scratched.has(Number(e.boat_number)));
  if (active.length < 3 || active.length > 6) return false;
  const usable = active.filter((e) =>
    Number(e.exhibition_time) > 0 && Number.isFinite(Number(e.exhibition_time)) &&
    e.exhibition_st != null && Number.isFinite(Number(e.exhibition_st)) &&
    Number.isInteger(Number(e.exhibition_course)) && Number(e.exhibition_course) >= 1 && Number(e.exhibition_course) <= 6);
  return usable.length >= 3 && new Set(usable.map((e) => Number(e.exhibition_course))).size === usable.length;
}

// 出走表(展示値)の最終更新時刻。オフセットの無い値はUTC壁時計として扱う
function latestEntryUpdate(entries) {
  if (!Array.isArray(entries)) return null;
  const latest = entries.map((entry) => String(entry?.updated_date || "")).filter(Boolean).sort().pop() || null;
  if (!latest) return null;
  return /(Z|[+-]\d{2}:?\d{2})$/.test(latest) ? latest : `${latest}Z`;
}

function exhibitionInfoFor(race, entries, logs) {
  // 出走表を読んでいないレースは「展示が無い」ではなく「未確認(null)」として残す
  const known = Array.isArray(entries);
  const scratched = new Set((race && race.scratched_boats ? race.scratched_boats : []).map(Number));
  const active = (entries || []).filter((e) => !e.is_absent && !e.is_scratched && !scratched.has(Number(e.boat_number)));
  const fetched = (logs || [])
    .filter((log) => log && log.fetch_type === "exhibition" && (!log.status || log.status === "success")
      && (!log.venue_code || String(log.venue_code) === String(race.venue_code))
      && (!log.race_number || Number(log.race_number) === Number(race.race_number))
      && (!log.race_id || log.race_id === race.id))
    .map((log) => String(log.fetched_at || ""))
    .filter(Boolean)
    .sort()
    .pop() || null;
  return {
    ready: race.exhibition_ready === true,
    usable: known ? hasPartialExhibition(entries, race) : null,
    active_boats: known ? active.length : null,
    // 展示取得ログが無い場合でも、出走表(展示値)の最終更新時刻を取得時刻として残す
    fetched_at: fetched || latestEntryUpdate(entries),
  };
}

const TRACE_FIELDS = [
  "outcome", "reason", "reason_detail",
  "record_hash", "prediction_created_at", "generation_started_at",
  "exhibition_fetched_at", "exhibition_ready", "exhibition_usable", "exhibition_active_boats",
  "deadline", "deadline_passed",
];

export function createGenerationTrace({
  races = [], entriesByKey = new Map(), logs = [], traces = [], raceDate = null, nowMs = Date.now(), writable = true,
} = {}) {
  const raceByKey = new Map();
  const exhibition = new Map();
  for (const race of races || []) {
    if (!race?.race_key) continue;
    raceByKey.set(race.race_key, race);
    exhibition.set(race.race_key, exhibitionInfoFor(race, entriesByKey.has(race.race_key) ? entriesByKey.get(race.race_key) : null, logs));
  }

  const previous = new Map();
  for (const row of traces || []) {
    if (!row?.race_key || !row?.stage) continue;
    const key = PAIR(row.race_key, row.stage);
    const known = previous.get(key);
    if (!known || String(row.created_date || "") > String(known.created_date || "")) previous.set(key, row);
  }

  const state = new Map();

  const base = (race, stage) => {
    const info = exhibition.get(race.race_key) || { ready: race.exhibition_ready === true, usable: null, active_boats: null, fetched_at: null };
    const deadline = race.deadline || null;
    const deadlineMs = deadline ? Date.parse(deadline) : NaN;
    return {
      race_date: race.race_date || raceDate,
      race_key: race.race_key,
      race_id: race.id || null,
      venue_code: race.venue_code != null ? String(race.venue_code) : null,
      race_number: Number.isFinite(Number(race.race_number)) ? Number(race.race_number) : null,
      stage,
      deadline,
      deadline_passed: Number.isFinite(deadlineMs) ? deadlineMs <= nowMs : null,
      exhibition_ready: info.ready,
      exhibition_usable: info.usable,
      exhibition_active_boats: info.active_boats,
      exhibition_fetched_at: info.fetched_at,
    };
  };

  const observe = (race, stage, outcome, reason, extra = {}) => {
    if (!race?.race_key || !stage) return;
    const key = PAIR(race.race_key, stage);
    const known = state.get(key) || previous.get(key);
    // 保存済みの組は、あとから別の理由で上書きしない
    if (known && known.outcome === "SAVED" && outcome !== "SAVED") return;
    // 保存応答不明は、行が実際に確認できるまで期限到来・再試行失敗で降格させない。
    if (known?.reason === 'save_unconfirmed' && outcome !== 'SAVED') {
      state.set(key, { ...base(race, stage), ...Object.fromEntries(TRACE_FIELDS.map(field => [field, known[field] ?? null])), outcome: 'UNKNOWN' });
      return;
    }
    const next = { ...base(race, stage), outcome, reason: reason || null, ...extra };
    // その回に取得できなかった項目は、既に記録済みの値を消さない(不明で上書きしない)
    for (const field of ["exhibition_fetched_at", "exhibition_usable", "exhibition_active_boats"]) {
      if (next[field] == null && known && known[field] != null) next[field] = known[field];
    }
    state.set(key, next);
  };

  // 前回までに保存された予想を「保存結果」として記録する
  const applySavedPredictions = (rows = []) => {
    for (const row of rows || []) {
      const race = raceByKey.get(row?.race_key);
      if (!race || !row?.stage) continue;
      observe(race, row.stage, "SAVED", "saved", {
        record_hash: row.record_hash || null,
        prediction_created_at: row.created_date || row.generated_at || null,
        generation_started_at: row.generated_at || row.created_date || null,
      });
    }
  };

  // 生成を試みなかった組を、締切・開催状態から埋める(締切後は生成しない)
  const fillUntouched = (targetIds = new Set()) => {
    for (const race of races || []) {
      if (!race?.race_key) continue;
      const deadlineMs = race.deadline ? Date.parse(race.deadline) : NaN;
      const closed = Number.isFinite(deadlineMs) && deadlineMs <= nowMs;
      const stopped = ["finished", "cancelled"].includes(race.status);
      for (const stage of ["PRE", "FINAL"]) {
        const key = PAIR(race.race_key, stage);
        if (state.has(key) || previous.get(key)?.outcome === "SAVED") continue;
        const known = previous.get(key);
        if (known?.reason === 'save_unconfirmed' || (known?.outcome === 'UNKNOWN' && known?.reason === 'RETRY_REQUIRED')) {
          state.set(key, { ...base(race, stage), ...Object.fromEntries(TRACE_FIELDS.map(field => [field, known[field] ?? null])), outcome: 'UNKNOWN' });
          continue;
        }
        if (closed || stopped) {
          // 締切まで生成できなかった場合は、その時点の理由(展示待ちなど)を残す。
          // 理由が無い場合だけ deadline_passed とする
          const carried = previous.get(key)?.reason;
          const reason = carried && !["outside_horizon", "not_attempted", "race_closed", "deadline_passed"].includes(carried)
            ? carried
            : (closed ? "deadline_passed" : "race_closed");
          state.set(key, { ...base(race, stage), outcome: "BLOCKED", reason });
        } else {
          state.set(key, { ...base(race, stage), outcome: "PENDING", reason: targetIds.has(race.id) ? "not_attempted" : "outside_horizon" });
        }
      }
    }
  };

  // 状態が変わった行だけを書く。記録の失敗で生成を止めない
  const flush = async (sr, observedAt = new Date().toISOString()) => {
    // 読み切れなかった診断記録を新規作成・別状態で上書きしない。
    if (!writable) return { created: 0, updated: 0, tracked: 0, unconfirmed: true };
    const creates = [];
    const updates = [];
    for (const [key, value] of state) {
      const known = previous.get(key) || null;
      const doc = { ...value, observed_at: observedAt, first_observed_at: known?.first_observed_at || observedAt };
      // 記録しない項目も空として明示する(前回の値を残さず、次回の比較を安定させる)
      for (const field of TRACE_FIELDS) if (doc[field] === undefined) doc[field] = null;
      if (!known) { creates.push(doc); continue; }
      if (!TRACE_FIELDS.some((field) => String(known[field] ?? "") !== String(doc[field] ?? ""))) continue;
      updates.push({ id: known.id, ...doc });
    }
    if (creates.length) await sr.V7GenerationTrace.bulkCreate(creates).catch(() => {});
    for (let i = 0; i < updates.length; i += 100) {
      await sr.V7GenerationTrace.bulkUpdate(updates.slice(i, i + 100)).catch(() => {});
    }
    return { created: creates.length, updated: updates.length, tracked: state.size };
  };

  return { observe, applySavedPredictions, fillUntouched, flush };
}