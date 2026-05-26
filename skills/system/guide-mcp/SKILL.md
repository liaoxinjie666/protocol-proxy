---
name: guide-mcp
description: MCP 服务配置指南，包括添加、连接、排查 MCP 服务器
trigger: 用户询问 MCP 怎么配置、MCP 是什么、MCP 服务连接失败、如何添加工具扩展、MCP 工具怎么用
---

# MCP 服务配置指南

MCP (Model Context Protocol) 服务器可以为 AI 对话提供额外的工具能力扩展。

## MCP 是什么？

MCP 是一种 AI 工具标准协议，允许 AI 连接外部工具和服务。例如：
- **文件系统工具**：让 AI 读写服务器上的文件
- **GitHub 工具**：让 AI 操作 GitHub 仓库、Issue、PR
- **数据库工具**：让 AI 查询和操作数据库
- **搜索工具**：让 AI 搜索网页或文档

## 添加 MCP 服务

1. 点击左侧菜单「**MCP 服务**」
2. 点击「**添加 MCP 服务**」按钮
3. 填写配置（见下方详解）
4. 点击「**保存**」
5. 点击「**连接**」启动服务

## 配置项详解

### 服务名称
- **用途**：给 MCP 服务起个标识名，方便识别
- **格式**：英文、数字、连字符（如 `filesystem`, `github-tools`）
- **注意**：名称不可重复

### 传输方式

#### 本地进程 (stdio) 方式

启动本地程序作为 MCP 服务器，适合本地安装的 MCP 服务。

| 配置项 | 含义 | 示例 |
|--------|------|------|
| **命令** | 启动 MCP 服务器的可执行文件或包管理器 | `npx`, `node`, `python`, `uvx` |
| **参数** | 传递给命令的参数，每个空格分隔一个参数 | `-y @modelcontextprotocol/server-filesystem /tmp` |
| **环境变量** | 传递给进程的环境变量（可选） | `GITHUB_TOKEN=xxx` |

#### 远程 HTTP 方式

连接远程运行的 MCP 服务器，适合连接远程部署的 MCP 服务。

| 配置项 | 含义 | 示例 |
|--------|------|------|
| **URL** | MCP 服务器的 HTTP 端点地址 | `https://mcp.example.com/mcp` |
| **请求头** | 发送到服务器的 HTTP 请求头（可选） | `Authorization: Bearer xxx` |

### 启用开关

控制 MCP 服务是否启用。关闭后该服务不会在智控助手中可用。

## 常用 MCP 服务器配置

> 大多数官方 MCP 服务器只支持 stdio 模式。系统预置了这些配置，可通过 `get_mcp_presets` 一键添加。

### 免费服务器（无需 API Key）

| # | 名称 | 命令 | 参数 | 用途 | 注意 |
|---|------|------|------|------|------|
| 1 | Filesystem | `npx` | `-y @modelcontextprotocol/server-filesystem /目录` | 读写指定目录文件 | 必须指定至少一个目录 |
| 2 | Memory | `npx` | `-y @modelcontextprotocol/server-memory` | 知识图谱记忆 | — |
| 3 | Chrome DevTools | `npx` | `-y chrome-devtools-mcp` | 浏览器自动化、Lighthouse 审计 | 29 个工具 |
| 4 | Context7 | `npx` | `-y @upstash/context7-mcp` | 语义搜索代码文档 | — |
| 5 | Sequential Thinking | `npx` | `-y @modelcontextprotocol/server-sequential-thinking` | 结构化思维链推理 | — |
| 6 | Open WebSearch | `npx` | `-y open-websearch` | 网页搜索（Bing/Baidu/DuckDuckGo） | **必须**设环境变量 `MODE=stdio`，否则端口冲突会崩溃 |
| 7 | Stagehand | `npx` | `-y stagehand-mcp` | 浏览器自动化 | — |
| 8 | A2ASearch | `npx` | `-y a2asearch-mcp` | 搜索 MCP 生态 | — |
| 9 | OpenChrome | `npx` | `-y openchrome-mcp` | CDP 浏览器控制 | — |
| 10 | Pretext PDF | `npx` | `-y pretext-pdf-mcp` | 生成 PDF | — |

### 需要配置的服务器

| # | 名称 | 命令 | 参数 / 环境变量 | 用途 |
|---|------|------|-----------------|------|
| 11 | Slack | `npx` | `-y @modelcontextprotocol/server-slack` + `SLACK_BOT_TOKEN` + `SLACK_TEAM_ID` | Slack 消息和频道 |
| 12 | Google Drive | `npx` | `-y @modelcontextprotocol/server-gdrive` | Google Drive 文件（需 OAuth2） |
| 13 | PostgreSQL | `npx` | `-y @modelcontextprotocol/server-postgres postgresql://user:pass@host:5432/db` | 数据库查询 |

## 连接/断开 MCP 服务

| 操作 | 说明 |
|------|------|
| **连接** | 启动 MCP 服务器进程，建立工具连接。连接后才能在智控助手中使用 |
| **断开** | 停止 MCP 服务器进程，释放资源 |
| **工具列表** | 查看该服务提供的所有工具，了解可用的操作能力 |

## 连接状态说明

| 状态 | 含义 |
|------|------|
| **未连接** | 服务未启动，需要点击「连接」启动 |
| **连接中** | 正在启动服务，请稍候 |
| **已连接** | 服务运行正常，工具可用 |
| **连接失败** | 启动失败，查看日志排查问题 |

## 常见问题排查

| 问题 | 原因 | 解决方案 |
|------|------|----------|
| 命令不存在 | npx/uvx 未安装 | 确认 Node.js 或 Python 已安装 |
| 包名错误 | npm 名称与文档不同 | 先 `npx -y <包名>` 测试；正确包名见下表 |
| 权限不足 | Token 或环境变量错误 | 检查环境变量配置 |
| 端口冲突 | 某些服务默认启动 HTTP 服务器 | 设 `MODE=stdio` 或 `PORT=其他端口` |
| 连接断开 | 状态异常 | 删除配置，重新添加并连接 |
| HTTP 方式失败 | URL 不可达 | 检查网络和防火墙 |
| 传输模式报错 | 官方 MCP 只支持 stdio | 使用本地进程方式配置 |

**易错包名对照**：

| 错误写法 | 正确包名 |
|----------|----------|
| `@context7/mcp-server` | `@upstash/context7-mcp` |
| `@anthropic-ai/mcp-sequential-thinking` | `@modelcontextprotocol/server-sequential-thinking` |
| `open-websearch-mcp` | `open-websearch` |

查看连接错误：点击「连接」→ 等待「连接失败」→ 打开「系统日志」查看详细信息。更多诊断流程见 `/diagnostics`（MCP 诊断章节）。

## MCP 服务使用流程

1. **安装 MCP 服务器**（如果是本地方式）
   ```bash
   # 示例：安装文件系统服务器
   npx -y @modelcontextprotocol/server-filesystem
   ```

2. **在系统中添加 MCP 服务**
   - 填写服务名称、命令、参数等配置
   - 点击保存

3. **连接 MCP 服务**
   - 点击「连接」按钮
   - 等待状态变为「已连接」

4. **在智控助手中使用**
   - 打开智控助手页面
   - AI 会自动发现并可以使用 MCP 工具
   - 直接用自然语言请求，如"帮我读取 /tmp/test.txt"或"在 GitHub 上搜索 protocol-proxy 仓库"
