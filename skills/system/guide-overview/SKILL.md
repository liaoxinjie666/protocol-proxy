---
name: guide-overview
description: 系统概述，介绍 Protocol Proxy 的定位、核心能力和典型使用场景
trigger: 用户询问这个系统是什么、有什么用、能做什么、系统介绍、Protocol Proxy 是什么、这个系统是干嘛的、帮我介绍一下
---

# Protocol Proxy 系统概述

## 一句话介绍

Protocol Proxy 是一个 AI API 统一网关，让用户在 Claude Code、Codex 等 Agent 工具中接入任意协议的大模型，并随时切换供应商和模型。

## 核心能力

### 1. 协议转换透明代理

将 OpenAI、Anthropic、Gemini 三种 API 协议互相转换。Agent 工具只需配置一个本地地址，代理自动处理协议适配，对客户端完全透明。

- 客户端用 OpenAI 格式请求 → 代理自动转成 Anthropic/Gemini 格式发送给上游
- 反向亦然，上游返回的响应自动转回客户端期望的格式
- 支持流式（SSE）和非流式两种模式

### 2. 一键切换供应商和模型

一个代理背后可挂载多个供应商，随时切换无需改动 Agent 工具配置：

| 能力 | 说明 |
|------|------|
| **多供应商接入** | OpenAI、Anthropic、Gemini、DeepSeek、通义千问、Kimi、豆包、智谱、MiniMax 等 |
| **API Key 轮换** | 多 Key 自动轮换，429 限流自动切换，3 分钟后自动恢复 |
| **路由策略** | 主备切换、轮询、加权随机、最快优先 |
| **高可用** | 多供应商池（providerPool），主供应商不可用时自动切换备选 |

### 3. AI 运维助手

内置智控助手，通过自然语言管理整个系统：

| 能力 | 说明 |
|------|------|
| **自然语言管理** | "帮我新建一个 DeepSeek 供应商"、"启动所有代理" |
| **系统诊断** | 健康检查、日志分析、代理诊断、MCP 诊断 |
| **技能扩展** | 通过 Skill 系统扩展 AI 能力，支持自定义技能 |
| **记忆系统** | 跨对话保持上下文和用户偏好 |
| **子智能体** | 复杂任务自动拆分，多子代理并行执行 |
| **MCP 集成** | 接入 MCP 服务器扩展工具能力 |
| **多模态服务** | 文生图、文生视频、语音合成、文生音乐，按配置动态生成工具 |

## 典型使用场景

### 场景一：在 Claude Code 中使用 DeepSeek

1. 创建 DeepSeek 供应商（填入 API 地址和 Key）
2. 创建一个代理（监听本地端口 8080，关联 DeepSeek 供应商）
3. 启动代理
4. 在 Claude Code 中将 API 地址改为 `http://localhost:8080`（详见 `/guide-client-config`）
5. 之后想换模型？只改代理配置，Claude Code 侧无需任何改动

### 场景二：统一管理多个 AI 供应商

- 同时接入 OpenAI、DeepSeek、通义千问
- 不同代理对接不同供应商，或同一代理配置多供应商轮询
- API Key 统一管理，健康状态一目了然

### 场景三：协议兼容

- 客户端只支持 OpenAI 格式，但想用 Anthropic 的 Claude？代理自动转换
- 想在 OpenAI 格式的工具中用 Gemini？代理自动转换
- 一个代理，三种协议自由切换

## 相关指南

| 主题 | 技能 | 说明 |
|------|------|------|
| 快速上手 | `/guide-provider` | 创建第一个供应商和代理 |
| 客户端配置 | `/guide-client-config` | 在 Claude Code、Codex 等工具中配置代理 |
| 代理配置 | `/guide-proxy` | 路由策略、协议转换、多供应商池 |
| MCP 扩展 | `/guide-mcp` | 接入 MCP 服务器扩展工具 |
| 智控助手 | `/guide-assistant` | 对话管理、技能系统、子智能体 |
| 监控日志 | `/guide-monitoring` | 用量统计、请求日志、系统日志 |
| 多模态服务 | `/guide-multimodal` | 文生图、文生视频、语音合成、文生音乐 |
| 系统设置 | `/guide-settings` | 配置管理、主题、记忆系统 |
