// src/commands/index.ts
//
// D-002 §6：對外統一出口——re-export parseCommand、型別與常數。

export { parseCommand, COMMAND_HEAD_KEYWORDS } from './parse';
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
  validateLocation, // D-017：開團／編輯共用的場地名稱上限
  type ValidationResult,
} from './validators';
export { normalizeWhitelist } from './normalize';

// D-024 §4.2：`@selector` 前綴切分（parseCommand 的**前置**純函式，不改 parseCommand 本身）。
export { splitSelector, SELECTOR_STOP_KEYWORDS, type SelectorSplit } from './selector';
