import { describe, it, expect, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import type { WebhookEvent, messagingApi } from '@line/bot-sdk';
import { buildServer, type ReplyClient } from './server';
import { config } from './config';
import type { WebhookHandler } from './webhook/handler';

/** 以 config.channelSecret（test/setup-env.ts 設 'test-secret'）簽出合法 LINE 簽章。 */
function sign(rawBody: string): string {
  return createHmac('sha256', config.channelSecret).update(rawBody).digest('base64');
}

function webhookBody(): string {
  const event = {
    type: 'message',
    message: { type: 'text', id: 'm1', text: '+1' },
    source: { type: 'group', groupId: 'G', userId: 'U' },
    replyToken: 'rt',
  } as unknown as WebhookEvent;
  return JSON.stringify({ events: [event] });
}

describe('server webhook 時序（D-007 §4 / G3）與健康檢查', () => {
  it('[D-007 AC-4] 先完整處理（含 replyMessage）再回 200：呼叫順序 handle → reply → send(200)', async () => {
    const order: string[] = [];
    const handler: WebhookHandler = {
      handleEvent: async (): Promise<messagingApi.Message[]> => {
        order.push('handle');
        return [{ type: 'text', text: 'ok' }];
      },
    };
    const replyClient: ReplyClient = {
      replyMessage: async (): Promise<unknown> => {
        order.push('reply');
        return {};
      },
    };
    const app = buildServer(handler, replyClient);
    app.addHook('onSend', async (_req, _reply, payload) => {
      order.push('send');
      return payload;
    });

    const body = webhookBody();
    const res = await app.inject({
      method: 'POST',
      url: '/webhook',
      headers: { 'x-line-signature': sign(body), 'content-type': 'application/json' },
      payload: body,
    });

    expect(res.statusCode).toBe(200);
    // 關鍵（G3）：replyMessage 於送出 200 回應「之前」被呼叫（非先回 200 再處理）。
    expect(order).toEqual(['handle', 'reply', 'send']);
    await app.close();
  });

  it('[D-007 AC-4] 驗簽失敗仍先回 401、不處理事件（不呼叫 handler/reply）', async () => {
    const handleEvent = vi.fn().mockResolvedValue([]);
    const replyMessage = vi.fn().mockResolvedValue({});
    const app = buildServer({ handleEvent }, { replyMessage });

    const body = webhookBody();
    const res = await app.inject({
      method: 'POST',
      url: '/webhook',
      headers: { 'x-line-signature': 'bad-signature', 'content-type': 'application/json' },
      payload: body,
    });

    expect(res.statusCode).toBe(401);
    expect(handleEvent).not.toHaveBeenCalled();
    expect(replyMessage).not.toHaveBeenCalled();
    await app.close();
  });

  it('[D-007 AC-10] GET /health 回 200 {status:"ok"}（不依賴 DB）', async () => {
    const handleEvent = vi.fn().mockResolvedValue([]);
    const app = buildServer({ handleEvent }, { replyMessage: vi.fn().mockResolvedValue({}) });
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
    await app.close();
  });
});
