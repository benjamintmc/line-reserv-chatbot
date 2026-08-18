import Fastify, { type FastifyInstance } from 'fastify';
import { validateSignature, type WebhookEvent, type messagingApi } from '@line/bot-sdk';
import { config } from './config';
import { createPool } from './db';
import { createTransactionRunner, createImmediateRunner } from './db/tx';
import { UserRepository } from './db/repositories/user-repository';
import { EventRepository } from './db/repositories/event-repository';
import { RegistrationRepository } from './db/repositories/registration-repository';
import { ConversationRepository } from './db/repositories/conversation-repository';
import { ProcessedEventRepository } from './db/repositories/processed-event-repository';
import { RegistrationService } from './domain/registration-service';
import { EventService } from './domain/event-service';
import { GroupingService } from './domain/grouping-service';
import { createWebhookHandler, type WebhookHandler } from './webhook/handler';
import { lineClient } from './line/client';

interface WebhookBody {
  events: WebhookEvent[];
}

/** reply 客戶端最小介面（供測試注入 spy，驗 AC-4 呼叫順序）。lineClient 結構相容。 */
export interface ReplyClient {
  replyMessage(request: messagingApi.ReplyMessageRequest): Promise<unknown>;
}

/**
 * 組裝 domain 依賴（Pool → repositories → 交易 runner → services → webhook handler）。
 *
 * D-007：`pg.Pool` 於實例存活期**單例**（本函式建一次，G4；不得每請求 new Pool）；交易 runner 由此 Pool
 * checkout client。**migrate 從啟動路徑解耦**（不在此跑，G7/OP-6）——migrate 為部署步驟一次性執行
 * （對 Neon 直連跑 `npm run db:migrate`）。pool-bound repository 傳入 domain 只作交易外唯讀查詢；
 * 交易內寫入一律經注入 runner 提供的 client-bound TxRepos（G1，路線 A）。
 */
export function buildHandler(): WebhookHandler {
  const pool = createPool();
  const users = new UserRepository(pool);
  const events = new EventRepository(pool);
  const registrations = new RegistrationRepository(pool);
  const conversations = new ConversationRepository(pool);
  const processed = new ProcessedEventRepository(pool);
  const runImmediate = createImmediateRunner(pool);
  const runInTransaction = createTransactionRunner(pool);
  // D-010：`加開 N` 授權 = canManageEvent（host ∪ super-admin），故 RegistrationService 亦注入 super-admin 集合。
  const service = new RegistrationService({
    events,
    users,
    registrations,
    processed,
    runImmediate,
    superAdminUserIds: config.adminUserIds,
  });
  // 開團 domain（D-006）：開團全開；close/cancel 授權 = canManageEvent（host_user_id ∪ super-admin）。
  // super-admin 集合以 config.adminUserIds（env ADMIN_USER_IDS）注入（跨群安全網、domain 不讀 env，G3）。
  const eventService = new EventService({
    events,
    users,
    conversations,
    runInTransaction,
    superAdminUserIds: config.adminUserIds,
  });
  // D-011：分組 domain（唯讀名單 + 純函式分組；策略B session 僅暫存 conversation_states）。
  // 授權沿用 canManageEvent（裁決 #4 不放寬）；rng 預設 Math.random（prod 隨機、可重跑重骰）。
  const grouping = new GroupingService({
    events,
    users,
    registrations,
    conversations,
    runInTransaction,
  });
  return createWebhookHandler({
    service,
    eventService,
    grouping,
    users,
    conversations,
    profile: lineClient,
  });
}

/** 建立 Fastify app（不啟動 listen，方便測試注入 handler 與 replyClient）。 */
export function buildServer(
  handler: WebhookHandler = buildHandler(),
  replyClient: ReplyClient = lineClient,
): FastifyInstance {
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

    // D-007 §4 / G3（serverless 時序）：**先 await 完整處理（含 replyMessage）再回 200**。
    // Cloud Run 於回應送出後可能凍結/回收實例的 CPU；若先回 200 再 await，replyMessage 可能不送出（回覆漏送）。
    // 一個 webhook body 可能含多事件：維持 Promise.all 並行處理，全部完成後才回 200。
    const body = req.body as WebhookBody;
    await Promise.all(
      (body.events ?? []).map(async (event) => {
        // 跨試/除錯：DEBUG_WEBHOOK=1 時印出事件來源，方便取得 groupId 以 seed 活動。
        if (config.debugWebhook) {
          const src = event.source as { type?: string; groupId?: string; userId?: string };
          const eventText =
            event.type === 'message' && event.message.type === 'text'
              ? event.message.text
              : undefined;
          app.log.info(
            { sourceType: src.type, groupId: src.groupId, userId: src.userId, text: eventText },
            '[DEBUG_WEBHOOK] 收到事件',
          );
        }
        let messages: Awaited<ReturnType<WebhookHandler['handleEvent']>> = [];
        try {
          messages = await handler.handleEvent(event);
        } catch (err) {
          app.log.error({ err }, 'handleEvent 失敗');
          return; // 單事件失敗記 log 不中止其他（D-007 §4）。
        }
        if (messages.length > 0 && 'replyToken' in event && typeof event.replyToken === 'string') {
          try {
            await replyClient.replyMessage({ replyToken: event.replyToken, messages });
          } catch (err) {
            app.log.error({ err }, 'replyMessage 失敗');
          }
        }
      }),
    );

    // 全部事件處理（含 replyMessage）完成後才回 200（G3）。
    return reply.code(200).send({ ok: true });
  });

  return app;
}
