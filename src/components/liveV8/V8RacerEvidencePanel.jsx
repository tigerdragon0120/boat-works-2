import React, {useState} from 'react';
import {racerEvidenceView, exhibitionParameterComparison, parameterPercent, parameterTime,
  parameterRank, parameterSample, parameterPeriod, parameterDate} from './v8RacerEvidenceView';

const METHODS = ['逃げ', '差し', 'まくり', 'まくり差し', '抜き', '恵まれ'];
const number = value => typeof value === 'number' && Number.isFinite(value);
const COUNT_LABEL = value => Number.isInteger(value) && value >= 0 ? value : '—';
const sourceUrl = source => {
  try { const url = new URL(source?.source_url); return url.protocol === 'https:' && ['boatrace.jp', 'www.boatrace.jp'].includes(url.hostname) ? url.href : null; }
  catch { return null; }
};

function CourseCells({row}) {
  return <>
    <td className="px-2 py-2.5 tabular-nums">{parameterSample(row?.sample_size)}</td>
    <td className="px-2 py-2.5 tabular-nums">{parameterPercent(row?.first_rate)}</td>
    <td className="px-2 py-2.5 tabular-nums">{parameterPercent(row?.top2_rate)}</td>
    <td className="px-2 py-2.5 tabular-nums">{parameterPercent(row?.top3_rate)}</td>
    <td className="px-2 py-2.5 tabular-nums">{parameterTime(row?.avg_st)}</td>
    <td className="px-2 py-2.5 tabular-nums">{parameterRank(row?.avg_st_rank)}</td>
  </>;
}

function SourcePeriod({source}) {
  const href = sourceUrl(source);
  return <p className="text-[10px] leading-5 text-slate-500">公式期別成績 · 集計 {parameterPeriod(source)}
    {href && <a href={href} target="_blank" rel="noopener noreferrer" className="ml-2 font-semibold text-sky-700 underline underline-offset-2">取得元</a>}
  </p>;
}

function FrameTendencies({row}) {
  const evidence = row?.frame_tendencies;
  const frames = evidence?.frames && typeof evidence.frames === 'object' ? evidence.frames : {};
  const known = evidence?.status === 'READY' && Object.values(frames).some(frame => Number.isInteger(frame?.sample_size) && frame.sample_size > 0);
  const first = parameterDate(evidence?.first_race_date), last = parameterDate(evidence?.last_race_date);
  const start = parameterDate(evidence?.window_start), end = parameterDate(evidence?.window_end);
  return <section className="mt-4 rounded-lg border border-slate-200 bg-slate-50 p-3" aria-label="艇番別のアプリ蓄積成績">
    <h6 className="text-xs font-bold text-slate-800">艇番別の傾向 · アプリ蓄積分</h6>
    <p className="mt-1 text-[10px] leading-5 text-slate-500">こちらは出走時の艇番別です。全国全走を網羅する成績ではなく、6艇の確定着順を確認できたレースを集計しています。</p>
    {start && end && <p className="mt-1 text-[10px] leading-5 text-slate-500">対象 {start}〜{end}{first && last ? ` · 実際の蓄積 ${first}〜${last}` : ''}</p>}
    {!known ? <p className="mt-2 rounded-lg bg-white px-3 py-2 text-xs font-semibold text-slate-600">{evidence?.status === 'READ_FAILED' || evidence?.status === 'UNAVAILABLE' ? 'この予想時点の艇番別データは未取得です。' : '艇番別データを蓄積中です。'}</p> : <>
      <div className="mt-2 overflow-x-auto rounded-lg border border-slate-200 bg-white">
        <table className="w-full min-w-[500px] text-left text-[11px] text-slate-600">
          <caption className="sr-only">{row.player_name}の艇番別成績と決まり手確認済み勝利数</caption>
          <thead className="bg-slate-50 text-[10px] text-slate-500"><tr>{['艇番', '出走数', '1着率', '2連対率', '3連対率', '決まり手確認済み勝利数・内訳'].map(label => <th key={label} scope="col" className="whitespace-nowrap px-2 py-2 font-semibold">{label}</th>)}</tr></thead>
          <tbody>{Array.from({length: 6}, (_, index) => {
            const frame = index + 1, saved = frames[String(frame)], sample = saved?.sample_size;
            const wins = saved?.known_method_wins;
            const methods = METHODS.filter(method => number(saved?.winning_methods?.[method]) && saved.winning_methods[method] > 0)
              .map(method => `${method}${saved.winning_methods[method]}`).join('・');
            return <tr key={frame} className={`border-t border-slate-100 ${frame === row.boat_number ? 'bg-sky-50/60' : ''}`}>
              <th scope="row" className="whitespace-nowrap px-2 py-2.5 font-semibold text-slate-700">{frame}号艇{frame === row.boat_number ? ' · 今回' : ''}</th>
              <td className="px-2 py-2.5 tabular-nums">{sample > 0 ? `${sample}走` : '蓄積中'}</td>
              <td className="px-2 py-2.5 tabular-nums">{sample > 0 ? parameterPercent(saved.first_rate) : '—'}</td>
              <td className="px-2 py-2.5 tabular-nums">{sample > 0 ? parameterPercent(saved.top2_rate) : '—'}</td>
              <td className="px-2 py-2.5 tabular-nums">{sample > 0 ? parameterPercent(saved.top3_rate) : '—'}</td>
              <td className="px-2 py-2.5 text-[10px] leading-5">{wins > 0 ? `${wins}勝 · ${methods || '内訳未確認'}` : '勝利データを蓄積中'}</td>
            </tr>;
          })}</tbody>
        </table>
      </div>
      <p className="mt-2 text-[10px] leading-5 text-slate-500">決まり手は、確認できた勝利の内訳です。1着率を逃げ率として扱いません。この蓄積値は現在の展開評価への加点には使っていません。</p>
    </>}
  </section>;
}

