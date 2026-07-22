# ADR-003: better-sqlite3 版本 pin 於 ^12.4.1（不跟進 13.x）

- 狀態：已採納
- 日期：2026-07-23
- 決策者：architect（審查：architect-reviewer）

## 背景
CLAUDE.md §4 原將 better-sqlite3 列為「最新穩定版」，T-004 實作時最新為 13.x。better-sqlite3
為含 C++ native addon 的套件，安裝時需要對應 Node ABI 的 prebuilt binary，否則會退回
`node-gyp rebuild` 從原始碼編譯（需 C++ build tools）。

本機開發環境為 **Node v24（ABI 137）+ Windows x64，且無 C++ build tools**（未安裝 Visual
Studio C++ 工具鏈）。實測：

- `better-sqlite3@13.x` **未提供 Node 24（ABI 137）的 win32-x64 prebuilt**，安裝時退回
  `node-gyp rebuild`，因缺工具鏈而編譯失敗，套件無法載入。
- 逐版探測後，`better-sqlite3@12.4.1` **有 ABI 137 win32-x64 prebuilt**，免工具鏈即可安裝執行。

此問題純屬安裝期原生二進位相容性，與本專案商業邏輯無關；但若不 pin，`npm install` 可能
再度解析到 13.x 而在本機環境安裝失敗，阻斷開發。本 ADR 與 ADR-002 相關——後者的防超賣交易
語意（`db.transaction().immediate()`、WAL/busy_timeout/foreign_keys pragma）皆建立在
better-sqlite3 之上，故其版本可用性是實作前提。

## 決策
於 `package.json` 將 better-sqlite3 pin 為 **`^12.4.1`**（caret 鎖在 12.x，不自動跳 13.x）。

升級條件（明訂）：未來要升 13.x 或更高版本前，須先滿足其一——

1. 確認目標開發／部署環境的 Node ABI 在該 better-sqlite3 版本有對應的 prebuilt binary；或
2. 部署／建置映像具備可用的 C++ build tools（可從原始碼編譯 native addon）。

滿足後另開 ADR 或於本 ADR 增訂記錄升級，並同步更新 `@types/better-sqlite3`。

## 理由與被放棄的替代方案
| 方案 | 優點 | 缺點 | 結果 |
|---|---|---|---|
| pin `^12.4.1` | 本機 Windows/Node24 有 prebuilt、免工具鏈可跑；Linux 部署亦有 12.x linux-x64 prebuilt；API 與 11/13 一致無落差 | 非最新版；與 CLAUDE.md §4「最新穩定版」措辭有出入 | **採納** |
| 維持「最新穩定版」（13.x） | 追新 | 本機 Node24 無 win32-x64 prebuilt，缺工具鏈編譯失敗，開發被阻斷 | 放棄 |
| 本機安裝 Visual Studio C++ build tools 以編 13.x | 可留在最新版 | 增加開發環境前置負擔；每位接手者都要裝；為追新而付出不成比例成本 | 放棄（過度） |
| 本機改用 Node LTS（降 ABI）以取得 13.x prebuilt | 可留在最新版 | 為單一套件降級整個 runtime；影響其他工具鏈 | 放棄 |

補充：architect-reviewer 審查結論——同套件、僅版本下修。本專案用到的 API
（`db.transaction(fn).immediate(...)`、`PRAGMA`、`prepare`、`INSERT OR IGNORE`、`ON CONFLICT`）
在 11/12/13 行為一致且皆為穩定介面，無功能落差。`engines.node >=20` 與 12.4.1 相容。

## 影響
- **正面**：本機 Windows + Node 24 無需 C++ build tools 即可安裝執行；正式部署（Render /
  Fly.io / Cloud Run，Linux x64 且可裝 build tools）不受限，12.x 有 linux-x64 prebuilt；
  ADR-002 所依賴的交易與 pragma API 完全保留，實作無需調整。
- **負面／風險**：所用版本非社群最新；與 CLAUDE.md §4「最新穩定版」措辭產生出入——**DB 驅動
  版本以本 ADR 為準**，§4 措辭建議加註引用（回寫由 Orchestrator 經使用者確認處理，本 ADR 不自行改動）。
- **後續**：本 ADR 僅約束 SQLite 路徑的 better-sqlite3。若日後切換 PostgreSQL（無持久磁碟平台），
  pg 驅動（如 `pg` / `postgres`）為純 JS，無 native ABI 問題，其版本策略另議，不適用本 ADR。
