import Fastify, { type FastifyInstance } from 'fastify';
import { validateSignature, type WebhookEvent } from '@line/bot-sdk';
import { config } from './config';
import { buildReplies } from './webhook/handler';
import { lineClient } from './line/client';

interface WebhookBody {
  events: WebhookEvent[];
}

/** 建立 Fastify app（不啟動 listen，方便測試注入）。 */
export function buildServer(): FastifyInstance {
  const app = Fastify({ logger: true });

  // LINE 驗簽需要「原始 request body 字串」，因此保留 rawBody 再自行 JSON.parse。
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'string' },
    (req, body, done) => {
      (req as { rawBody?: string }).rawBody = body as string;
      try {
        done(null, body ? JSON.parse(body as string) : {});
      } catch (err) {
        done(err as Error, undefined);
      }
    },
  );

  app.get('/health', async () => ({ status: 'ok' }));

  app.post('/webhook', async (req, reply) => {
    const signature = req.headers['x-line-signature'];
    const rawBody = (req as { rawBody?: string }).rawBody ?? '';

    if (
      typeof signature !== 'string' ||
      !config.channelSecret ||
      !validateSignature(rawBody, config.channelSecret, signature)
    ) {
      return reply.code(401).send({ message: 'invalid signature' });
    }

    // 先回 200 讓 LINE 平台不逾時，再非同步處理事件。
    reply.code(200).send({ ok: true });

    const body = req.body as WebhookBody;
    await Promise.all(
      (body.events ?? []).map(async (event) => {
        const messages = buildReplies(event);
        if (
          messages.length > 0 &&
          'replyToken' in event &&
          typeof event.replyToken === 'string'
        ) {
          try {
            await lineClient.replyMessage({
              replyToken: event.replyToken,
              messages,
            });
          } catch (err) {
            app.log.error({ err }, 'replyMessage 失敗');
          }
        }
      }),
    );
  });

  return app;
}
