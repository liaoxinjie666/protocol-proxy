# Protocol Proxy

English | [中文](./README.md)

[![npm version](https://img.shields.io/npm/v/protocol-proxy.svg)](https://www.npmjs.com/package/protocol-proxy)
[![Node.js Version](https://img.shields.io/badge/node-%3E%3D20.0.0-brightgreen.svg)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![GitHub Stars](https://img.shields.io/github/stars/liaoxinjie666/protocol-proxy.svg)](https://github.com/liaoxinjie666/protocol-proxy)

A transparent protocol-conversion proxy for OpenAI / Anthropic / Gemini APIs, with a built-in AI operations management platform.

## Features

### Protocol Conversion & Proxy
- **Multi-protocol conversion**: OpenAI ↔ Anthropic ↔ Gemini bidirectional auto-detection and conversion, including Responses API
- **Multi-port proxy**: Each proxy port runs independently
- **Default model injection**: Auto-inject a default model when requests omit it
- **Streaming support**: Real-time SSE conversion, including tool-call scenarios
- **Tool-call conversion**: Full mapping between functions/tool_calls and tool_use/tool_result
- **Hot-reload config**: Changes to target URLs, models, etc. take effect immediately without restart
- **Agent authentication**: Optional Bearer Token verification

### Provider Adapters
Built-in adapters for major Chinese LLM providers, handling protocol differences automatically:
- **qwen** (Tongyi Qianwen), **deepseek** (DeepSeek), **kimi** (Moonshot)
- **doubao** (Doubao), **zhipu** (Zhipu), **minimax** (MiniMax)

### AI Operations Assistant
SSE-based built-in AI management assistant with:
- **60+ built-in tools**: System queries, provider/proxy management, file operations, command execution, config management
- **MCP extensions**: Connect external tools via MCP protocol (search, filesystem, browser automation, PDF generation, etc.)
- **Skill system**: Predefined command templates triggered via `/skill-name`
- **Persistent memory**: Cross-session memory (Tier 1 always injected, Tier 2 loaded on demand, SOUL persona)
- **Multi-agent delegation**: Split large tasks into parallel sub-tasks with role isolation

### Configuration Management
- **Version snapshots**: Auto-save config change history with rollback and diff comparison
- **Incremental diff reconstruction**: Trace back historical versions through diff chains even if snapshots are cleaned
- **Import/Export**: Supports overwrite / merge import modes

## Screenshots

<!-- Place your screenshots in the screenshots/ directory and replace the placeholders below -->
<!-- ![Dashboard](screenshots/dashboard.png) -->
<!-- ![AI Assistant](screenshots/ai-assistant.png) -->
<!-- ![Protocol Conversion](screenshots/protocol-conversion.png) -->

> 📸 Screenshots coming soon — PRs welcome

## Quick Start

```bash
# 1. Install dependencies
npm install

# 2. Start the server
npm start

# 3. Open the management UI
open http://localhost:3000
```

## Configuration

### Provider

```json
{
  "providers": [
    {
      "id": "openai",
      "name": "OpenAI",
      "url": "https://api.openai.com",
      "protocol": "openai",
      "apiKeys": [{ "key": "sk-xxx", "label": "Main Key", "enabled": true }],
      "models": ["gpt-4o", "gpt-4o-mini"],
      "adapter": "",
      "capabilities": ["tools", "vision", "json"]
    }
  ]
}
```

| Field | Description |
|-------|-------------|
| `url` | Provider API endpoint |
| `protocol` | Protocol type: `openai`, `anthropic`, `gemini` |
| `apiKeys` | API key list with alias and enabled status |
| `adapter` | Adapter name (e.g. `deepseek`, `kimi`) for special handling of Chinese models |
| `capabilities` | Capability tags (`tools`, `vision`, `json`, etc.) |
| `azureDeployment` | Azure OpenAI deployment name (Azure only) |
| `azureApiVersion` | Azure OpenAI API version (Azure only) |

### Proxy

```json
{
  "proxies": [
    {
      "id": "default",
      "name": "Default Proxy",
      "port": 8080,
      "providerId": "openai",
      "defaultModel": "gpt-4o",
      "routingStrategy": "primary_fallback",
      "providerPool": [
        { "providerId": "openai", "model": "gpt-4o", "weight": 2 },
        { "providerId": "deepseek", "model": "deepseek-chat", "weight": 1 }
      ]
    }
  ]
}
```

| Field | Description |
|-------|-------------|
| `port` | Proxy listening port |
| `providerId` | Primary provider ID |
| `defaultModel` | Default model |
| `routingStrategy` | Routing strategy: `primary_fallback`, `round_robin`, `weighted`, `fastest` |
| `providerPool` | Multi-provider pool for routing strategies (optional) |
| `requireAuth` | Enable Bearer Token authentication |

### Routing Strategies

- **primary_fallback**: Use primary provider first, fallback through pool on failure
- **round_robin**: Rotate through the provider pool
- **weighted**: Distribute requests by weight
- **fastest**: Auto-select the provider with lowest latency

## Usage Flow

1. Open the management UI (`http://localhost:3000`) and create a provider with API URL and key
2. Create a proxy, select provider, port, and routing strategy
3. Configure your client's base URL to the proxy address, e.g. `http://localhost:8080`
4. Send requests normally (OpenAI / Anthropic / Gemini format)
5. The proxy auto-detects the inbound protocol and converts as needed

## Client Configuration Examples

### Claude Code

```bash
# Set environment variables
export ANTHROPIC_BASE_URL=http://localhost:8080
export ANTHROPIC_API_KEY=your-api-key

# Use directly
claude
```

### Cursor

In Cursor Settings → Models → OpenAI API Key:
- **API Key**: Enter your key
- **Override OpenAI Base URL**: `http://localhost:8080`

### Python (OpenAI SDK)

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://localhost:8080/v1",
    api_key="your-api-key"
)

response = client.chat.completions.create(
    model="gpt-4o",
    messages=[{"role": "user", "content": "Hello!"}]
)
print(response.choices[0].message.content)
```

### Python (Anthropic SDK)

```python
import anthropic

client = anthropic.Anthropic(
    base_url="http://localhost:8080",
    api_key="your-api-key"
)

message = client.messages.create(
    model="claude-sonnet-4-20250514",
    max_tokens=1024,
    messages=[{"role": "user", "content": "Hello!"}]
)
print(message.content[0].text)
```

### curl

```bash
# OpenAI format
curl http://localhost:8080/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your-api-key" \
  -d '{"model": "gpt-4o", "messages": [{"role": "user", "content": "Hello!"}]}'

# Anthropic format
curl http://localhost:8080/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: your-api-key" \
  -H "anthropic-version: 2023-06-01" \
  -d '{"model": "claude-sonnet-4-20250514", "max_tokens": 1024, "messages": [{"role": "user", "content": "Hello!"}]}'
```

## AI Operations Assistant

The management UI has an AI assistant panel on the right side. You can interact using natural language:

- Query system status, proxy health, API key health
- Create / modify / delete providers and proxies
- View logs, analyze anomalies, execute commands
- Trigger predefined skills via `/skill-name`
- Delegate sub-agents for complex parallel tasks

Supported tool categories:
- **System queries**: Status, usage, logs, health checks
- **File operations**: Read, write, search, replace, execute commands
- **Provider management**: CRUD, key testing, model list fetching
- **Proxy management**: CRUD, start/stop, batch operations
- **MCP management**: Connect external tool servers
- **Skill management**: Create custom command templates
- **Config management**: Import/export, snapshot rollback, diff comparison
- **Memory system**: Save cross-session memories, persona definitions
- **Multi-agent delegation**: Parallel sub-tasks, task status queries

## Project Structure

```
protocol-proxy/
├── server.js              # Management server & proxy entry
├── lib/
│   ├── adapters/          # Chinese model adapters (qwen/deepseek/kimi/doubao/zhipu/minimax)
│   ├── converters/        # Protocol converters (OpenAI/Anthropic/Gemini/Responses)
│   ├── multi-agent/       # Multi-agent delegation system
│   ├── config-store.js    # Config persistence & version snapshots
│   ├── proxy-manager.js   # Proxy port lifecycle management
│   ├── proxy-server.js    # Single proxy port request handling
│   ├── detector.js        # Inbound protocol detection
│   ├── prompt-builder.js  # AI assistant system prompt builder
│   ├── conversation-store.js  # Conversation history persistence
│   ├── memory-manager.js  # Memory system management
│   ├── skill-store.js     # Skill loading & management
│   ├── agent-store.js     # Agent identity loading & management
│   ├── mcp-client.js      # MCP client connection & tool discovery
│   └── exec-policy.js     # Command execution policy engine
├── public/                # Management frontend static files
├── config/
│   ├── mcp-presets.json   # MCP server preset configurations
│   └── proxies.json       # Default config (actual config in user directory)
├── agents/
│   ├── preset/            # 30+ preset agent identities (dev/product/ops, etc.)
│   └── system/            # System agents
├── skills/
│   ├── preset/            # Preset skills
│   └── system/            # System skills (usage guide, diagnostics, etc.)
└── package.json
```

## Tech Stack

- Node.js 20+ (native fetch + ReadableStream)
- Express (HTTP server)
- MCP SDK (external tool integration)
- Vanilla HTML/JS frontend

## Requirements

- Node.js >= 20.0.0

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) for guidelines.

## License

[MIT](./LICENSE)
