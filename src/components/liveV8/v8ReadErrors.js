const INCOMPLETE_MESSAGE = 'データを最後まで確認できないため表示を保留しました。再読込してください。';
const INVALID_RESPONSE_MESSAGE = '必要な記録をすべて取得できませんでした。時間を置いて再読込してください。';
const TIMEOUT_MESSAGE = '読込が時間内に完了しませんでした。再読込してください。';
const SCOPE_MESSAGE = '利用者が変わったため、表示を更新してください。';
const SAFE_SERVER_MESSAGES = new Set([INCOMPLETE_MESSAGE, INVALID_RESPONSE_MESSAGE]);
const INVALID_REQUEST_CODES = new Set(['INVALID_JSON', 'INVALID_BODY', 'INVALID_MODE', 'INVALID_RACE', 'INVALID_DATE', 'DAYS_MUST_BE_1_TO_7']);
const statusNumber = value => {
  const number = typeof value === 'number' ? value : typeof value === 'string' && /^\d{3}$/.test(value) ? Number(value) : null;
  return Number.isInteger(number) && number >= 100 && number <= 599 ? number : null;
};
const transientStatus = value => value === 429 || value >= 500;

// Only fixed UI text or the application's known public messages may be shown.
// Provider bodies, stack traces, URLs and request details stay out of the page.
export function dashboardReadErrorState(error) {
  const rawBody = error?.response?.data ?? error?.data;
  const body = rawBody && typeof rawBody === 'object' && !Array.isArray(rawBody) ? rawBody : null;
  const status = statusNumber(error?.response?.status ?? error?.status ?? error?.http_status);
  const message = typeof error?.message === 'string' ? error.message : '';
  const state = (code, text, retryable = false) => ({code, message: text, retryable, status});
  if (body?.ok === false && body.error === 'READ_INCOMPLETE') {
    const innerStatus = statusNumber(body.diagnostic?.http_status);
    const retryable = innerStatus == null || innerStatus < 400 || transientStatus(innerStatus);
    return state('READ_INCOMPLETE', SAFE_SERVER_MESSAGES.has(body.message) ? body.message : INCOMPLETE_MESSAGE, retryable);
  }
  if (body?.ok === false && INVALID_REQUEST_CODES.has(body.error))
    return state('INVALID_REQUEST', '指定した条件でデータを取得できませんでした。画面を再読込してください。');
  if (status === 401) return state('AUTH_REQUIRED', 'ログイン状態を確認できません。もう一度ログインしてください。');
  if (status === 403) return state('FORBIDDEN', 'このデータを閲覧する権限を確認できません。管理者のアカウントでログインしているか確認してください。');
  if (status === 429) return state('RATE_LIMITED', 'アクセスが集中しているため、読み込みを完了できませんでした。少し待って再読込してください。', true);
  if (message === SCOPE_MESSAGE) return state('SCOPE_CHANGED', SCOPE_MESSAGE);
  if (message === INVALID_RESPONSE_MESSAGE || message === INCOMPLETE_MESSAGE) return state('READ_INCOMPLETE', message, true);
  if (message === TIMEOUT_MESSAGE || ['ECONNABORTED', 'ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT'].includes(error?.code)
    || /timed?\s*out|timeout/i.test(message)) return state('TIMEOUT', TIMEOUT_MESSAGE, true);
  if (error?.code === 'ERR_NETWORK' || /\bnetwork\b|failed to fetch|fetch failed|load failed/i.test(message))
    return state('NETWORK', 'サーバーとの通信を完了できませんでした。時間を置いて再読込してください。', true);
  if (status != null && status >= 500) return state('SERVER_UNAVAILABLE', 'サーバー側で読み込みを完了できませんでした。時間を置いて再読込してください。', true);
  if (status != null && status >= 400) return state('INVALID_REQUEST', '指定した条件でデータを取得できませんでした。画面を再読込してください。');
  // An unknown failure can still be transient. Keep the existing retry cadence;
  // only explicit permission/request rejections stop automatic polling.
  return state('READ_FAILED', '保存データの読み込みを完了できませんでした。再読込してください。', true);
}

export const formatDashboardReadError = error => dashboardReadErrorState(error).message;
