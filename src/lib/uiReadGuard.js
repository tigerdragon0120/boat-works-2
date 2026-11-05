// Late responses from a previously viewed race must not update the current screen.
export async function applyIfActive(promise,isActive,apply){const value=await promise;if(isActive())apply(value);return value;}

// Pure browser helpers extracted from the earlier local integrity module.
// No server confirmation protocol or backend resource dependency.
export function timeMs(value) {
  if (typeof value !== "string" || !/(Z|[+-]\d{2}:\d{2})$/.test(value)) return null;
  const n = Date.parse(value);
  return Number.isFinite(n) ? n : null;
}

export function raceKey(value) {
  const m = /^(\d{4}-\d{2}-\d{2})_(\d{1,2})_(\d{1,2})$/.exec(String(value || ""));
  if (!m || +m[2] < 1 || +m[2] > 24 || +m[3] < 1 || +m[3] > 12) throw new Error("INVALID_RACE_KEY");
  if (new Date(`${m[1]}T00:00:00Z`).toISOString().slice(0, 10) !== m[1]) throw new Error("INVALID_RACE_DATE");
  return `${m[1]}_${m[2].padStart(2, "0")}_${m[3].padStart(2, "0")}`;
}

export function canonical(value) {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value).filter(k => value[k] !== undefined).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(",")}}`;
}

export async function digest(value) {
  const bytes = new TextEncoder().encode(canonical(value));
  const hash = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(hash)].map(n => n.toString(16).padStart(2, "0")).join("");
}