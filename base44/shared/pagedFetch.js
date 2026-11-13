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
  let cursor = null;
  for (let page = 0; page < maxPages; page += 1) {
    let result = null;
    try {
      result = await fetchPage(query, { sort, limit: pageSize, ...(cursor ? { cursor } : {}) });
    } catch {
      return { rows, complete: false };
    }
    // ページ形式でない応答は、読み切れたか判断できないため未完了として扱う
    if (isUnexpectedResponse(result)) return { rows, complete: false };
    rows.push(...result.items);
    if (result.has_more !== true) return { rows, complete: true };
    // 続きがあるのにカーソルが無い・空ページの場合は読み切れていない
    if (!result.next_cursor || !result.items.length) return { rows, complete: false };
    cursor = result.next_cursor;
  }
  // ページ上限に達した場合も読み切れていない
  return { rows, complete: false };
}