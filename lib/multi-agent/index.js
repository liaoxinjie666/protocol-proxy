const { TaskRegistry, TASK_STATUS } = require('./task-registry');
const taskStore = require('./task-store');
const { delegateTask, continueTask, DEFAULTS } = require('./delegate');
const { DEFAULT_BLOCKED_TOOLS, DEFAULT_AUTO_DENY_TOOLS, filterToolDefinitions, filterToolHandlers } = require('./blocked-tools');
const { getRole, listRoles, mergeToolPolicy } = require('./roles');

taskStore.init();
const registry = new TaskRegistry();

/**
 * 从 settings 中读取 agent.* 配置，构建 config 对象传给 delegateTask
 */
function getAgentConfig(settings) {
  const s = settings || {};
  const config = {};
  if (s['agent.maxConcurrent'] != null) config.maxConcurrent = s['agent.maxConcurrent'];
  if (s['agent.maxRounds'] != null) config.maxRounds = s['agent.maxRounds'];
  if (s['agent.timeout'] != null) config.timeout = s['agent.timeout'];
  if (s['agent.maxRetries'] != null) config.maxRetries = s['agent.maxRetries'];
  if (s['agent.blockedTools'] != null) {
    config.blockedTools = typeof s['agent.blockedTools'] === 'string'
      ? s['agent.blockedTools'].split(',').map(t => t.trim()).filter(Boolean)
      : s['agent.blockedTools'];
  }
  if (s['agent.autoDenyTools'] != null) {
    config.autoDenyTools = typeof s['agent.autoDenyTools'] === 'string'
      ? s['agent.autoDenyTools'].split(',').map(t => t.trim()).filter(Boolean)
      : s['agent.autoDenyTools'];
  }
  return config;
}

module.exports = {
  registry,
  delegateTask,
  continueTask,
  getAgentConfig,
  TASK_STATUS,
  DEFAULTS,
  DEFAULT_BLOCKED_TOOLS,
  DEFAULT_AUTO_DENY_TOOLS,
  filterToolDefinitions,
  filterToolHandlers,
  getRole,
  listRoles,
  mergeToolPolicy,
};