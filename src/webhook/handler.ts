import type { WebhookEvent, messagingApi } from '@line/bot-sdk';

/**
 * M0 echo bot：把收到的文字訊息原樣回覆。
 *
 * 刻意設計成純函式（輸入事件 → 輸出回覆訊息陣列），不觸網、不依賴 client，
 * 方便單元測試。M1 之後這裡會換成 command parser（+N / -N / 名單 / 開團…）。
 */
export function buildReplies(event: WebhookEvent): messagingApi.Message[] {
  if (event.type === 'message' && event.message.type === 'text') {
    return [{ type: 'text', text: event.message.text }];
  }
  // 其餘事件（sticker、follow、join…）一律忽略，不回覆，避免洗版。
  return [];
}
