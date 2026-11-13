// V7エンジン共通の時刻・キー・ハッシュ処理。
// ブラウザ版(src/lib/uiReadGuard.js, src/liveV7/reader.js)と同じ規則。
// DBのメタ日時はUTCのオフセット無しで返るため、platformUtc で正規化してから使う。

export function timeMs(value) {
  if (typeof value !== "string" || !/(Z|[+-]\d{2}:\d{2})$/.test(value)) return null;
  const n = Date.parse(value);
  return Number.isFinite(n) ? n : null;
}

// オフセットの無いDBメタ日時(例 2026-11-13T00:41:03.653000)をUTCとして解釈する。
// レース締切のようにオフセット付きの値はそのまま返す。
export function platformUtc(value) {
  if (typeof value !== "string") return value;
  const m = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?$/.exec(value);
  if (!m) return value;
  return `${m[1]}${m[2] ? `.${m[2].slice(0, 3).padEnd(3, "0")}` : ""}Z`;
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
  return `{${Object.keys(value)
    .filter((k) => value[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`)
    .join(",")}}`;
}

export async function digest(value) {
  const bytes = new TextEncoder().encode(canonical(value));
  const hash = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(hash)].map((n) => n.toString(16).padStart(2, "0")).join("");
}