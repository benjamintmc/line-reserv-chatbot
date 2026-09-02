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
import { GroupRepository } from './db/repositories/group-repository';
import {
  MessageEventMapRepository,
  type MessageEventMapWriter,
} from './db/repositories/message-event-map-repository';
import { RegistrationService } from './domain/registration-service';
import { EventService } from './domain/event-service';
import { GroupingService } from './domain/grouping-service';
import { createWebhookHandler, type WebhookHandler } from './webhook/handler';
import { lineClient } from './line/client';

interface WebhookBody {
  events: WebhookEvent[];
}

/**
 * reply 客戶端最小介面（供測試注入 spy，驗 AC-4 呼叫順序）。lineClient 結構相容。
 *
 * D-025 §4.1：回傳型別自 `Promise<unknown>` 收緊為 SDK 真型別——機制 A 需要讀
 * `sentMessages[].id`（`lineClient` 本就回這個型別，先前只是介面沒宣告；**補型別、非新增行為**）。
 */
export interface ReplyClient {
  replyMessage(
    request: messagingApi.ReplyMessageRequest,
  ): Promise<messagingApi.ReplyMessageResponse>;
}

/**
 * `buildServer` 的可注入依賴（皆選填；未給者走生產預設，見 {@link defaultDeps}）。
 *
 * ⚠ **部分注入的陷阱**：只給 `{ handler, replyClient }` 時，`messageEventMap` 會靜默落到
 * `defaultDeps()` ⇒ 真的建一個 `pg.Pool`。測試若要完全脫離 DB，三個都要給。
 */
export interface ServerDeps {
  handler?: WebhookHandler;
  replyClient?: ReplyClient;
  /** D-025 §4.1：機制 A 的**寫入**端（G3：只能在 reply 成功後、用回應的 `sentMessages[].id`）。 */
  messageEventMap?: MessageEventMapWriter;
}

/** 生產路徑的依賴集合（同一個 `pg.Pool`，G4）。 */
interface AppDeps {
  handler: WebhookHandler;
  messageEventMap: MessageEventMapWriter;
}

/**
 * 組裝 domain 依賴（Pool → repositories → 交易 runner → services → webhook handler）。
 *
 * D-007：`pg.Pool` 於實例存活期**單例**（本函式建一次，G4；不得每請求 new Pool）；交易 runner 由此 Pool
 * checkout client。**migrate 從啟動路徑解耦**（不在此跑，G7/OP-6）——migrate 為部署步驟一次性執行
 * （對 Neon 直連跑 `npm run db:migrate`）。pool-bound repository 傳入 domain 只作交易外唯讀查詢；
 * 交易內寫入一律經注入 runner 提供的 client-bound TxRepos（G1，路線 A）。
 */
function buildAppDeps(): AppDeps {
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
  // D-015：`編輯` 走 FOR UPDATE 鎖內 read-modify-write → 注入既有 immediate runner（不新增 runner）。
  const eventService = new EventService({
    events,
    users,
    conversations,
    runInTransaction,
    runImmediate,
    superAdminUserIds: config.adminUserIds,
  });
  // D-011：分組 domain（唯讀名單 + 純函式分組；策略B session 僅暫存 conversation_states）。
  // 授權沿用 canManageEvent（裁決 #4 不放寬）；rng 預設 Math.random（prod 隨機、可重跑重骰）。
  const grouping = new GroupingService({
    events,
    users,
    registrations,
    conversations,
    processed,
    runInTransaction,
  });
  // D-025 §4.1：機制 A 的映射表。同一個實例同時當 handler 的 reader 與 server 的 writer——
  // 兩端型別分離（`MessageEventMapReader`／`Writer`），但共用這一個 pool-bound repository。
  const messageEventMap = new MessageEventMapRepository(pool);
  const handler = createWebhookHandler({
    service,
    eventService,
    grouping,
    // D-026 §5.2：dispatch 層消歧義的候選集合來源（pool-bound 唯讀）。
    events,
    messageEventMap,
    users,
    conversations,
    profile: lineClient,
    // D-018：觸及與擴散觀測。groupSummary 走同一個 lineClient（結構相容 getGroupSummary），
    // 每群一生最多呼叫一次，不在熱路徑上。
    groups: new GroupRepository(pool),
    groupSummary: lineClient,
  });
  return { handler, messageEventMap };
}

