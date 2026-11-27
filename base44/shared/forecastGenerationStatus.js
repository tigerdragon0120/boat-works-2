// Read the independent forecast worker's durable outcome for administrators.
// This adapter uses the legacy array SDK used by getAutoUpdateStatusV2.
export async function readForecastGenerationStatus(entity) {
  try {
    const rows = await entity.filter({name:'v8_live_generation'}, '-last_updated', 2);
    if (!Array.isArray(rows)) return {read_status:'READ_FAILED'};
    if (!rows.length) return {read_status:'MISSING'};
    if (rows.length !== 1 || rows[0]?.name !== 'v8_live_generation' || !rows[0]?.id) return {read_status:'CONFLICT'};
    const row = rows[0];
    return {read_status:'READY', status:row.status || 'idle', last_updated:row.last_updated || null,
      error_count:row.error_count ?? 0, errors:Array.isArray(row.errors) ? row.errors : [],
      job_summary:row.job_summary && typeof row.job_summary === 'object' && !Array.isArray(row.job_summary) ? row.job_summary : null};
  } catch {
    return {read_status:'READ_FAILED'};
  }
}
