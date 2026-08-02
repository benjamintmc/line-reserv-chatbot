import { describe, it, expect, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import type { WebhookEvent, messagingApi } from '@line/bot-sdk';
import { buildServer, type ReplyClient } from './server';
import { config } from './config';
import type { WebhookHandler } from './webhook/handler';

// 覆蓋缺口補強（unit-tester，T-012 覆核）：AC-4 於「多事件」與「單事件失敗」下的時序。
// §4 明載：一個 webhook body 可含多事件 → Promise.all 並行處理、**全部 await 完成才回 200**；
// 且「單事件失敗記 log 不中止其他」。既有 server.test.ts 僅測單事件 happy path + 401，此處補多事件與錯誤隔離。

function sign(rawBody: string): string {
  return createHmac('sha256', config.channelSecret).update(rawBody).digest('base64');
}

function bodyWith(events: unknown[]): string {
  return JSON.stringify({ events });
}

function msgEvent(id: string, replyToken: string): WebhookEvent {
  return {
    type: 'message',
    message: { type: 'text', id, text: '+1' },
    source: { type: 'group', groupId: 'G', userId: 'U' },
    replyToken,
  } as unknown as WebhookEvent;
}

describe('server 多事件 / 錯誤隔離時序（D-007 §4 / G3）', () => {
  it('[D-007 AC-4] 多事件 body：全部 handleEvent + replyMessage 於回 200 前完成', async () => {
    const handled: string[] = [];
    const replied: string[] = [];
    let sent = false;
    const handler: WebhookHandler = {
      handleEvent: async (event): Promise<messagingApi.Message[]> => {
        handled.push((event as { message: { id: string } }).message.id);
        return [{ type: 'text', text: 'ok' }];
      },
    };
    const replyClient: ReplyClient = {
      replyMessage: async (req): Promise<unknown> => {
        // 回 200 之前，reply 必須尚未被 onSend 標記（先處理再回 200）。
        expect(sent).toBe(false);
        replied.push((req as { replyToken: string }).replyToken);
        return {};
      },
    };
    const app = buildServer(handler, replyClient);
    app.addHook('onSend', async (_req, _reply, payload) => {
      sent = true;
      return payload;
    });

    const body = bodyWith([msgEvent('m1', 'rt1'), msgEvent('m2', 'rt2')]);
    const res = await app.inject({
      method: 'POST',
      url: '/webhook',
      headers: { 'x-line-signature': sign(body), 'content-type': 'application/json' },
      payload: body,
    });

    expect(res.statusCode).toBe(200);
    expect(handled.sort()).toEqual(['m1', 'm2']);
    expect(replied.sort()).toEqual(['rt1', 'rt2']); // 兩則皆於回 200 前送出
    await app.close();
  });

  it('[D-007 AC-4] 單事件 handleEvent 拋錯：記 log 不中止其他事件，整體仍回 200', async () => {
    const replied: string[] = [];
    const handler: WebhookHandler = {
      handleEvent: async (event): Promise<messagingApi.Message[]> => {
        const id = (event as { message: { id: string } }).message.id;
        if (id === 'boom') throw new Error('handler 爆炸');
        return [{ type: 'text', text: 'ok' }];
      },
    };
    const replyClient: ReplyClient = {
      replyMessage: async (req): Promise<unknown> => {
        replied.push((req as { replyToken: string }).replyToken);
        return {};
      },
    };
    const app = buildServer(handler, replyClient);

    const body = bodyWith([msgEvent('boom', 'rt-boom'), msgEvent('ok1', 'rt-ok')]);
    const res = await app.inject({
      method: 'POST',
      url: '/webhook',
      headers: { 'x-line-signature': sign(body), 'content-type': 'application/json' },
      payload: body,
    });

    // 一事件失敗不影響整體回 200，且另一事件仍完成 reply（錯誤隔離）。
    expect(res.statusCode).toBe(200);
    expect(replied).toEqual(['rt-ok']); // 失敗者未 reply、成功者有 reply
    await app.close();
  });

  it('[D-007 AC-4] replyMessage 拋錯：記 log 不影響回 200（回覆送出失敗不使 webhook 失敗）', async () => {
    const handler: WebhookHandler = {
      handleEvent: async (): Promise<messagingApi.Message[]> => [{ type: 'text', text: 'ok' }],
    };
    const replyClient: ReplyClient = {
      replyMessage: vi.fn().mockRejectedValue(new Error('reply 失敗')),
    };
    const app = buildServer(handler, replyClient);

    const body = bodyWith([msgEvent('m1', 'rt1')]);
    const res = await app.inject({
      method: 'POST',
      url: '/webhook',
      headers: { 'x-line-signature': sign(body), 'content-type': 'application/json' },
      payload: body,
    });

    expect(res.statusCode).toBe(200);
    expect(replyClient.replyMessage).toHaveBeenCalledTimes(1);
    await app.close();
  });
});
