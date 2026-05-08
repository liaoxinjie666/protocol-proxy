# Protocol Proxy

OpenAI / Anthropic 协议转换透明代理服务。

## 功能特性

- **双向协议转换**：OpenAI ↔ Anthropic 自动识别并转换
- **多端口代理**：每个代理端口独立运行，互不干扰
- **默认 Model 注入**：可为每个代理配置默认 Model，请求未携带 model 时自动注入
- **流式输出支持**：SSE 实时转换，包括工具调用场景
- **工具调用转换**：functions/tool_calls ↔ tool_use/tool_result 完整映射
- **管理前端**：内置 Web UI，可视化配置代理和目标
- **Agent 身份验证**：可选 Bearer Token 认证
- **配置热更新**：修改目标地址、Model 等配置后即时生效，无需重启代理

## 快速开始

```bash
# 1. 安装依赖
npm install

# 2. 启动服务
npm start

# 3. 打开管理界面
open http://localhost:3000
```

## 配置说明

每个代理端口对应一个目标供应商配置：

```json
{
  "proxies": [
    {
      "id": "default",
      "name": "默认代理",
      "port": 8080,
      "requireAuth": false,
      "authToken": null,
      "target": {
        "providerUrl": "https://api.openai.com",
        "protocol": "openai",
        "defaultModel": "gpt-4o",
        "apiKey": "sk-xxx"
      }
    }
  ]
}
```

| 字段 | 说明 |
|------|------|
| `port` | 代理监听端口 |
| `requireAuth` | 是否启用 Agent 认证 |
| `authToken` | 认证 Token（启用时自动生成） |
| `target.providerUrl` | 目标供应商地址 |
| `target.protocol` | 目标协议：`openai` 或 `anthropic` |
| `target.defaultModel` | 默认 Model，请求未携带 model 时注入 |
| `target.apiKey` | 供应商 API Key |

## 使用流程

1. 在管理界面（`http://localhost:3000`）创建代理，配置端口和目标供应商
2. Agent 配置 base URL 为代理地址，例如 `http://localhost:8080`
3. Agent 正常发送请求（OpenAI 或 Anthropic 格式均可）
4. 代理自动识别入站协议，必要时进行协议转换后转发到目标供应商

## 技术栈

- Node.js 20+（原生 fetch + ReadableStream）
- Express（HTTP 服务）
- 纯 HTML/JS 管理前端

## 文件结构

```
protocol-proxy/
├── server.js              # 管理服务器入口
├── lib/
│   ├── config-store.js    # 配置持久化
│   ├── proxy-manager.js   # 代理端口生命周期管理
│   ├── proxy-server.js    # 单个代理端口的请求处理
│   ├── detector.js        # 入站协议检测
│   └── converters/
│       ├── openai-to-anthropic.js
│       ├── anthropic-to-openai.js
│       └── sse-helpers.js
├── config/
│   └── proxies.json       # 配置文件
├── public/                # 前端静态文件
└── package.json
```