/**
 * 生產預設依賴，**惰性建立且只建一次**——`pg.Pool` 於實例存活期須為單例（D-007 G4），
 * 而 `buildServer` 的多個預設值各自求值，不快取就會建出第二個 Pool。
 */
let cachedDeps: AppDeps | undefined;
function defaultDeps(): AppDeps {
  if (cachedDeps === undefined) cachedDeps = buildAppDeps();
  return cachedDeps;
}

/** 組裝 webhook handler（生產路徑；沿用既有名稱供既有呼叫端與測試使用）。 */
export function buildHandler(): WebhookHandler {
  return defaultDeps().handler;
}

/**
 * D-025 §4.1 / G3：reply **成功之後**，把 LINE 真正送出的每一則訊息 id 登記到
 * `message_event_map`。
 *
 * - 只用 `res.sentMessages[].id`（API 回應），**不得**用我方組出的 `messages` 陣列預測——
 *   reply 可能整則失敗，數量與 id 都以回應為準。
 * - `relatedEventId === undefined`（D-029 §5.3「明確不附」）→ 一列都不寫。
 * - 寫入失敗只記 log：登記失敗最多讓那幾則訊息不能被 quote，不得讓 webhook 失敗。
 */
export async function recordReplyMapping(
  res: messagingApi.ReplyMessageResponse,
  relatedEventId: number | undefined,
  messageEventMap: MessageEventMapWriter,
): Promise<void> {
  if (relatedEventId === undefined) return;
  for (const sent of res.sentMessages ?? []) {
    if (typeof sent.id !== 'string' || sent.id === '') continue;
    await messageEventMap.record(sent.id, relatedEventId);
  }
}

/** 建立 Fastify app（不啟動 listen，方便測試注入 handler 與 replyClient）。 */
export function buildServer(deps: ServerDeps = {}): FastifyInstance {
  const handler = deps.handler ?? defaultDeps().handler;
  const replyClient = deps.replyClient ?? lineClient;
  const messageEventMap = deps.messageEventMap ?? defaultDeps().messageEventMap;
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
        let result: Awaited<ReturnType<WebhookHandler['handleEvent']>> = { messages: [] };
        try {
          result = await handler.handleEvent(event);
        } catch (err) {
          app.log.error({ err }, 'handleEvent 失敗');
          return; // 單事件失敗記 log 不中止其他（D-007 §4）。
        }
        const { messages, relatedEventId } = result;
        if (messages.length > 0 && 'replyToken' in event && typeof event.replyToken === 'string') {
          let res: messagingApi.ReplyMessageResponse | undefined;
          try {
            res = await replyClient.replyMessage({ replyToken: event.replyToken, messages });
          } catch (err) {
            app.log.error({ err }, 'replyMessage 失敗');
          }
          // D-025 G3：**取得回應之後**才登記映射；reply 失敗（res undefined）一列都不寫。
          // 兩段 try 刻意分開：登記失敗不得被記成「replyMessage 失敗」，那會誤導追查方向。
          if (res !== undefined) {
            try {
              await recordReplyMapping(res, relatedEventId, messageEventMap);
            } catch (err) {
              app.log.error({ err }, 'message_event_map 登記失敗（該則訊息將無法被引用指定活動）');
            }
          }
        }
      }),
    );

    // 全部事件處理（含 replyMessage）完成後才回 200（G3）。
    return reply.code(200).send({ ok: true });
  });

  return app;
}
