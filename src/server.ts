import Fastify, { type FastifyInstance } from 'fastify';
import { validateSignature, type WebhookEvent } from '@line/bot-sdk';
import { config } from './config';
import { openDb } from './db';
import { runMigrations } from './db/migrate';
import { UserRepository } from './db/repositories/user-repository';
import { EventRepository } from './db/repositories/event-repository';
import { RegistrationRepository } from './db/repositories/registration-repository';
import { ProcessedEventRepository } from './db/repositories/processed-event-repository';
import { RegistrationService } from './domain/registration-service';
import { createWebhookHandler, type WebhookHandler } from './webhook/handler';
import { lineClient } from './line/client';

interface WebhookBody {
  events: WebhookEvent[];
}

/**
 * 組裝 domain 依賴（DB → repositories → service → webhook handler）。
 * 預設開啟 config.databasePath 並套用 migration；測試可注入自備的 handler。
 */
export function buildHandler(): WebhookHandler {
  const db = openDb();
  runMigrations(db);
  const users = new UserRepository(db);
  const events = new EventRepository(db);
  const registrations = new RegistrationRepository(db);
  const processed = new ProcessedEventRepository(db);
  const service = new RegistrationService({ events, users, registrations, processed });
  return createWebhookHandler({ service, users, profile: lineClient });
}

/** 建立 Fastify app（不啟動 listen，方便測試注入）。 */
export function buildServer(handler: WebhookHandler = buildHandler()): FastifyInstance {
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
        // 跨試/除錯：DEBUG_WEBHOOK=1 時印出事件來源，方便取得 groupId 以 seed 活動。
        if (config.debugWebhook) {
          const src = event.source as { type?: string; groupId?: string; userId?: string };
          const text =
            event.type === 'message' && event.message.type === 'text'
              ? event.message.text
              : undefined;
          app.log.info(
            { sourceType: src.type, groupId: src.groupId, userId: src.userId, text },
            '[DEBUG_WEBHOOK] 收到事件',
          );
        }
        let messages: Awaited<ReturnType<WebhookHandler['handleEvent']>> = [];
        try {
          messages = await handler.handleEvent(event);
        } catch (err) {
          app.log.error({ err }, 'handleEvent 失敗');
          return;
        }
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
