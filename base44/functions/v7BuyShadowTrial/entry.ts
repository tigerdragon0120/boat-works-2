// V7 BUY候補の本番並行検証。既存の予想・BUY・買い目を変更しない。
// 参照: Race / PredictionV7 FINAL / OddsSnapshot FINAL。書込: V7BuyShadowTrialへの初回追加のみ。
// 判定時点のデータを固定し、後日取得したオッズでBUYを遡及生成しない。
import { createClientFromRequest } from "npm:@base44/sdk@0.8.60";
import { fetchAllPaged } from "../../shared/pagedFetch.js";

const RULE = "V7_IN5_C95_ODDS8_60S_V1";
const MIN_LEFT_MS = 90 * 1000;
const MAX_LEFT_MS = 8 * 60 * 1000;
const LAST_CHANCE_MS = 3 * 60 * 1000;
const SAVE_MARGIN_MS = 75 * 1000;
const MAX_TRIALS_PER_RUN = 30;
const iso = (ms: number) => new Date(ms).toISOString();
const validTime = (v: any): number | null => {
  const ms = Date.parse(String(v || ""));
  return Number.isFinite(ms) ? ms : null;
};
const nowJstDay = () => new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Tokyo" });
const num = (v: any): number | null => {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

export default async function(req: Request): Promise<Response> {
  const client = createClientFromRequest(req);
  let user: any = null;
  try { user = await client.auth.me(); } catch { user = null; }
  if (!user) return Response.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  if (user.role !== "admin") return Response.json({ ok: false, error: "Forbidden" }, { status: 403 });

  const body = await req.json().catch(() => ({}));
  const dryRun = body?.dry_run === true;
  // 外部入力で締切・判定条件・日付を変更させない。
  const day = nowJstDay();
  const sr = client.asServiceRole.entities;
  const report: any = { ok: true, rule: RULE, date: day, dry_run: dryRun, candidates: 0, buy: 0, skip: 0, undetermined: 0,
    recorded: 0, existing: 0, deferred: 0, read_errors: 0, too_late: 0, duplicate_predictions: 0, after_cutoff_saves: 0 };

  try {
    const [racesPage, predictionsPage] = await Promise.all([
      fetchAllPaged(
        (query: any, options: any) => sr.Race.filter(query, options),
        { race_date: day },
        { sort: "-deadline", pageSize: 200, maxPages: 5, deadlineMs: Date.now() + 20000 }
      ),
      fetchAllPaged(
        (query: any, options: any) => sr.PredictionV7.filter(query, options),
        { race_date: day, stage: "FINAL" },
        { sort: "-generated_at", pageSize: 200, maxPages: 8, deadlineMs: Date.now() + 20000 }
      ),
    ]);
    if (!racesPage.complete || !predictionsPage.complete) {
      return Response.json({ ok: false, error: "SourceReadIncomplete",
        race_error: racesPage?.error || null, race_page: racesPage?.page || null,
        prediction_error: predictionsPage?.error || null, prediction_page: predictionsPage?.page || null }, { status: 503 });
    }
    const races = racesPage.rows;
    const predictionsByKey = new Map<string, any[]>();
    for (const row of predictionsPage.rows) {
      if (!row?.race_key || row.stage !== "FINAL") continue;
      const list = predictionsByKey.get(String(row.race_key)) || [];
      list.push(row);
      predictionsByKey.set(String(row.race_key), list);
    }

    const raceByKey = new Map<string, any>();
    for (const race of races) {
      if (!race?.race_key || !race?.id || !race?.deadline) continue;
      const key = String(race.race_key);
      if (!raceByKey.has(key)) raceByKey.set(key, race);
    }

    for (const race of raceByKey.values()) {
      if (report.recorded >= MAX_TRIALS_PER_RUN) break;
      const deadline = validTime(race.deadline);
      if (!deadline || race.status === "cancelled") continue;
      const left = deadline - Date.now();
      if (left < MIN_LEFT_MS || left > MAX_LEFT_MS) continue;
      report.candidates += 1;
      const cutoff = deadline - 60 * 1000;
      const key = String(race.race_key);
      const trialKey = RULE + ":" + key;

      // 既存の判定は絶対に更新しない。同じ締切を再試行しない。
      const old = await sr.V7BuyShadowTrial.filter({ trial_key: trialKey }, "-created_date", 2);
      if (!Array.isArray(old)) { report.read_errors++; continue; }
      if (old.length) { report.existing++; continue; }

      const matched = predictionsByKey.get(key) || [];
      const pred = matched.length === 1 ? matched[0] : null;
      if (matched.length > 1) report.duplicate_predictions++;
      const predictionCreatedAt = pred ? validTime(pred.created_date) : null;
      const predictionGeneratedAt = pred ? validTime(pred.generated_at) : null;
      const tickets: string[] = pred?.plans?.hit_8?.tickets || [];
      const ticketValid = Array.isArray(tickets) && tickets.length === 8 && new Set(tickets).size === 8
        && tickets.every((ticket) => /^[1-6]-[1-6]-[1-6]$/.test(String(ticket)) && new Set(String(ticket).split("-")).size === 3);

      let snapshot: any = null;
      let oddsError = false;
      if (pred && ticketValid && pred.race_id === race.id) {
        try {
          const snaps = await sr.OddsSnapshot.filter({ race_id: race.id, stage: "FINAL" }, "-captured_at", 30);
          if (!Array.isArray(snaps)) oddsError = true;
          else snapshot = snaps.find((s: any) => {
            const t = validTime(s.captured_at);
            return t != null && t <= Date.now() && t < cutoff && s.stage === "FINAL";
          }) || null;
        } catch { oddsError = true; }
      }
      if (oddsError) { report.read_errors++; continue; }

      const decisionTime = Date.now();
      if (decisionTime >= cutoff - 15 * 1000) { report.too_late++; continue; }

      const coverage = num(pred?.coverage);
      const selectedOdds: Record<string, number> = {};
      let oddsComplete = !!snapshot;
      if (snapshot && ticketValid) {
        for (const ticket of tickets) {
          const odd = num(snapshot.odds_map?.[ticket]);
          if (odd == null || odd <= 0) oddsComplete = false;
          else selectedOdds[ticket] = odd;
        }
      }
      let reason = "";
      let decision = "UNDETERMINED";
      if (matched.length > 1) reason = "DUPLICATE_FINAL";
      else if (!pred) reason = "FINAL_MISSING";
      else if (pred.race_id !== race.id) reason = "RACE_ID_MISMATCH";
      else if (!predictionGeneratedAt || !predictionCreatedAt || predictionGeneratedAt > decisionTime || predictionCreatedAt > decisionTime || predictionCreatedAt >= cutoff) reason = "PREDICTION_TIME_INVALID";
      else if (!ticketValid) reason = "TICKETS_INCOMPLETE";
      else if (!snapshot || !oddsComplete) reason = "FINAL_ODDS_MISSING";
      else if (coverage == null) reason = "COVERAGE_MISSING";
      else {
        const insideCount = tickets.filter((t) => t.startsWith("1-")).length;
        const minOdds = Math.min(...Object.values(selectedOdds));
        decision = insideCount >= 5 && coverage >= 0.95 && minOdds >= 8 ? "BUY" : "SKIP";
        reason = decision === "BUY" ? "ALL_RULES_PASSED" :
          [insideCount < 5 ? "INSIDE_LT5" : "", coverage < 0.95 ? "COVERAGE_LT95" : "", minOdds < 8 ? "ODDS_LT8" : ""].filter(Boolean).join(",");
      }

      // 取得データが欠けている場合は締切が近づくまで再取得を試みる。
      // 完走可能な残り時間に達したら未判定を一度だけ記録する。
      if (decision === "UNDETERMINED" && deadline - Date.now() > LAST_CHANCE_MS) {
        report.deferred++;
        continue;
      }
      // DBへの書込処理の前に再度余裕を確認する（60秒ぎりぎりに保存しない）。
      if (Date.now() >= cutoff - 15 * 1000) { report.too_late++; continue; }

      const trial: any = {
        trial_key: trialKey, rule_version: RULE, race_key: key, race_id: race.id, race_date: day,
        venue_code: String(race.venue_code || ""), race_number: Number(race.race_number || 0),
        model: pred?.model === "WOMENS" || pred?.is_womens || race.is_womens ? "WOMENS" : "OPEN",
        stage: "FINAL", decision, reason,
        prediction_hash: String(pred?.record_hash || ""), prediction_id: String(pred?.id || ""),
        prediction_generated_at: predictionGeneratedAt ? iso(predictionGeneratedAt) : undefined,
        odds_id: String(snapshot?.id || ""),
        odds_captured_at: snapshot?.captured_at || undefined,
        deadline: iso(deadline), cutoff_at: iso(cutoff), decided_at: iso(Date.now()),
        coverage: coverage ?? undefined,
        inside_count: ticketValid ? tickets.filter((t) => t.startsWith("1-")).length : undefined,
        min_odds: oddsComplete ? Math.min(...Object.values(selectedOdds)) : undefined,
        tickets: ticketValid ? [...tickets] : [],
        sealed_odds: selectedOdds,
        current_buy_judgment: String(pred?.plans?.hit_8?.judgment || ""),
        source: "SERVER_SHADOW"
      };
      if (dryRun) { report[decision.toLowerCase()]++; continue; }

      try {
        const created = await sr.V7BuyShadowTrial.create(trial);
        if (!created?.id) { report.read_errors++; continue; }
        report.recorded++;
        report[decision.toLowerCase()]++;
        // DB-created_atはBase44側が記録する時刻。保存後に60秒前判定を再照合。
        if (validTime(created.created_date) == null || validTime(created.created_date)! >= cutoff) {
          report.after_cutoff_saves++;
          console.error("[V7_BUY_SHADOW] record outside verified cutoff:", trialKey);
        }
      } catch (err: any) {
        report.read_errors++;
        console.error("[V7_BUY_SHADOW] create failed:", key, String(err?.message || err).slice(0,200));
      }
    }
    return Response.json({ ...report, completed_at: new Date().toISOString() });
  } catch (err: any) {
    console.error("[V7_BUY_SHADOW] run failed", String(err?.message || err).slice(0,250));
    return Response.json({ ok: false, error: "TrialReadOrProcessingFailed", detail: String(err?.message || "unknown").replace(/[A-Za-z0-9_./:-]{50,}/g, "[redacted]").slice(0, 180) }, { status: 503 });
  }
}