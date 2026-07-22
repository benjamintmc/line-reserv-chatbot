import { messagingApi } from '@line/bot-sdk';
import { config } from '../config';

/** LINE Messaging API 客戶端（用於 replyMessage / pushMessage 等）。 */
export const lineClient = new messagingApi.MessagingApiClient({
  channelAccessToken: config.channelAccessToken,
});
