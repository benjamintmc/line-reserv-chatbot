import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import { config } from '../config';

/** better-sqlite3 連線 handle 型別別名（供 repository / migrate 使用）。 */
export type Db = Database.Database;

/**
 * 連線工廠：建立 better-sqlite3 連線並套用 D-001 §0 / ADR-002 的 PRAGMA。
 *
 * - `journal_mode=WAL`：並發讀寫與耐用性。
 * - `foreign_keys=ON`：啟用 FK 約束（G8）。
 * - `busy_timeout=5000`：寫鎖競爭時等待，配合 IMMEDIATE 交易序列化（ADR-002）。
 *
 * DB 檔路徑走環境變數（`config.databasePath`），不寫死、不進版控；
 * 檔案型路徑會自動建立其所屬目錄（`:memory:` 除外）。
 */
export function openDb(path: string = config.databasePath): Db {
  if (path !== ':memory:') {
    mkdirSync(dirname(path), { recursive: true });
  }
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  return db;
}

export { nowIso } from './time';
