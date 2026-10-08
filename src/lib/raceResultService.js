import { base44 } from "@/api/base44Client";
import { fetchOnlineData } from "@/lib/dataManagementService";

const attempts = new Map();
const pending = new Map();

export async function getRaceResult(race) {
  if (!race?.id) return null;
  const read = async () => {
    const rows = await base44.entities.RaceResult.filter({ race_id: race.id }, "-finished_at", 10);
    return rows.find(r => r.result_trifecta && (r.is_finished || r.result_status === "RESULT_FINAL")) || rows[0] || null;
  };
  let result = await read();
  const deadline = new Date(race.deadline).getTime();
  const ended = race.status === "finished" || (Number.isFinite(deadline) && Date.now() >= deadline + 5 * 60000);
  const payouts = result?.payouts || {};
  const complete = result?.result_trifecta && payouts.trifecta && payouts.trifecta_quinella && payouts.exacta && payouts.quinella && payouts.wide?.length;
  if (!ended || race.status === "cancelled" || complete) return result;
  if (pending.has(race.id)) {
    await pending.get(race.id);
    return (await read()) || result;
  }
  if (Date.now() - (attempts.get(race.id) || 0) < 60000) return result;
  attempts.set(race.id, Date.now());
  const request = fetchOnlineData("result", race.race_date, race.venue_code, race.race_number, race.id);
  pending.set(race.id, request);
  try {
    await request;
    result = (await read()) || result;
  } catch (error) {
    console.warn("[RaceResult] result refresh failed:", error?.message || error);
  } finally {
    pending.delete(race.id);
  }
  return result;
}
