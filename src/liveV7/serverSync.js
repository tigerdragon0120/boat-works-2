// ============================================================
// V7 予想のサーバー保存
// 端末内(localStorage / IndexedDB)に残る不変レコードを、DB(PredictionV7)へも保存する。
// 端末の保存が消えても履歴が残り、日次検証(verifyV7Daily)が全端末分を照合できる。
// 既存のローカル保存・表示には一切手を加えない。
// ============================================================
import { base44 } from '@/api/base44Client';

const SAVED_KEY = 'BOAT_V7_SYNCED_V1';
const THROTTLE_MS = 30000;
let saved = null;
let inflight = null;
let lastRun = 0;

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);

function loadSaved() {
  if (saved) return saved;
  try {
    saved = new Set(JSON.parse(localStorage.getItem(SAVED_KEY) || '[]'));
  } catch {
    saved = new Set();
  }
  return saved;
}

function remember(set) {
  saved = set;
  try {
    localStorage.setItem(SAVED_KEY, JSON.stringify([...set].slice(-3000)));
  } catch {
    /* 端末の保存容量不足は無視。DB側の重複判定で二重登録を防ぐ */
  }
}

function rankOrder(output) {
  const order = (output?.marginals || []).map(
    (marginal) => Object.entries(marginal || {}).sort((a, b) => b[1] - a[1] || +a[0] - +b[0])[0]?.[0]
  ).map(Number);
  return order.length === 3 && order.every((n) => Number.isInteger(n)) ? order : null;
}

function toDoc(record) {
  const payload = record?.payload || {};
  const output = payload.output || {};
  const race = payload.race || {};
  if (!payload.race_key || !payload.stage || !output.model) return null;

  const plans = {};
  for (const [mode, source] of [['hit', 'ticketPlans'], ['value', 'recoveryPlans']]) {
    for (const count of [4, 6, 8, 12]) {
      const plan = output[source]?.[count];
      const tickets = Array.isArray(plan?.tickets) ? plan.tickets.filter((t) => typeof t === 'string') : [];
      if (!tickets.length) continue;
      plans[`${mode}_${count}`] = {
        tickets,
        probability: num(plan.probability),
        judgment: plan.judgment || null,
      };
    }
  }
  if (!Object.keys(plans).length) return null;

  const top = (output.combinations || [])
    .filter((c) => c && typeof c.combination === 'string' && Number.isFinite(Number(c.probability)))
    .sort((a, b) => b.probability - a.probability || a.combination.localeCompare(b.combination))[0] || null;

  return {
    record_hash: record.hash,
    input_hash: payload.input_hash || null,
    race_id: race.id || null,
    race_key: payload.race_key,
    race_date: race.race_date || String(payload.race_key).slice(0, 10),
    venue_code: race.venue_code != null ? String(race.venue_code) : null,
    race_number: Number.isFinite(Number(race.race_number)) ? Number(race.race_number) : null,
    series_name: race.series_name || null,
    is_womens: output.model === 'WOMENS',
    model: output.model,
    stage: payload.stage,
    generated_at: payload.generated_at || null,
    deadline: payload.deadline || null,
    top_combination: top ? top.combination : null,
    top_probability: top ? num(top.probability) : null,
    rank_order: rankOrder(output),
    plans,
    coverage: num(output.coverage),
    judgment_reason: output.judgment_reason ? String(output.judgment_reason).slice(0, 500) : null,
    source: 'BROWSER',
  };
}

export function syncV7ToServer(controller, { force = false } = {}) {
  const now = Date.now();
  if (!force && now - lastRun < THROTTLE_MS) return Promise.resolve(null);
  if (inflight) return inflight;
  lastRun = now;

  inflight = (async () => {
    await controller.restore();
    const set = loadSaved();
    const pending = [...controller.records.values()].filter(
      (record) => record?.hash && record.payload?.output && !set.has(record.hash)
    );
    if (!pending.length) return { saved: 0 };

    const docs = [];
    for (const record of pending) {
      const doc = toDoc(record);
      if (!doc) {
        set.add(record.hash);
        continue;
      }
      docs.push(doc);
    }
    if (!docs.length) {
      remember(set);
      return { saved: 0 };
    }

    // 端末の保存が消えて再送された場合に二重登録しない
    const existing = new Set();
    for (let i = 0; i < docs.length; i += 40) {
      const chunk = docs.slice(i, i + 40).map((doc) => doc.record_hash);
      const rows = await base44.entities.PredictionV7
        .filter({ record_hash: { $in: chunk } }, '-generated_at', 200)
        .catch(() => []);
      for (const row of rows || []) existing.add(row.record_hash);
    }

    const fresh = docs.filter((doc) => !existing.has(doc.record_hash));
    if (fresh.length) await base44.entities.PredictionV7.bulkCreate(fresh);
    for (const doc of docs) set.add(doc.record_hash);
    remember(set);
    return { saved: fresh.length };
  })()
    .catch(() => null)
    .finally(() => {
      inflight = null;
    });

  return inflight;
}