// RaceEntryの選手名は「氏名 + 支部/出身地」が連結されて保存される場合がある。
// 画面表示用に 氏名・支部・出身地 へ分解する共通ユーティリティ。
const BRANCH_PATTERN = /^(.*?)[\s　]*(北海道|青森|岩手|宮城|秋田|山形|福島|茨城|栃木|群馬|埼玉|千葉|東京|神奈川|新潟|富山|石川|福井|山梨|長野|岐阜|静岡|愛知|三重|滋賀|京都|大阪|兵庫|奈良|和歌山|鳥取|島根|岡山|広島|山口|徳島|香川|愛媛|高知|福岡|佐賀|長崎|熊本|大分|宮崎|鹿児島|沖縄)(\/.+)$/;

export function parseRacerIdentity(value) {
  const raw = String(value || "").trim();
  const match = raw.match(BRANCH_PATTERN);
  if (!match) return { name: raw, branch: "", birthplace: "" };
  return {
    name: match[1].trim(),
    branch: match[2],
    birthplace: match[3].replace(/^\//, "").trim(),
  };
}

export function formatRacerDisplayName(value) {
  const raw = String(value || "").trim();
  const match = raw.match(BRANCH_PATTERN);
  return match ? `${match[1]}　${match[2]}${match[3]}` : raw;
}