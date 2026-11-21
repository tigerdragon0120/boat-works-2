// V7の正式なサーバー保存記録のみを読み取り、詳細レポートへ渡す。
// 端末ローカル記録・V7以前の検証集計は使用しない。
import React, { useCallback, useEffect, useState } from 'react';
import { base44 } from '@/api/base44Client';
import { groupPredictions, latestPerRecord, rowOrder, jstDate } from '@/lib/v7Verification';
import V7DetailedReport from '@/components/liveV7/V7DetailedReport';
import V7BuyShadowProgress from '@/components/liveV7/V7BuyShadowProgress';
import V7FeatureLab from '@/components/liveV7/V7FeatureLab';

const PAGE_SIZE = 200;
const MAX_PAGES = 100;

async function loadAllRows(entity, query) {
  const rows = [];
  const seenRows = new Set();
  const seenCursors = new Set();
  let cursor;

  for (let pageNumber = 1; pageNumber <= MAX_PAGES; pageNumber++) {
    const response = await entity.filter(query, {
      sort: '-created_date',
      limit: PAGE_SIZE,
      ...(cursor ? { cursor } : {}),
    });

    if (!response || !Array.isArray(response.items) || typeof response.has_more !== 'boolean') {
      throw new Error('取得形式が不正です（ページ ' + pageNumber + '）。');
    }

    for (const row of response.items) {
      if (!row || !row.id || seenRows.has(row.id)) {
        throw new Error('取得データに重複または欠落があります（ページ ' + pageNumber + '）。');
      }
      seenRows.add(row.id);
      rows.push(row);
    }

    if (!response.has_more) {
      if (response.next_cursor != null && response.next_cursor !== '') {
        throw new Error('最終ページの状態が不正です。');
      }
      return rows;
    }

    if (!response.items.length || !response.next_cursor ||
      typeof response.next_cursor !== 'string' || seenCursors.has(response.next_cursor)) {
      throw new Error('全ページを読み切れませんでした（ページ ' + pageNumber + '）。');
    }
    seenCursors.add(response.next_cursor);
    cursor = response.next_cursor;
  }

  throw new Error('取得ページが上限を超えました。');
}

// 1レース×段階につき1組。重複は代表を選ばず保留とする。
// 同じ予想に複数の照合がある場合は、追記された最新判定だけを採用。
function buildGroups(predictions, verifications) {
  const byGroup = groupPredictions(predictions);
  const latest = latestPerRecord(verifications);
  const result = [];

  for (const [key, items] of byGroup) {
    const ordered = [...items].sort(rowOrder);
    const prediction = ordered[0];
    const verification = latest.get(prediction.record_hash) || null;

    let status = 'UNVERIFIED';
    if (ordered.length > 1) status = 'HELD_DUPLICATE';
    else if (verification && verification.verification_version !== 'v2') status = 'LEGACY';
    else if (verification) status = verification.verification_status || 'UNVERIFIED';

    result.push({
      key,
      raceDate: prediction.race_date,
      raceKey: prediction.race_key,
      stage: prediction.stage,
      model: prediction.model || (prediction.is_womens ? 'WOMENS' : 'OPEN'),
      venueCode: String(prediction.venue_code || '').padStart(2, '0'),
      raceNumber: prediction.race_number,
      status,
      prediction,
      verification,
    });
  }

  return result;
}

export default function V7ServerVerification() {
  const [groups, setGroups] = useState(null);
  const [fetchedAt, setFetchedAt] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      const period = { race_date: { $gte: jstDate(-29), $lte: jstDate(0) } };
      const [predictions, verifications] = await Promise.all([
        loadAllRows(base44.entities.PredictionV7, period),
        loadAllRows(base44.entities.PredictionV7Verification, period),
      ]);
      const next = buildGroups(predictions, verifications);
      setGroups(next);
      setFetchedAt(new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' }));
    } catch (err) {
      // 古い数値や誤った0件を最新情報として表示しない。
      setGroups(null);
      setError(err?.message || '検証データを取得できませんでした。');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  if (!groups) {
    return (
      <section className="rounded-xl border border-slate-200 bg-white p-5" data-testid="v7-server-verification">
        {loading ? (
          <div role="status" className="text-sm text-slate-600">サーバー保存済みのV7予想と照合記録を読み込み中…</div>
        ) : (
          <div role="alert" className="space-y-3">
            <p className="font-semibold text-rose-700">V7の正式データを取得できませんでした。</p>
            <p className="text-sm text-slate-600">{error}</p>
            <p className="text-xs text-slate-500">取得に失敗した場合は0件と表示せず、再取得を案内します。</p>
            <button type="button" onClick={load}
              className="min-h-11 rounded-lg border border-slate-300 bg-white px-4 text-sm font-semibold">
              もう一度読み込む
            </button>
          </div>
        )}
      </section>
    );
  }

  return <section data-testid="v7-server-verification">
    {error && <p role="alert" className="mb-3 text-sm text-rose-700">{error}</p>}
    <V7BuyShadowProgress groups={groups} />
    <V7FeatureLab groups={groups} />
    <V7DetailedReport groups={groups} fetchedAt={fetchedAt} onReload={load} loading={loading} />
  </section>;
}
