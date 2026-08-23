import { createHash } from 'node:crypto';

/**
 * 日誌識別碼去識別化（資安 M5）。
 *
 * LINE 的 `groupId`／`userId` 是**永久且跨群穩定**的識別碼，直接寫進 Cloud Logging 等同
 * 長期保存個資（log 保留期未受本專案控制，且任何具 log 檢視權的人皆可讀）。
 * 除錯真正需要的是「同一個人／同一群」的可比對性，不是原值本身——雜湊即可滿足。
 *
 * 取 SHA-256 前 8 位十六進位：足以在單次事故的 log 範圍內辨識同一主體，
 * 又無法反推回原識別碼（LINE ID 空間遠大於暴力枚舉可行範圍）。
 */
export function redactId(id: string | undefined): string | undefined {
  if (id === undefined || id === '') return undefined;
  return createHash('sha256').update(id).digest('hex').slice(0, 8);
}
