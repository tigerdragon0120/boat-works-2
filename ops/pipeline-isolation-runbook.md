# 取得とV8予想の独立実行 — 適用手順

## 状態と適用対象

この文書とJSONはレビュー・検証済みの計画です。本担当はGETとvalidate-definitionだけを実施しました。PUT・状態変更・実行はroot担当です。

| 役割 | 既存workflow | 変更前 | 変更後 |
| --- | --- | --- | --- |
| 取得 | Daily Auto Update / 6aa2c291cea454b2c3e09261 | auto_update → capture_forecasts、active | auto_update 1step、active |
| 予想 | V8 Two Stage Forecasts / 6b027f5cb1e51751ca879490 | capture 1step、inactive、+2分 | capture 1step、active、+1分 |

- collector: 毎時00/05/10/…/55分、06:00〜23:55 JST。cronは既存値を維持。
- forecast: 毎時01/06/11/…/56分、06:01〜23:56 JST。
- 通常のバックエンド呼出回数は2回/5分のまま。第三ジョブ・新workflowは作成しない。
- 独立化によりworkflow run数は1回/5分から2回/5分になる。バックエンド呼出数と課金単位は同一と決めつけない。
- 予想側のHTTP/worker例外は予想workflowのfailed runとして残す。無条件200変換やtry/catchの未対応フィールドを使わない。

## +1分を採る理由

| 項目 | +1分 | +2分 |
| --- | --- | --- |
| 取得17〜26秒という観測値から予想開始まで | 34〜43秒 | 94〜103秒 |
| collectorの80秒全体予算との関係 | 最長20秒重なり得る | 予算どおりなら40秒余裕 |
| 締切90秒guardに使える余裕 | +2分より60秒多い | +1分より60秒少ない |
| 主な利点 | 締切近くの保存済み展示を使う機会を残す | 取得全体との重なりを減らす |

取得は展示30秒・odds18秒の予算を先行し、その後にmaintenanceを実行する。実績17〜26秒と締切条件を踏まえ、+1分を推奨・採用案とする。

例えば10:00に取得、10:03締切なら、10:01の予想開始は残り120秒で入口guardを通れるが、10:02では残り60秒のため通れない。処理途中・保存前にもguardがあるため、+1分でも保存を保証するものではない。

数式では、取得の予定開始時刻をT、締切をD、予想開始後に対象レースを処理するまでの時間をFとすると、保存候補となる目安は D > T + 位相差 + F + 90秒。+1分は+2分より60秒の余裕を残す。

固定位相は「取得完了後」を保証する依存関係ではない。起動遅延・遅い取得・保存途中なら重なる可能性がある。予想は保存済みデータの完全性と時刻を検証し、不足・古いodds・締切に達した候補を保留する。次回は通常の5分周期で再確認する。完了待機・即時再試行・追加呼出は加えない。

## コード側の適用前条件

rootによる次のcollector修正が本番に反映済みであることを確認してから切り替える。

- AUTOは1回の80秒絶対予算を使う。
- 展示30秒、odds18秒の優先順を維持する。
- 全体失敗後の8秒sleepと45秒AUTO再実行を撤去する。
- source/read失敗はraceまたはphase単位で記録する。
- scheduled AUTOは入力保存のみ。inline V8生成を呼ばない。
- forecastの完全性・入力時点・odds鮮度・締切90秒guardを維持する。

## 正式APIの性質

公式Update workflow契約では、PUTは省略したフィールドを保持し、定義変更で新しいimmutable versionを作る。PUTだけではactive/inactiveは変わらない。更新・状態変更はmain branchで行う。

実行中runは開始時の定義を保つ。mainの定義から後段captureを削除しても、すでに開始した旧runのcaptureは残る。そのため新forecastを有効化する前に、旧main runが終わったことを確認する。

base_version_idを付けると定義versionの競合はworkflow_version_conflictとして拒否される。ただし、これだけでtrigger/statusの同時変更まで保護されると考えない。直前GETでtrigger/statusも確認する。

toggle-statusはstatus=active/inactiveを明示できる。値を省略する反転操作は使わない。応答statusとGETのstatusを確認する。

## 推奨切替順序

