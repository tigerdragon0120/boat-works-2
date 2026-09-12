// ============================================================
// BOATCAST共通取得クライアント
// すべてのBOATCASTアクセスはこのモジュールを通す。
// URL生成・HTTP取得・キャッシュ・リトライ・エラー処理・診断情報を一元管理。
//
// 取得フロー:
//   BOATCAST → 1回取得 → CACHE → 画面・分析
//   (画面表示のたびにBOATCASTへ直接アクセスしない)
// ============================================================

const BOATCAST_BASE = 'https://race.boatcast.jp/hp_txt';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';
const FETCH_TIMEOUT_MS = 10000;
const MAX_RETRIES = 3;

// ============================================================
// データ種別定義
// 今後ここに新データ種別を追加していく
// ============================================================
const BOATCAST_DATA_TYPES = {
  WAKU10: {
    code: 'waku10',
    updatePolicy: 'STATIC',
    ttl: 30 * 60 * 1000, // 30分(既存動作を維持)
    description: '枠番別過去10走',
  },
  STR3: {
    code: 'str3',
    updatePolicy: 'PRE_RACE',
    ttl: 60 * 60 * 1000, // 1時間
    description: '選手基本情報+成績+節間成績(3連率含む)',
  },
  STR2: {
    code: 'str2',
    updatePolicy: 'PRE_RACE',
    ttl: 60 * 60 * 1000, // 1時間
    description: '選手基本情報+成績(3連率なし・STR3の下位互換)',
  },
};

// 更新ポリシー別デフォルトTTL
// データ種類によって更新頻度を変えられる構造
const UPDATE_POLICIES = {
  STATIC: 24 * 60 * 60 * 1000,  // 24時間: 一度取得すれば基本的に再取得不要
  PRE_RACE: 60 * 60 * 1000,     // 1時間: 前日〜レース前に更新
  LIVE: 5 * 60 * 1000,          // 5分: 展示・オッズなど更新が必要
  FINAL: Infinity,             // 無期限: レース終了後に一度取得して確定
};

// ============================================================
// キャッシュ・同時リクエスト制御
// ============================================================
// cacheKey -> { text, fetchedAt, httpStatus }
const cache = new Map();
// cacheKey -> Promise (同一URL同時リクエスト重複排除)
const inFlight = new Map();

// ============================================================
// 診断情報(管理者・開発確認用)
// ============================================================
const diagnostics = {
  connection_status: 'OK',   // 'OK' | 'ERROR'
  last_fetch: null,          // ISO timestamp
  last_url: null,
  http_status: null,         // 200 / 404 / 429 etc.
  cache: null,               // 'HIT' | 'MISS'
  source: 'BOATCAST',
  data_type: null,
  last_error: null,
};

// ============================================================
// URL生成(共通化)
// 各機能が直接BOATCAST URLを組み立てる設計にしない
// ============================================================
function buildUrl(dataType, venueCode, raceDate, raceNumber) {
  const def = BOATCAST_DATA_TYPES[dataType];
  if (!def) throw new Error(`Unknown BOATCAST data type: ${dataType}`);
  const hd = String(raceDate).replace(/-/g, '');
  const vc = String(venueCode).padStart(2, '0');
  const rn = String(raceNumber).padStart(2, '0');
  switch (def.code) {
    case 'waku10':
      return `${BOATCAST_BASE}/${vc}/bc_j_waku10_${hd}_${vc}_${rn}.txt`;
    case 'str3':
      return `${BOATCAST_BASE}/${vc}/bc_j_str3_${hd}_${vc}_${rn}.txt`;
    case 'str2':
      return `${BOATCAST_BASE}/${vc}/bc_j_str2_${hd}_${vc}_${rn}.txt`;
    default:
      throw new Error(`URL builder not implemented for ${dataType}`);
  }
}

function buildCacheKey(dataType, venueCode, raceDate, raceNumber) {
  return `${dataType}_${venueCode}_${raceDate}_${raceNumber}`;
}

