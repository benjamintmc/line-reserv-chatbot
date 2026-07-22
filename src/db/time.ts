/**
 * 時間戳共用 helper（G11 / D-001 §0）。
 * 一律以 UTC ISO-8601（秒精度、以 `Z` 結尾）字串輸出，格式為
 * `YYYY-MM-DDTHH:MM:SSZ`（無毫秒、無空格），符合 AC-13 的正規式。
 * 時間戳一律於應用層（repository / migrate runner）顯式寫入，
 * TEXT 時間欄不使用 SQLite `DEFAULT CURRENT_TIMESTAMP`。
 */
export function nowIso(): string {
  // toISOString() 產生 `...SS.mmmZ`；去掉毫秒段以符合本專案自訂的秒精度 ISO 格式。
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}
