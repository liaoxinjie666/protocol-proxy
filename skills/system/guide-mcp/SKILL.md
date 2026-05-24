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

## 常用 MCP 服务器配置示例

> **提示**：大多数官方 MCP 服务器只支持 stdio 模式，不支持 HTTP 传输。配置时请使用本地进程方式。

### 1. 文件系统服务器（免费）
```
命令：npx
参数：-y @modelcontextprotocol/server-filesystem
参数：/允许访问的目录路径
```
**用途**：让 AI 读写指定目录下的文件
**适用场景**：文档处理、代码生成后写入文件
**特点**：必须指定至少一个允许访问的目录，支持多个目录
**示例**：`npx -y @modelcontextprotocol/server-filesystem C:/项目目录 /tmp`

### 2. 会话记忆服务器（免费）
```
命令：npx
参数：-y @modelcontextprotocol/server-memory
```
**用途**：在对话之间保持上下文记忆，存储实体和关系
**特点**：知识图谱存储，支持创建实体、关系、观察
**工具**：创建实体、创建关系、搜索节点、读取图谱

### 3. Chrome DevTools 服务器（免费）
```
命令：npx
参数：-y chrome-devtools-mcp
```
**用途**：浏览器自动化操作，包括页面导航、表单填写、元素点击、截图等
**特点**：无需 API Key，提供 29 个工具，支持 Lighthouse 审计、性能追踪
**工具示例**：页面导航、元素操作、表单填写、截图、网络请求分析、性能分析

### 4. Context7 服务器（免费）
```
命令：npx
参数：-y @upstash/context7-mcp
```
**用途**：基于语义搜索代码库文档，AI 可以搜索项目文档和代码上下文
**特点**：无需 API Key，完全免费，支持本地代码库和在线文档
**工具示例**：查询项目文档、搜索代码库

### 5. Sequential Thinking 服务器（免费）
```
命令：npx
参数：-y @modelcontextprotocol/server-sequential-thinking
```
**用途**：为复杂问题提供结构化的思维链推理，帮助 AI 解决多步骤问题
**特点**：无需 API Key，完全免费，增强 AI 的推理能力
**工具示例**：链式思考、问题分解、逻辑推理

### 6. Open WebSearch 服务器（免费）
```
命令：npx
参数：-y open-websearch
环境变量：PORT=55555
```
**用途**：搜索网页内容、抓取文章、获取实时信息
**特点**：无需 API Key，完全免费，但需要避免端口冲突
**注意**：PORT 环境变量用于避免端口 3000 被占用，建议设置为 55555
**工具示例**：网页搜索、获取文章内容、读取 GitHub README

### 7. Stagehand 服务器（免费）
```
命令：npx
参数：-y stagehand-mcp
```
**用途**：浏览器自动化操作，AI 可以控制浏览器进行网页操作
**特点**：无需 API Key，完全免费，可用于自动化测试和网页抓取
**工具示例**：打开网页、点击元素、填写表单、截图

### 8. A2ASearch 服务器（免费）
```
命令：npx
参数：-y a2asearch-mcp
```
**用途**：搜索 MCP 生态中的可用服务器和工具
**特点**：无需 API Key，帮助发现更多 MCP 工具

### 9. OpenChrome 服务器（免费）
```
命令：npx
参数：-y openchrome-mcp
```
**用途**：通过 CDP 协议控制 Chrome 浏览器
**特点**：无需 API Key，支持浏览器自动化和调试

### 10. Pretext PDF 服务器（免费）
```
命令：npx
参数：-y pretext-pdf-mcp
```
**用途**：生成 PDF 文档
**特点**：无需 API Key，可将 Markdown 等内容转为 PDF

### 11. Slack 服务器
```
命令：npx
参数：-y @modelcontextprotocol/server-slack
环境变量：SLACK_BOT_TOKEN=xoxb-xxx
环境变量：SLACK_TEAM_ID=T0123456789
```
**用途**：发送消息到 Slack 频道、读取频道历史
**前提**：需要创建 Slack App 并配置 Bot Token

### 12. Google Drive 服务器
```
命令：npx
参数：-y @modelcontextprotocol/server-gdrive
```
**用途**：读取 Google Drive 中的文件
**前提**：需要 OAuth2 认证配置

### 13. PostgreSQL 数据库服务器
```
命令：npx
参数：-y @modelcontextprotocol/server-postgres
参数：postgresql://user:password@localhost:5432/mydb
```
**用途**：查询和操作 PostgreSQL 数据库
**前提**：需要数据库连接信息

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

### 连接失败常见原因

1. **命令不存在**
   - 解决：确保命令可用（如 `npx` 需要安装 Node.js）

2. **包未安装**
   - 解决：运行 `npx -y @modelcontextprotocol/server-xxx` 预安装

3. **权限不足**
   - 解决：检查环境变量配置（如 Token 是否正确）

4. **端口被占用**
   - 解决：使用环境变量 `PORT=55555` 更改默认端口（如 open-websearch 默认占用 3000）
   - 常见冲突：3000 端口通常被前端服务占用

5. **网络问题（HTTP 方式）**
   - 解决：检查 URL 是否可访问，防火墙是否放行

### 如何查看连接错误

1. 点击「**连接**」按钮
2. 等待状态变为「**连接失败**」
3. 打开「**系统日志**」页面查看详细错误信息

### 包名和配置常见问题

1. **包名不准确**
   - 某些 MCP 包的 npm 名称与官方文档不同
   - 正确包名：`@upstash/context7-mcp`（不是 `@context7/mcp-server`）
   - 正确包名：`@modelcontextprotocol/server-sequential-thinking`（不是 `@anthropic-ai/mcp-sequential-thinking`）
   - 正确包名：`open-websearch`（不是 `open-websearch-mcp`）
   - 建议：先在命令行测试 `npx -y <package-name>` 确认包是否存在

2. **传输模式不支持**
   - 大多数官方 MCP 服务器只支持 stdio 模式，不支持 HTTP 传输
   - 如果使用 `--transport http` 参数会报错，因为参数会被当成路径参数
   - 解决方案：使用 stdio 模式配置

3. **端口冲突**
   - 某些 MCP 服务（如 open-websearch）默认监听 3000 端口
   - 解决方案：通过环境变量 `PORT=55555` 修改为其他端口
   - 命令行示例：`PORT=55555 npx -y open-websearch`

4. **连接断开后重试**
   - 如果连接失败后再次连接出现 "Connection closed" 错误
   - 解决方案：删除该 MCP 配置，重新添加并连接

5. **filesystem 需要指定目录**
   - 必须指定至少一个允许访问的目录作为参数
   - 示例：`npx -y @modelcontextprotocol/server-filesystem C:/项目目录 /tmp`

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
