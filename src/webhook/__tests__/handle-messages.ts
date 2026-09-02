import type { WebhookEvent, messagingApi } from '@line/bot-sdk';
import type { WebhookHandler } from '../handler';

/**
 * 測試輔助（T-033b）：只取 `handleEvent` 的訊息陣列。
 *
 * D-025 §4.1 把回傳型別自 `Message[]` 改為 `{ messages, relatedEventId }`（`server.ts` 需要
 * 後者才能寫 `message_event_map`）。既有測試絕大多數只關心「回了什麼字」，故以本 helper 保留
 * 原本的斷言寫法；**要驗錨點的測試請直接呼叫 `handleEvent` 並斷言 `relatedEventId`**
 * （見 D-029 AC-17／AC-22）。
 */
export async function handleMessages(
  handler: WebhookHandler,
  event: WebhookEvent,
): Promise<messagingApi.Message[]> {
  return (await handler.handleEvent(event)).messages;
}