export default function V8RacerEvidencePanel({forecast, scenario}) {
  const view = racerEvidenceView(forecast, scenario?.leader);
  const [detailSelection, setDetailSelection] = useState(null);
  if (!forecast) return null;
  const context = `${forecast.id || forecast.forecast_key || ''}:${scenario?.leader || ''}`;
  const detailBoat = detailSelection?.context === context ? detailSelection.boat : scenario?.leader;
  const detail = view.rows.find(row => row.boat_number === detailBoat) || view.leader || view.rows[0];
  const leader = view.leader;
  const comparison = exhibitionParameterComparison(leader, forecast);
  const source = leader?.source;
  const metrics = [
    ['出走数', parameterSample(leader?.sample_size)], ['1着率', parameterPercent(leader?.raw?.first_rate)],
    ['2連対率', parameterPercent(leader?.raw?.top2_rate)], ['3連対率', parameterPercent(leader?.raw?.top3_rate)],
    ['平均ST', parameterTime(leader?.raw?.avg_st)], ['平均ST順位', parameterRank(leader?.raw?.avg_st_rank)],
  ];
  return <section aria-label="選手のコース別パラメーター" className="mt-3 rounded-xl border border-sky-200 bg-white p-3 sm:p-4">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h5 className="text-xs font-black text-sky-900">選手のコース別パラメーター</h5>
      <span className="rounded-full bg-sky-50 px-2 py-0.5 text-[10px] font-semibold text-sky-800">{view.legacy ? '詳細未保存' : '予想時点の記録'}</span>
    </div>
    {view.legacy ? <p className="mt-2 text-xs leading-6 text-slate-500">当時の詳細パラメーター未保存。この予想には、後から取得した選手データを追加していません。</p> : !leader ? <p className="mt-2 text-xs leading-6 text-slate-500">この展開の選手パラメーターを確認できません。</p> : <>
      <div className="mt-3 flex flex-wrap items-start justify-between gap-2">
        <p className="min-w-0 text-sm font-bold text-slate-900">{leader.boat_number}号艇 {leader.player_name}<span className="ml-2 inline-block text-[10px] font-medium text-slate-500">登録 {leader.registration_number || '未取得'}</span></p>
        <span className="text-[11px] font-semibold text-sky-800">参照：{leader.selected_course ?? '—'}コース{leader.selected_course_basis === 'EXHIBITION_CONFIRMED' ? ' · 展示進入' : ' · 想定進入'}</span>
      </div>
      <div className="mt-2 grid grid-cols-3 gap-1.5">
        {metrics.map(([label, value]) => <div key={label} className="rounded-lg bg-slate-50 px-2 py-2"><p className="text-[10px] leading-4 text-slate-500">{label}</p><p className="mt-1 text-base font-bold tabular-nums text-slate-800">{value}</p></div>)}
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1">
        {leader.small_sample && <span className="rounded bg-amber-50 px-1.5 py-0.5 text-[10px] font-semibold text-amber-800">少数データ · 20走未満</span>}
        {leader.sample_size === 0 && <span className="text-[10px] font-semibold text-slate-500">このコースの出走なし</span>}
        {!leader.available && leader.sample_size !== 0 && <span className="text-[10px] font-semibold text-slate-500">コース成績未取得</span>}
        {source && <SourcePeriod source={source}/>}
      </div>
      <p className="mt-1 text-[10px] leading-5 text-slate-500">実際の進入コース別の実績です。艇番別成績や、このレースの的中確率とは異なります。</p>
      {leader.available && leader.scoring?.used_for_scoring !== true && <p className="mt-1 text-[10px] leading-5 text-amber-800">この選手の今回コースに使える詳細指標がないため、コース別パラメーターによる補正を適用していません。</p>}
      {comparison && <div className="mt-3 rounded-lg border border-sky-100 bg-sky-50/50 px-3 py-2">
        <p className="text-[11px] font-bold text-sky-900">{comparison.course_label}</p>
        <p className="mt-1 text-[11px] leading-5 text-slate-700">コース平均ST <strong className="tabular-nums">{parameterTime(comparison.average)}</strong> ／ 今回展示ST <strong className="tabular-nums">{comparison.exhibition}</strong>
          {comparison.difference !== null && <span className="ml-1 text-slate-500">（差 {comparison.difference >= 0 ? '+' : ''}{comparison.difference.toFixed(2)}秒）</span>}
        </p>
        <p className="mt-1 text-[10px] leading-5 text-slate-500">{comparison.same_profile ? '事前と同じコース別成績で展示を比較しています。' : source ? '展示後時点に保存したコース別成績を参照しています。' : '選手のコース成績は未取得です。'} 展示STは本番STと区別します。</p>
        {view.evidence?.change_note && <p className="mt-1 text-[10px] leading-5 text-slate-500">{view.evidence.change_note}</p>}
      </div>}
    </>}
    {!!view.rows.length && <details className="mt-3 border-t border-slate-100 pt-3">
      <summary className="cursor-pointer text-xs font-bold text-sky-800">6選手の比較・コース別の詳細を見る</summary>
      <p className="mt-3 text-[11px] font-semibold text-slate-700">今回の参照コースで比較</p>
      <div className="mt-2 overflow-x-auto rounded-lg border border-slate-200">
        <table className="w-full min-w-[570px] text-left text-[11px] text-slate-600">
          <caption className="sr-only">6選手の今回の進入コース別パラメーター</caption>
          <thead className="bg-slate-50 text-[10px] text-slate-500"><tr>{['艇・選手', 'コース', '出走数', '1着率', '2連対率', '3連対率', '平均ST', 'ST順位'].map(label => <th scope="col" key={label} className="whitespace-nowrap px-2 py-2 font-semibold">{label}</th>)}</tr></thead>
          <tbody>{view.rows.map(row => <tr key={row.boat_number} className={`border-t border-slate-100 ${row.boat_number === scenario?.leader ? 'bg-sky-50/60' : ''}`}>
            <th scope="row" className="whitespace-nowrap px-2 py-2.5 font-semibold text-slate-700">{row.boat_number} {row.player_name}{!row.active ? '（欠場）' : ''}</th>
            <td className="px-2 py-2.5">{row.selected_course ?? '—'}</td>
            <CourseCells row={{...row.raw, sample_size: row.sample_size}}/>
          </tr>)}</tbody>
        </table>
      </div>
      {detail && <>
        <div className="mt-4 flex flex-wrap items-center justify-between gap-2">
          <label className="text-[11px] font-bold text-slate-700">選手ごとの全6コース
            <select aria-label="コース別成績を表示する選手" value={detail.boat_number} onChange={event => setDetailSelection({context, boat: Number(event.target.value)})} className="ml-2 max-w-full rounded-lg border border-slate-200 bg-white px-2 py-2 text-xs font-semibold text-slate-800">
              {view.rows.map(row => <option key={row.boat_number} value={row.boat_number}>{row.boat_number}号艇 {row.player_name}</option>)}
            </select>
          </label>
        </div>
        <p className="mt-2 text-[10px] leading-5 text-slate-500">登録 {detail.registration_number || '未取得'} · 数字は実績値です。少数データは全体の同じコースの平均に寄せて評価します。</p>
        {detail.courses.length ? <div className="mt-2 overflow-x-auto rounded-lg border border-slate-200">
          <table className="w-full min-w-[490px] text-left text-[11px] text-slate-600">
            <caption className="sr-only">{detail.player_name}の全6コース成績</caption>
            <thead className="bg-slate-50 text-[10px] text-slate-500"><tr>{['コース', '出走数', '1着率', '2連対率', '3連対率', '平均ST', 'ST順位'].map(label => <th key={label} scope="col" className="whitespace-nowrap px-2 py-2 font-semibold">{label}</th>)}</tr></thead>
            <tbody>{detail.courses.map(row => <tr key={row.course} className={`border-t border-slate-100 ${row.course === detail.selected_course ? 'bg-sky-50/60' : ''}`}>
              <th scope="row" className="whitespace-nowrap px-2 py-2.5 font-semibold text-slate-700">{row.course}{row.course === detail.selected_course ? ' · 今回参照' : ''}</th>
              <CourseCells row={row}/>
            </tr>)}</tbody>
          </table>
        </div> : <p className="mt-2 rounded-lg bg-slate-50 p-3 text-xs text-slate-500">この選手の全6コース成績は未取得です。</p>}
        {detail.source && <div className="mt-2"><SourcePeriod source={detail.source}/></div>}
        {detail.available && <p className="mt-2 text-[10px] leading-5 text-slate-500">今回の実績：1着 {COUNT_LABEL(detail.profile?.courses?.[String(detail.selected_course)]?.first_count)}回 / 2着 {COUNT_LABEL(detail.profile?.courses?.[String(detail.selected_course)]?.second_count)}回 / 3着 {COUNT_LABEL(detail.profile?.courses?.[String(detail.selected_course)]?.third_count)}回。
          {number(detail.adjusted?.first_rate) && <> 母数を補正した1着の評価用値 {parameterPercent(detail.adjusted.first_rate)}。</>}
        </p>}
        <FrameTendencies row={detail}/>
      </>}
    </details>}
  </section>;
}