1. 両workflowをGETし、before JSONとdefinition、current_version_id、trigger、statusを照合する。forecastがinactiveであることを確認する。差分があれば上書きせず再レビューする。
2. forecastがinactiveのまま、forecast.put.jsonを使って既存forecast IDへPUTする。base_version_idはレビュー時の値を使用する。GETで1step、関数名、args、+1分cron、inactive、新versionを確認する。
3. mainの通常run完了後かつ次の5分tickまで余裕のある時点を選び、mainをstatus=inactiveへ設定する。GETでinactiveを確認する。これで新しい旧chainのdispatchを止める。
4. GET runs?status=runningでmainとforecastに実行中runがないことを確認する。旧main runが残っていれば完了を待つ。自動cancelや追加runはしない。状態変更だけで旧runが止まったとは扱わない。
5. collector.put.jsonを使い、mainの既存IDを取得1stepへPUTする。collector PUTにはtriggerを送らず、既存cronを保持する。GETでauto_updateだけ、args.step=auto、then=end、inactive、既存cron、新versionを確認する。
6. mainをstatus=activeにし、GETで取得1step・activeを確認する。
7. forecastをstatus=activeにし、GETで予想1step・+1分cron・activeを確認する。旧main captureが残ったままforecastを先に有効化しない。
8. 両方の実GET応答からbefore JSONと同じフィールドを取り出し、collector.after.actual.json / forecast.after.actual.jsonとしてopsに保存する。作成者連絡先や会話コンテキストは含めない。planned JSONのnull version hashを実値と取り違えない。
9. 次の自然なcron実行を確認する。mainはauto_updateのみ、forecastはcaptureのみ。各runのstatus、version、入力保存時刻、保存したFINAL/PRE、partial/held/error理由を確認する。検証目的のrun-nowは追加しない。

更新前のcurrent_version_id:

- collector: 609e6827d4cd78fd1ab8d84fdfe01f8ecfaa7e63e3d9fe7823be9939657aad52
- forecast: 468a9df0d4187e0ce803ce7d4588f27dffaa80ce382f2769fe5fa77d4c8db2cb

予定document.version:

- collector: 1.3.0
- forecast: 1.2.0

変更後のcurrent_version_idはプラットフォームがPUT後に返す。事前に推定したhashを保存済みversionとして扱わない。

## 正式API呼出形（root用、未実行）

```text
PUT /api/apps/{app_id}/workflows/{workflow_id}
body = collector.put.json または forecast.put.json

POST /api/apps/{app_id}/workflows/{workflow_id}/toggle-status
params = { app_id, workflow_id, status: "inactive" | "active" }

GET /api/apps/{app_id}/workflows/{workflow_id}
GET /api/apps/{app_id}/workflows/{workflow_id}/runs
params = { app_id, workflow_id, status: "running", limit: 20, offset: 0 }
```

runningが20件に達した場合はoffsetで最後まで確認する。応答切詰め・取得失敗を「実行中なし」と扱わない。

## 途中失敗とロールバック

- forecastの準備PUTが失敗した場合: forecastはinactiveのまま。mainの旧chainを継続し、切替を進めない。
- mainのPUTが失敗した場合: forecastがinactiveであることを確認した上で、mainを元の定義でactiveへ戻せる。version conflictの場合は再GET・再レビューが先。
- 取得1step化後にforecastの有効化だけ失敗した場合: 取得側はactiveで継続させる。forecastの実statusを読み、明示status=activeを安全に再試行する。失敗を取得側へ戻さない。
- 旧2stepへ戻す場合: 先にforecastをinactiveにしてそのrunを完了させる。その後mainをpause・drainし、現時点のbase_version_idを付けてcollector.before.jsonのdefinitionを復元し、mainだけをactiveにする。forecastが動作中または状態不明のまま旧captureを復元しない。
- 予想に失敗が続けば、予想側だけが自動inactiveになり得る。履歴とconsecutive_failuresを残す。独立化は共通DB/クォータ等の全体障害まで解消するものではない。

## 検証と根拠

collector.validation.json と forecast.validation.json は、definitionとtriggerを正式validate-definitionへ送った結果で、どちらもvalid=true、warnings/errorsなし。

一次資料:

- Update workflow: https://docs.base44.com/api-reference/update-workflow-not-imported-apps
- Workflow API overview/status: https://docs.base44.com/developers/references/apps-api/sections/workflows
- Base44 official workflow guide/version binding: https://github.com/base44/skills/blob/main/skills/base44-platform-workflows/references/backend-functions.md

このファイルをbase44/workflows配下へ移さない。ops配下のレビュー用JSONであり、ファイル同期による新workflow作成を意図しない。