function getTtl(dataType) {
  const def = BOATCAST_DATA_TYPES[dataType];
  if (!def) return 30 * 60 * 1000;
  if (def.ttl != null) return def.ttl;
  return UPDATE_POLICIES[def.updatePolicy] ?? 30 * 60 * 1000;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ============================================================
// HTTP取得(リトライ付き)
//
// 429: 指数バックオフで待機(連続リトライしない)
// 403: リトライせず即座にエラー
// 404: リトライせず即座にエラー
// 5xx: 指数バックオフでリトライ
// 無限リトライ禁止(MAX_RETRIESまで)
// 認証回避・Cookie偽装等は行わない(通常の公開HTTPアクセスのみ)
// ============================================================
async function fetchWithRetry(url) {
  let lastError = null;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': USER_AGENT },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      diagnostics.http_status = res.status;

      if (res.status === 200) {
        const text = await res.text();
        return { ok: true, status: 200, text };
      }
      if (res.status === 404) {
        return { ok: false, status: 404, error: 'Not Found (404)' };
      }
      if (res.status === 403) {
        return { ok: false, status: 403, error: 'Forbidden (403)' };
      }
      if (res.status === 429) {
        if (attempt < MAX_RETRIES) {
          const wait = Math.min(10000, 1000 * 2 ** attempt);
          await sleep(wait);
          continue;
        }
        return { ok: false, status: 429, error: 'Rate Limited (429)' };
      }
      if (res.status >= 500) {
        if (attempt < MAX_RETRIES) {
          await sleep(Math.min(5000, 1000 * 2 ** attempt));
          continue;
        }
        return { ok: false, status: res.status, error: `Server Error (${res.status})` };
      }
      return { ok: false, status: res.status, error: `HTTP ${res.status}` };
    } catch (e) {
      lastError = e;
      if (attempt < MAX_RETRIES) {
        await sleep(Math.min(5000, 1000 * 2 ** attempt));
        continue;
      }
      diagnostics.http_status = null;
      return { ok: false, status: null, error: e.message };
    }
  }
  return { ok: false, status: null, error: lastError?.message || 'Max retries exceeded' };
}

// ============================================================
// 共通取得関数
//
// 責務: URL生成・HTTP GET・ステータス確認・タイムアウト・
//       レスポンス取得・エラー処理・簡易キャッシュ・取得時刻記録・データソース記録
//
// 同一 race_date + venue_code + race_number + data_type の
// 短時間に同じデータの重複取得を防止する
// ============================================================
export async function fetchBoatcastText({ venueCode, raceDate, raceNumber, dataType }) {
  const url = buildUrl(dataType, venueCode, raceDate, raceNumber);
  const cacheKey = buildCacheKey(dataType, venueCode, raceDate, raceNumber);
  const ttl = getTtl(dataType);

  // キャッシュ確認(同一データへの連続アクセス防止)
  const cached = cache.get(cacheKey);
  if (cached && (ttl === Infinity || Date.now() - cached.fetchedAt < ttl)) {
    diagnostics.cache = 'HIT';
    diagnostics.last_fetch = new Date(cached.fetchedAt).toISOString();
    diagnostics.last_url = url;
    diagnostics.data_type = dataType;
    diagnostics.connection_status = 'OK';
    diagnostics.last_error = null;
    diagnostics.http_status = cached.httpStatus;
    return {
      ok: true,
      text: cached.text,
      metadata: {
        source: 'BOATCAST',
        source_url: url,
        fetched_at: new Date(cached.fetchedAt).toISOString(),
        race_date: raceDate,
        venue_code: venueCode,
        race_number: raceNumber,
        data_type: dataType,
        cache: 'HIT',
        http_status: cached.httpStatus,
      },
    };
  }

  // 同一URL同時リクエスト制御(重複排除)
  if (inFlight.has(cacheKey)) {
    return inFlight.get(cacheKey);
  }

  const promise = (async () => {
    diagnostics.last_url = url;
    diagnostics.data_type = dataType;
    diagnostics.cache = 'MISS';

    const result = await fetchWithRetry(url);
    diagnostics.last_fetch = new Date().toISOString();

    if (result.ok) {
      cache.set(cacheKey, {
        text: result.text,
        fetchedAt: Date.now(),
        httpStatus: result.status,
      });
      diagnostics.connection_status = 'OK';
      diagnostics.last_error = null;
      return {
        ok: true,
        text: result.text,
        metadata: {
          source: 'BOATCAST',
          source_url: url,
          fetched_at: new Date().toISOString(),
          race_date: raceDate,
          venue_code: venueCode,
          race_number: raceNumber,
          data_type: dataType,
          cache: 'MISS',
          http_status: result.status,
        },
      };
    } else {
      diagnostics.connection_status = 'ERROR';
      diagnostics.last_error = result.error;
      return {
        ok: false,
        error: result.error,
        status: result.status,
        metadata: {
          source: 'BOATCAST',
          source_url: url,
          fetched_at: new Date().toISOString(),
          race_date: raceDate,
          venue_code: venueCode,
          race_number: raceNumber,
          data_type: dataType,
          cache: 'MISS',
          http_status: result.status,
        },
      };
    }
  })();

  inFlight.set(cacheKey, promise);
  try {
    return await promise;
  } finally {
    inFlight.delete(cacheKey);
  }
}

// ============================================================
// 診断情報取得(管理者・開発確認用)
// ============================================================
export function getBoatcastDiagnostics() {
  return { ...diagnostics };
}

// キャッシュクリア(管理者用)
export function clearBoatcastCache() {
  const count = cache.size;
  cache.clear();
  return { cleared: true, cleared_count: count, timestamp: new Date().toISOString() };
}

export { BOATCAST_DATA_TYPES, UPDATE_POLICIES };