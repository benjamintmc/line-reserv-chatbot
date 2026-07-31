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

// D-004 OP-9/G7：per-field 驗證純函式（單一 source of truth，供 domain/create-flow 複用）。
export {
  validateDate,
  validateTime,
  validateCapacity,
  validatePrice,
  type ValidationResult,
} from './validators';
export { normalizeWhitelist } from './normalize';
