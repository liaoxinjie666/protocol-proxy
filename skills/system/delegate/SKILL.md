---
name: delegate
description: 任务委派指南，教模型如何合理拆分子任务、选择角色、并行执行
trigger: 用户要求拆分任务、并行处理、委派子任务、分配工作、同时做多件事、批量处理
---

# 任务委派指南

当任务可以拆分为多个独立子任务时，使用 `delegate_task` 工具并行委派给子代理执行。

## 拆分原则

1. **独立性** — 每个子任务应能独立完成，不依赖其他子任务的中间结果
2. **具体性** — 目标描述要明确，包含具体的输入、操作和期望输出
3. **并行优先** — 可并行的任务放在一次 `delegate_task` 调用中；有先后依赖的任务分多次调用
4. **适度拆分** — 不要过度拆分简单任务，3-5 个子任务是最佳规模

## 角色选择

| 角色 | 适用场景 | 权限 |
|------|----------|------|
| `explore` | 搜索文件、分析代码、查看日志、只读调研 | 只读，无法修改文件 |
| `implementer` | 创建文件、修改代码、实现功能 | 可写文件（沙盒内），不可执行命令 |
| `reviewer` | 代码审查、安全审计、质量检查 | 只读，输出按严重程度分类 |
| `general` | 混合任务、不确定类型 | 使用全局配置的权限 |

**选择规则**：
- 纯搜索/分析 → `explore`
- 需要写代码/改文件 → `implementer`
- 需要审查/评估 → `reviewer`
- 不确定或混合 → `general`
- 不同子任务可用不同角色（通过 `goal_roles` 数组指定）

## 目标描述模板

### 探索类（explore）
- "搜索项目中所有使用了 `fetch` 的文件，列出文件路径和调用行号"
- "分析 `src/` 目录的模块依赖关系，输出依赖图"
- "查看最近 50 条系统日志，找出 ERROR 级别的条目并分类汇总"

### 实现类（implementer）
- "在 `lib/utils.js` 中添加一个 `formatDate(date, format)` 函数，参考同文件中 `formatTime` 的风格"
- "创建一个 `tests/api.test.js` 测试文件，覆盖 `/api/tasks` 的 GET 和 POST 端点"
- "重构 `server.js` 中的路由注册代码，将代理相关路由提取到 `lib/routes/proxy.js`"

### 审查类（reviewer）
- "审查 `lib/multi-agent/delegate.js` 的错误处理，找出遗漏的边界情况"
- "检查 `server.js` 中所有 API 端点的输入验证是否完整"
- "审计项目的依赖项，检查是否有已知安全漏洞"

## 不适合委派的场景

- 需要全局状态感知的任务（如"启动所有代理"）
- 需要实时交互的任务（如"帮我配置一个供应商"）
- 简单的单步查询（直接调用工具更快）
- 子任务之间有强依赖且无法并行

## 使用示例

```
# 同角色并行
delegate_task({
  goals: [
    "分析 src/ 目录结构，列出所有模块",
    "查看 package.json 中的依赖项",
    "检查 .env 文件中的环境变量配置"
  ],
  role: "explore"
})

# 不同角色并行
delegate_task({
  goals: [
    "审查 server.js 的安全漏洞",
    "分析 lib/ 目录的代码质量",
    "检查所有 API 端点的错误处理"
  ],
  goal_roles: ["reviewer", "reviewer", "reviewer"]
})

# 混合角色
delegate_task({
  goals: [
    "搜索项目中所有的 TODO 注释",
    "创建一个 README.md 文件"
  ],
  goal_roles: ["explore", "implementer"]
})
```
