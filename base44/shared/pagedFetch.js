// ============================================================
// SDKのページ形式({items, next_cursor, has_more})に沿って全件を読み切る共通処理。
// 画面(証跡の読み込み)と日次照合の両方がこの1か所を使う。
//
// 取得が途中で止まった場合は complete=false を返す:
//   - 例外                     … 取得そのものに失敗
//   - 想定外の応答             … 配列・null・itemsが配列でない など
//   - 続きがあるのにカーソルが無い・空ページ / ページ上限
// 呼び出し側は complete=false の結果を判定に使わず、保留とする。
// ============================================================

const PAGE_SIZE = 200;
const MAX_PAGES = 50;

// 想定外の応答かどうか(ページ形式になっていない)
const isUnexpectedResponse = (result) => !result
  || typeof result !== 'object'
  || Array.isArray(result)
  || !Array.isArray(result.items);

// fetchPage は (query, options) を受け取る取得関数を渡す
// (エンティティのメソッドをそのまま渡すと this を失うため、呼び出し側で包む)
export async function fetchAllPaged(fetchPage, query, options = {}) {
  const sort = options.sort || '-created_date';
  const pageSize = options.pageSize || PAGE_SIZE;
  const maxPages = options.maxPages || MAX_PAGES;
  const rows = [];
  const cursors = new Set();
  const ids = new Set();
  const incomplete = (error) => ({ rows, complete: false, error });
  let cursor = null;
  for (let page = 0; page < maxPages; page += 1) {
    let result = null;
    let timer;
    try {
      result = await Promise.race([
        fetchPage(query, { sort, limit: pageSize, ...(cursor ? { cursor } : {}) }),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('page_timeout')), options.pageTimeoutMs || 10000); }),
      ]);
    } catch {
      return incomplete('page_read_failed_or_timed_out');
    } finally {
      clearTimeout(timer);
    }
    if (isUnexpectedResponse(result) || typeof result.has_more !== 'boolean') return incomplete('page_format_invalid');
    for (const row of result.items) {
      if (!row || typeof row !== 'object' || Array.isArray(row) || typeof row.id !== 'string' || !row.id || ids.has(row.id)) {
        return incomplete('page_row_invalid_or_repeated');
      }
      ids.add(row.id);
      rows.push(row);
    }
    if (result.has_more === false) return result.next_cursor ? incomplete('terminal_cursor_invalid') : { rows, complete: true };
    if (typeof result.next_cursor !== 'string' || !result.next_cursor || !result.items.length || cursors.has(result.next_cursor)) {
      return incomplete('continuation_invalid_or_repeated');
    }
    cursors.add(result.next_cursor);
    cursor = result.next_cursor;
  }
  return incomplete('page_safety_limit');
}