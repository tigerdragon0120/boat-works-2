// リース付き排他ロック。Base44のentity操作は原子でないため、
// best-effort取得 + リース有効期限で永久ロックを防止する。
// 競合で同時取得できても後段のデデアップ(mergeDuplicates)が安全網となる。

const LOCK_TTL_MS = 10 * 60 * 1000; // 10分
const LOCK_ENTITY = "ProcessLock";

function nowIso() { return new Date().toISOString(); }
function ownerId(fn) { return `${fn}_${Math.random().toString(36).slice(2, 10)}`; }

// lock_keyのロックを取得試行。取得失敗(他人が有効期限内)なら null。
export async function acquireLock(client, lockKey, fnName, ttlMs = LOCK_TTL_MS) {
  const sr = client.asServiceRole.entities;
  const owner = ownerId(fnName);
  const now = Date.now();
  const expires = new Date(now + ttlMs).toISOString();
  // 既存アクティブロックを確認
  const existing = await sr[LOCK_ENTITY].filter({ lock_key: lockKey, status: "active" }, "-acquired_at", 10).catch(() => []);
  if (existing && existing.length) {
    const stale = existing.filter((l) => new Date(l.expires_at).getTime() <= now);
    if (stale.length === existing.length) {
      // 全期限切れ→掃除して取得
      await sr[LOCK_ENTITY].deleteMany({ lock_key: lockKey, status: "active" }).catch(() => {});
    } else {
      // 有効なロックが存在→取得失敗
      return null;
    }
  }
  try {
    const created = await sr[LOCK_ENTITY].create({ lock_key: lockKey, owner, acquired_at: nowIso(), expires_at: expires, status: "active" });
    return created?.id || null;
  } catch {
    // create競合失敗
    return null;
  }
}

// ロック解放
export async function releaseLock(client, lockId) {
  if (!lockId) return;
  const sr = client.asServiceRole.entities;
  await sr[LOCK_ENTITY].update(lockId, { status: "released" }).catch(() => {});
}

// 期限切れロックの一括掃除(軽量)
export async function cleanupExpiredLocks(client) {
  const sr = client.asServiceRole.entities;
  const now = nowIso();
  await sr[LOCK_ENTITY].updateMany({ status: "active", expires_at: { $lt: now } }, { $set: { status: "expired" } }).catch(() => {});
}