// ============================================================
// SDKのページ形式({items, next_cursor, has_more})に沿って全件を読み切る共通処理。
// 取得が途中で止まった場合(例外・カーソル欠落・ページ上限)は complete=false を返す。
// 呼び出し側は complete=false の結果を判定に使わず、保留とする。
// ============================================================

const PAGE_SIZE = 200;
const MAX_PAGES = 50;

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
    const items = Array.isArray(result) ? result : (result?.items || []);
    rows.push(...items);
    const more = !Array.isArray(result) && result?.has_more === true;
    const next = Array.isArray(result) ? null : result?.next_cursor;
    if (!more) return { rows, complete: true };
    // 続きがあるのにカーソルが無い・空ページの場合は読み切れていない
    if (!next || !items.length) return { rows, complete: false };
    cursor = next;
  }
  // ページ上限に達した場合も読み切れていない
  return { rows, complete: false };
}