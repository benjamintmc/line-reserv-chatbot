import { describe, it, expect } from 'vitest';
import type { WebhookEvent } from '@line/bot-sdk';
import { buildReplies } from './handler';

describe('buildReplies（M0 echo）', () => {
  it('文字訊息原樣回覆', () => {
    const event = {
      type: 'message',
      message: { type: 'text', id: '1', text: '+3' },
      replyToken: 'rt',
    } as unknown as WebhookEvent;
    expect(buildReplies(event)).toEqual([{ type: 'text', text: '+3' }]);
  });

  it('非文字訊息（貼圖）忽略', () => {
    const event = {
      type: 'message',
      message: { type: 'sticker', id: '2' },
      replyToken: 'rt',
    } as unknown as WebhookEvent;
    expect(buildReplies(event)).toEqual([]);
  });

  it('非訊息事件（follow）忽略', () => {
    const event = { type: 'follow', replyToken: 'rt' } as unknown as WebhookEvent;
    expect(buildReplies(event)).toEqual([]);
  });
});
