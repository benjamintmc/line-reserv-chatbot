// src/commands/index.ts
//
// D-002 §6：對外統一出口——re-export parseCommand、型別與常數。

export { parseCommand } from './parse';
export type {
  ParsedCommand,
  InvalidCommandKind,
  InvalidReason,
} from './types';
export { MAX_COUNT, MAX_PROXY_NAME_LEN, MAX_CAPACITY } from './types';
