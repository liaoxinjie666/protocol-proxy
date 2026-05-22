---
name: guide-client-config
description: 客户端配置指南，教用户如何在 Claude Code、Codex 等 Agent 工具中配置 Protocol Proxy
trigger: 用户询问怎么在 Claude Code 中配置、怎么接入 Codex、客户端怎么配置、Agent 工具怎么设置、API 地址怎么改、怎么连到代理、OPENAI_BASE_URL、ANTHROPIC_BASE_URL、Claude Code 怎么用、Codex 怎么用
---

# 客户端配置指南

本技能指导用户将 Claude Code、Codex CLI 等 Agent 工具接入 Protocol Proxy。

## 前提条件

1. 已在 Protocol Proxy 中创建至少一个供应商和代理
2. 代理处于「运行中」状态
3. 记下代理的监听端口（如 `8080`）

## Claude Code 配置

Claude Code 通过环境变量配置 API 端点。编辑 `~/.claude/settings.json`：

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://localhost:8080",
    "ANTHROPIC_AUTH_TOKEN": "你的 API Key"
  }
}
```

### 关键环境变量

| 变量 | 说明 | 示例 |
|------|------|------|
| `ANTHROPIC_BASE_URL` | 代理地址（必填） | `http://localhost:8080` |
| `ANTHROPIC_AUTH_TOKEN` | API Key（必填） | `sk-xxx` |
| `API_TIMEOUT_MS` | 请求超时（毫秒） | `3000000`（50 分钟） |
| `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` | 禁用非必要请求 | `1` |

### 注意事项

- Claude Code 使用 Anthropic 协议，代理地址的代理需配置为 OpenAI 或 Anthropic 协议均可（代理自动转换）
- `ANTHROPIC_AUTH_TOKEN` 填 Protocol Proxy 代理配置的认证 Token（如启用了认证），或供应商的 API Key
- 如代理未启用认证，`ANTHROPIC_AUTH_TOKEN` 可填任意非空字符串
- 修改配置后需重启 Claude Code 生效

### 配置示例

假设代理监听在 `localhost:8080`，未启用认证：

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://localhost:8080",
    "ANTHROPIC_AUTH_TOKEN": "sk-placeholder",
    "API_TIMEOUT_MS": "3000000"
  }
}
```

## Codex CLI 配置

Codex CLI 使用 TOML 配置文件。编辑 `~/.codex/config.toml`：

```toml
model_provider = "proxy"
model = "你要使用的模型名"

[model_providers.proxy]
name = "Protocol Proxy"
base_url = "http://localhost:8081"
env_key = "OPENAI_API_KEY"
wire_api = "responses"
request_max_retries = 4
stream_max_retries = 10
stream_idle_timeout_ms = 300000
```

### 关键配置项

| 配置项 | 说明 | 示例 |
|--------|------|------|
| `model_provider` | 指定使用自定义 provider | `proxy` |
| `model` | 默认模型名 | `gpt-4o`、`deepseek-chat` |
| `base_url` | 代理地址 | `http://localhost:8081` |
| `env_key` | 从环境变量读取 API Key 的变量名 | `OPENAI_API_KEY` |
| `wire_api` | API 格式 | `responses`（推荐）或 `chat` |

### 注意事项

- Codex CLI 使用 OpenAI 协议，代理地址的代理需支持 OpenAI 格式
- `env_key` 指定从哪个环境变量读取 API Key，需确保该环境变量已设置
- `wire_api` 设为 `responses` 使用 Responses API 格式，设为 `chat` 使用 Chat Completions 格式
- 修改配置后需重启 Codex CLI 生效

### 配置示例

假设代理监听在 `localhost:8081`，使用 DeepSeek 模型：

```toml
model_provider = "proxy"
model = "deepseek-chat"

[model_providers.proxy]
name = "DeepSeek via Proxy"
base_url = "http://localhost:8081"
env_key = "OPENAI_API_KEY"
wire_api = "chat"
request_max_retries = 4
stream_max_retries = 10
stream_idle_timeout_ms = 300000
```

## 其他 Agent 工具

### 通用 OpenAI 兼容工具

大多数支持 OpenAI API 的工具都可以通过以下方式接入：

| 配置项 | 值 |
|--------|-----|
| API Base URL | `http://localhost:<代理端口>` |
| API Key | 供应商的 API Key 或代理的认证 Token |
| 模型名 | 代理配置的默认模型，或供应商支持的任意模型名 |

### 常见环境变量

| 工具 | Base URL 变量 | API Key 变量 |
|------|--------------|-------------|
| 通用 OpenAI SDK | `OPENAI_BASE_URL` | `OPENAI_API_KEY` |
| LangChain | `OPENAI_API_BASE` | `OPENAI_API_KEY` |
| Vercel AI SDK | `OPENAI_BASE_URL` | `OPENAI_API_KEY` |

## 常见问题

### Q: 连接超时怎么办？

增大超时时间：
- Claude Code：设置 `API_TIMEOUT_MS` 为更大的值（如 `3000000`）
- Codex CLI：增大 `stream_idle_timeout_ms`

### Q: 提示 API Key 无效？

1. 确认供应商的 API Key 有效且有余额
2. 如代理启用了认证，确认客户端填的 Token 与代理配置一致
3. 如代理未启用认证，客户端填任意非空字符串即可

### Q: 模型名不对？

1. 确认客户端填的模型名在供应商的模型列表中
2. 可在 Protocol Proxy 的「供应商管理」中点击「自动获取模型列表」查看可用模型
3. 如代理配置了默认模型，客户端可不指定模型

### Q: 协议不匹配？

Protocol Proxy 会自动转换协议，但需确保：
- 客户端使用 OpenAI 格式 → 代理端供应商协议任意
- 客户端使用 Anthropic 格式（如 Claude Code）→ 代理端供应商协议任意
- 代理会自动检测入站协议并转换
