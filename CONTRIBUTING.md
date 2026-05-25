# Contributing to Protocol Proxy

感谢你对 Protocol Proxy 的关注！以下是参与贡献的指南。

## 开发环境

```bash
# 1. Fork 并克隆仓库
git clone https://github.com/<your-username>/protocol-proxy.git
cd protocol-proxy

# 2. 安装依赖
npm install

# 3. 启动开发服务器（文件变更自动重启）
npm run dev
```

## 项目结构

- `server.js` — 入口文件，管理服务器与代理启动
- `lib/` — 核心逻辑（协议转换、配置管理、AI 助手等）
- `public/` — 管理前端（纯 HTML/JS/CSS）
- `config/` — 配置文件
- `agents/` — 预设代理身份
- `skills/` — 预设技能

## 提交规范

使用 [Conventional Commits](https://www.conventionalcommits.org/) 格式：

```
<type>(<scope>): <description>

[可选正文]

[可选脚注]
```

常用 type：
- `feat` — 新功能
- `fix` — Bug 修复
- `docs` — 文档变更
- `style` — 代码格式（不影响逻辑）
- `refactor` — 重构
- `perf` — 性能优化
- `test` — 测试
- `chore` — 构建/工具变更

示例：
```
feat(adapters): add moonshot adapter
fix(converter): handle empty tool_calls array
docs(readme): add client configuration examples
```

## Pull Request 流程

1. 从 `master` 创建功能分支：`git checkout -b feat/your-feature`
2. 进行修改并提交
3. 确保代码能正常运行：`npm start`
4. 推送到你的 Fork：`git push origin feat/your-feature`
5. 创建 Pull Request，填写说明

## 报告 Bug

使用 [Issue 模板](https://github.com/liaoxinjie666/protocol-proxy/issues/new?template=bug_report.md) 提交 Bug 报告，请包含：

- 复现步骤
- 期望行为 vs 实际行为
- 环境信息（Node.js 版本、操作系统）
- 相关日志或截图

## 功能建议

使用 [Feature Request 模板](https://github.com/liaoxinjie666/protocol-proxy/issues/new?template=feature_request.md) 提交功能建议。

## 行为准则

- 尊重每一位贡献者
- 以建设性的方式提出反馈
- 聚焦于对社区最有利的事情
