# Cloud Run 容器（D-007 §8）。多階段：PG-only → 無 better-sqlite3 native → 免 build tools、image 小、cold start 快。

# ── build 階段 ─────────────────────────────────────────────
FROM node:22-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build          # tsc + postbuild 複製 migrations 到 dist/db/migrations（解 deployment.md §6）

# ── runtime 階段 ───────────────────────────────────────────
FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
# 非 root 執行（T-025／資安盤點 M7）：node 官方 image 內建 uid 1000 的 node 使用者。
# /app 與 node_modules 維持 root 擁有、僅供讀取執行——不放寬權限（G1）。
# PORT 8080 > 1024，非特權使用者可綁定。
USER node
# PORT 由 Cloud Run 注入（預設 8080）；config.port = process.env.PORT ?? 3000 已相容。
# 健康檢查：Cloud Run 以 HTTP 探 /health（不依賴 DB）。
# 不得把 secret 寫入 image：DATABASE_URL / LINE 憑證一律 runtime env/secret（G6）。
CMD ["node", "dist/index.js"]
