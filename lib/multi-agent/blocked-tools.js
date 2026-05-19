// 子 Agent 工具阻止列表默认值（完全不可用，LLM 看不到）
const DEFAULT_BLOCKED_TOOLS = ['delegate_task'];

// 子 Agent 自动拒绝工具默认值（LLM 可见但执行时自动拒绝）
// execute_command 已由执行策略引擎（exec-policy.js）接管，不再在此硬拒绝
const DEFAULT_AUTO_DENY_TOOLS = ['write_file', 'edit_file'];

function filterToolDefinitions(definitions, blockedSet) {
  return definitions.filter(d => {
    const name = d.function?.name || d.name;
    return !blockedSet.has(name);
  });
}

function filterToolHandlers(handlers, blockedSet) {
  const filtered = {};
  for (const [name, handler] of Object.entries(handlers)) {
    if (!blockedSet.has(name)) {
      filtered[name] = handler;
    }
  }
  return filtered;
}

module.exports = { DEFAULT_BLOCKED_TOOLS, DEFAULT_AUTO_DENY_TOOLS, filterToolDefinitions, filterToolHandlers };