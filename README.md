# Xeo CF Translate Worker

基于 Cloudflare Workers 的翻译服务，用于自动翻译论坛帖子和回复内容，并自动审核。该服务使用 Google Gemini AI 进行多语言翻译，并支持敏感内容检测。需配合 [XEO OS](https://github.com/xeo-os/xeo-forum) 论坛使用。

## 部署指南

### 前置要求

- Cloudflare
  - Cloudflare Hyperdrive
- Gemini API

### 部署步骤

编辑 `wrangler.toml` 文件，配置以下变量：

```toml
name = "your-worker-name"
compatibility_date = "2025-06-10"
main = "worker.js"
compatibility_flags = ["nodejs_compat"]

[[hyperdrive]]
binding = "HYPERDRIVE"
id = "your-hyperdrive-id"

[vars]
AI_URL = "https://gateway.ai.cloudflare.com/v1/your-account-id/your-gateway/google-ai-studio/v1/models/gemini-2.5-flash:generateContent"
FORUM_URL = "https://your-forum-domain.com"

[observability.logs]
enabled = true
```


设置敏感的环境变量（不要放在 wrangler.toml 中）：

```bash
# 设置密码（用于 API 认证。与TRANSLATE_WORKER_PASSWORD保持一致）
npx wrangler secret put PASSWORD

# 设置 AI Token（Google AI Studio API 密钥）
npx wrangler secret put AI_TOKEN
```

创建 Hyperdrive 连接来优化数据库访问：

```bash
# 创建 Hyperdrive 配置
npx wrangler hyperdrive create your-hyperdrive-name --connection-string="postgresql://username:password@your-db-host:5432/database"
```

记下返回的 Hyperdrive ID，并更新 `wrangler.toml` 中的 `id` 字段。

部署到CF Worker

```bash
# 部署到生产环境
npx wrangler deploy

# 或者部署到开发环境进行测试
npx wrangler deploy --env dev
```

## 许可证
GNU AGPLv3