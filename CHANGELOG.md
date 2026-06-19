# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/).

## [Unreleased]

### Added
- 多模态服务系统指南：新增 `guide-multimodal` 系统技能，文档化文生图、文生视频、语音合成、文生音乐四类多模态服务（按配置动态生成工具的机制）及 `access_file`/`audio_analyze` 读取工具。

### Changed
- 修正多个智控助手工具描述，使其与实际行为一致：
  - `execute_command`：补充"受执行策略引擎控制"说明及返回结构 `{exitCode, stdout, stderr}`。
  - `search_files`：补充自动跳过 node_modules/.git 及最多返回 200 条的限制。
  - `add_mcp_server` / `update_mcp_server`：补充本地进程与远程两种方式互斥、切换会清除另一组配置的说明。
- `guide-overview` 新增多模态服务能力条目与 `/guide-multimodal` 指南链接。
- `guide-provider` 适配器清单补全 `mimo`。

## [3.3.18] - 2026-06-19

### Added
- 命名空间工具（namespace tool）支持，提升流式响应可靠性。

### Fixed
- 推理状态（thinking）透传与多模态输入，修复 Codex agentic 任务中断。
- Kimi K2.x thinking 模式与 Codex 配置改进。
- 修正 Codex Windows sandbox 取值，避免客户端启动失败。
- Gemini 路径稳定性与非流式 reasoning 补全。
- 多模态响应回流、图片降级与 Gemini thinking/usage 补全。
- 协议转换回归问题（审查发现）。
- reasoning 缓存 key 与非流式双跳转换器问题。
- 合并同一轮 assistant 的 text 和 tool_call 到同一条消息。
- 回流兜底解析 freeform XML 工具调用。

## [3.3.17] - 2026-06-07

### Fixed
- 改进 convId 清理逻辑，增加基于值的回退扫描。

## [3.3.16] - 2026-06-06

### Changed
- 移除 pure mode 特性（revert commit 2540e43）。

### Fixed
- SSE 流中追踪 convId 迁移并修复消息路由。

## [3.3.15] - 2026-06-02

### Added
- pure mode（含模型树选择器与改进的文件注入）。注：此特性在 3.3.16 中被移除。

## [3.3.14] - 2026-05-30

### Added
- 助手 SSE 响应增加进度心跳，并改进工具描述。

## [3.3.13] - 2026-05-30

### Added
- `access_file` 与 `audio_analyze` 工具，去重工具定义，改进多模态处理。

### Fixed
- 修复 prompt-builder.js 中中文引号导致的语法错误。
- 代理服务器稳定性与 UI 错误处理改进。
- MIMO 响应处理、prompt builder 与代理服务器稳定性。

## [3.3.10] - 2026-05-27

### Added
- `mimo` 适配器（小米 MiMo），含配置存储、多模型 UI 与 prompt 增强。
- `execute_code` 工具（沙箱执行 Python/JavaScript）与多模态附件增强。
- `parse_document` 工具（解析 PDF/DOCX/PPTX/XLSX），execute_code 支持文件注入与会话文件感知。
- 多模态服务管理（文生图/视频/TTS/音乐）工具。
- 客户端配置管理：配置备份恢复、连接测试、代理检测、客户端图标。
- 13 个智控助手工具，修复 Responses 协议枚举。
- 增强会话存储与 UI。
- 完成开源项目结构，新增截图、npm 安装说明与 README 可视化示例。

### Fixed
- 优雅处理非 JSON 上游响应。
- 改进协议转换器与记忆存储稳定性。
- UI 与服务器稳定性改进。

### Changed
- 更新技能文档与子代理阻止工具列表以适配新增的助手工具。
- 精简 guide-assistant、guide-mcp、guide-provider、guide-monitoring 中的冗余内容。

## [3.3.6] - 2025-05-26

### Changed
- Enhanced conversation store and UI improvements
- UI polish and server stability fixes
- Updated dependencies

## [3.3.4] - 2025-05-18

### Added
- Thinking effort configuration and UI enhancements
- Voice recording input support
- Autostart and exec-policy management tools
- CLI diagnostic commands
- Windows autostart support

### Fixed
- Logger API usage corrections
- Provider routing latency field naming
- Open-websearch config for stdio mode

## [3.3.0] - 2025-05-14

### Added
- Freeform tool support for Responses API
- js_repl tool support

## [3.2.0] - 2025-05-10

### Added
- Conversation store improvements
- UI enhancements

## [3.1.0] - 2025-05-05

### Added
- Overview dashboard and client-config guide skills
- AnySearch skill preset
- Proxy server improvements
- Conversation store enhancements
