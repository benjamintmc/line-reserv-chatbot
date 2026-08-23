// src/commands/index.ts
//
// D-002 §6：對外統一出口——re-export parseCommand、型別與常數。

export { parseCommand } from './parse';
export type {
  ParsedCommand,
  InvalidCommandKind,
  InvalidReason,
  InvalidDetail,
  EditEventField,
} from './types';
export { MAX_COUNT, MAX_PROXY_NAME_LEN, MAX_CAPACITY, MAX_LOCATION_LEN } from './types';

// D-004 OP-9/G7：per-field 驗證純函式（單一 source of truth，供 domain/create-flow 複用）。
// D-005 §6.1：新增 validateFee（一行式費用，mode 偵測）、validateVenueFee（場地費 >0）。
export {
  validateDate,
  validateTime,
  validateCapacity,
  validatePrice,
  validateFee,
  validateVenueFee,
  type ValidationResult,
} from './validators';
export { normalizeWhitelist } from './normalize';
