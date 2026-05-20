const os = require('os');
const fs = require('fs');
const path = require('path');
const logger = require('../logger');
const { filterToolDefinitions, filterToolHandlers } = require('./blocked-tools');
const { getRole, mergeToolPolicy } = require('./roles');
const { execPolicy } = require('../exec-policy');

const DEFAULTS = {
  maxConcurrent: 3,
  maxRounds: 5,
  timeout: 300,         // 秒
  maxRetries: 1,        // LLM 调用失败重试次数
  blockedTools: ['delegate_task'],
  autoDenyTools: ['write_file', 'edit_file'],
};

/**
 * 为子代理构建专用的精简系统提示词（不继承父代理提示词）
 * 父代理提示词包含助手人设、技能列表、记忆管理等内容，会干扰子代理的任务执行
 */
function buildChildSystemPrompt({ role, scopeDir, allowedTools, blockedSet, autoDenySet, roleBlocked, projectRoot, agentBody }) {
  const sandboxMode = role.sandboxMode || 'standard';
  const toolNames = allowedTools.map(d => d.function?.name || d.name).filter(Boolean);

  // 为每个可用工具生成简短说明（从 tool definition 的 description 中截取）
  const toolLines = allowedTools.map(d => {
    const name = d.function?.name || d.name;
    const desc = (d.function?.description || d.description || '').split('\n')[0].slice(0, 80);
    return `  - ${name}: ${desc}`;
  }).join('\n');

  const denyNames = [...autoDenySet].join('、');

  const parts = [
    `你是一个任务执行型子代理。你的唯一职责是完成分配给你的任务，然后给出简洁的结果总结。`,

    // 可用工具
    toolNames.length > 0
      ? `## 可用工具\n以下是你可以使用的工具，请直接调用它们来完成任务，不要只描述你打算做什么：\n${toolLines}`
      : '## 工具\n你当前没有可用工具，请基于你的知识直接回答。',

    // 角色后缀
    role.systemPromptSuffix || '',

    // 代理身份注入
    agentBody ? `## 代理身份\n${agentBody}` : '',

    // 沙盒规则（根据 sandboxMode 差异化）
    sandboxMode === 'project'
      ? `## 文件操作规则
- 你运行在一个普通文件系统环境中，不是 Docker 容器，没有虚拟环境
- 项目根目录是：${projectRoot || process.cwd()}
- 你可以使用 write_file 和 edit_file 创建或修改项目目录中的文件
- read_file、list_directory、search_files、grep_search 可以读取任意路径
- execute_command 的工作目录是项目根目录，受执行策略控制
- 不要编造路径或假设存在 Docker/虚拟环境，使用实际提供的工具和路径`
      : `## 沙盒规则
- 你运行在一个普通文件系统环境中，不是 Docker 容器，没有虚拟环境
- 你的沙盒目录是：${scopeDir}
- write_file 和 edit_file 只能操作沙盒目录内的文件，写入其他路径会被拒绝
- 如果需要创建文件，请使用沙盒目录的绝对路径作为文件路径
- read_file、list_directory、search_files、grep_search 可以读取任意路径
- execute_command 的工作目录是项目根目录：${projectRoot || process.cwd()}
- 不要编造路径或假设存在 Docker/虚拟环境，使用实际提供的工具和路径`,

    // 工具限制说明
    blockedSet.size > 0 ? `以下工具对你不可用：${roleBlocked.join('、')}。` : '',
    autoDenySet.size > 0 ? `部分工具（如 ${denyNames}）可能被限制执行，如被拒绝请换其他方式完成。` : '',

    // 行为指引
    `## 执行指引
- 收到任务后，立即开始调用工具执行，不要只描述计划
- 如果一个工具调用失败，分析错误原因并尝试替代方案
- 每个工具调用都应有明确目的，避免无意义的重复调用
- 任务完成后给出简洁的结果摘要（200 字以内）
- 请用中文回答`,

    // 允许用户指令传入（如有）
  ].filter(Boolean);

  return parts.join('\n\n');
}

const TRUNCATION_MARKER = '\n<!-- RESULT_TRUNCATED -->';

function resolveConfig(config) {
  const c = { ...DEFAULTS, ...config };
  c.blockedTools = Array.isArray(c.blockedTools) ? c.blockedTools : DEFAULTS.blockedTools;
  c.autoDenyTools = Array.isArray(c.autoDenyTools) ? c.autoDenyTools : DEFAULTS.autoDenyTools;
  c.maxConcurrent = Math.max(1, Math.min(10, parseInt(c.maxConcurrent) || DEFAULTS.maxConcurrent));
  c.maxRounds = Math.max(1, Math.min(100, parseInt(c.maxRounds) || DEFAULTS.maxRounds));
  c.timeout = Math.max(10, Math.min(600, parseInt(c.timeout) || DEFAULTS.timeout));
  c.maxRetries = Math.max(0, Math.min(5, parseInt(c.maxRetries) ?? DEFAULTS.maxRetries));
  return c;
}

function isPathInside(filePath, scopeDir) {
  const resolved = path.resolve(filePath);
  const scope = path.resolve(scopeDir);
  return resolved === scope || resolved.startsWith(scope + path.sep);
}

/**
 * 为写操作工具包装路径作用域限制
 * - readonly/standard: 写操作限制在 scopeDir 内
 * - project: 不限制写入路径（由角色信任 + exec policy 保障安全）
 * 所有模式下 execute_command 都由执行策略引擎控制
 */
function wrapHandlersForScope(handlers, scopeDir, sandboxMode = 'standard') {
  const wrapped = { ...handlers };
  const restrictWrites = sandboxMode !== 'project';

  // write_file：非 project 模式下限制在沙盒内
  if (wrapped.write_file && restrictWrites) {
    const orig = wrapped.write_file;
    wrapped.write_file = async (args) => {
      const filePath = path.resolve(args.path || '');
      if (!isPathInside(filePath, scopeDir)) {
        return { error: `[SCOPE] 写入被限制在沙盒目录内，不允许写入: ${args.path}` };
      }
      return orig(args);
    };
  }

  // edit_file：非 project 模式下限制在沙盒内
  if (wrapped.edit_file && restrictWrites) {
    const orig = wrapped.edit_file;
    wrapped.edit_file = async (args) => {
      const filePath = path.resolve(args.path || '');
      if (!isPathInside(filePath, scopeDir)) {
        return { error: `[SCOPE] 编辑被限制在沙盒目录内，不允许编辑: ${args.path}` };
      }
      return orig(args);
    };
  }

  // execute_command：通过执行策略引擎评估命令安全性
  if (wrapped.execute_command) {
    const origCmd = wrapped.execute_command;
    wrapped.execute_command = async (args) => {
      const cmd = args.command || args.cmd || '';
      const result = execPolicy.check(cmd);

      if (result.decision === 'forbidden') {
        return { error: `[FORBIDDEN] 命令被安全策略禁止: ${cmd}（${result.description}）` };
      }

      if (result.decision === 'prompt') {
        // 子代理无法弹出审批 UI，自动批准但记录日志供审查
        logger.log(`[exec-policy] 子代理自动批准需确认命令: ${cmd}（${result.description}）`);
        execPolicy.approveForSession(result.matchedRule || cmd.split(' ').slice(0, 2).join(' '));
      }

      // allow 或已自动批准的 prompt → 执行
      return origCmd(args);
    };
  }

  return wrapped;
}

function cleanupScope(scopeDir) {
  try {
    fs.rmSync(scopeDir, { recursive: true, force: true });
    logger.log(`[delegate] 沙盒清理完成: ${scopeDir}`);
  } catch (err) {
    logger.warn(`[delegate] 沙盒清理失败: ${scopeDir} - ${err.message}`);
  }
}

/**
 * 清理所有沙盒目录（进程退出时调用，或启动时清理历史残留）
 */
function cleanupAllSandboxes() {
  const sandboxBase = path.join(os.tmpdir(), 'agent-sandbox');
  try {
    if (fs.existsSync(sandboxBase)) {
      fs.rmSync(sandboxBase, { recursive: true, force: true });
      logger.log('[delegate] 全部沙盒已清理');
    }
  } catch (err) {
    logger.warn(`[delegate] 全部沙盒清理失败: ${err.message}`);
  }
}

// 进程退出时清理所有沙盒
process.on('beforeExit', cleanupAllSandboxes);
process.on('SIGINT', () => { cleanupAllSandboxes(); process.exit(0); });
process.on('SIGTERM', () => { cleanupAllSandboxes(); process.exit(0); });

// 启动时清理历史残留沙盒（上次进程异常退出留下的）
cleanupAllSandboxes();

async function delegateTask({
  goals,
  registry,
  proxyUrl,
  proxyHeaders,
  defaultModel,
  toolDefinitions,
  toolHandlers,
  systemPrompt: _parentSystemPrompt, // 不再使用，保留参数兼容性
  parentTaskId,
  maxRounds,
  sendSSE,
  config,
  silent = false,
  agentStore,
}) {
  const cfg = resolveConfig(config);
  const blockedSet = new Set(cfg.blockedTools);
  const autoDenySet = new Set(cfg.autoDenyTools);
  const effectiveMaxRounds = maxRounds || cfg.maxRounds;
  const childTimeoutMs = cfg.timeout * 1000;

  if (!Array.isArray(goals) || goals.length === 0) {
    return { error: 'goals 必须是非空字符串数组' };
  }
  if (goals.length > 10) {
    return { error: '一次最多委派 10 个子任务' };
  }

  const batchId = 'batch-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6);

  // 静默模式：用代理包装 registry，拦截所有事件广播
  const effectiveRegistry = silent ? new Proxy(registry, {
    get(target, prop) {
      if (prop === 'emit' || prop === 'emitBatchCreated') return () => {};
      const val = target[prop];
      return typeof val === 'function' ? val.bind(target) : val;
    },
  }) : registry;

  // 创建任务（每个目标可指定角色和代理身份）
  const tasks = goals.map(goal => {
    const agentSlug = typeof goal === 'object' && goal.agent ? goal.agent : (config.agent || null);
    let explicitRole = typeof goal === 'object' && goal.role ? goal.role : (config.role || null);
    let agentBody = null;

    // 解析代理身份
    if (agentSlug && agentStore) {
      const agent = agentStore.get(agentSlug);
      if (agent) {
        agentBody = agent.body;
        // 代理的 defaultRole 仅在未显式指定 role 时生效
        if (!explicitRole) explicitRole = agent.defaultRole || 'writer';
      }
    }

    const task = effectiveRegistry.create({
      objective: typeof goal === 'string' ? goal : goal.objective,
      model: typeof goal === 'object' && goal.model ? goal.model : undefined,
      parentTaskId,
      role: explicitRole || 'full',
      batchId,
      agent: agentSlug || null,
    });
    task._agentBody = agentBody;
    return task;
  });

  // 通知前端：子任务创建（通过 registry 事件 → WebSocket 广播）
  effectiveRegistry.emitBatchCreated(batchId, tasks);

  // 为每个子任务构建独立的工具集和系统提示词（按角色差异化）
  const sandboxBase = path.join(os.tmpdir(), 'agent-sandbox');
  for (const task of tasks) {
    const role = getRole(task.role);
    const { blockedTools: roleBlocked, autoDenyTools: roleAutoDeny } = mergeToolPolicy(role, cfg.blockedTools, cfg.autoDenyTools);
    const taskBlockedSet = new Set(roleBlocked);
    const taskAutoDenySet = new Set(roleAutoDeny);

    // 过滤工具
    const baseHandlers = filterToolHandlers(toolHandlers, taskBlockedSet);
    const allowedTools = filterToolDefinitions(toolDefinitions, taskBlockedSet)
      .filter(d => {
        const name = d.function?.name || d.name;
        return !!baseHandlers[name];
      });

    // 沙盒
    const scopeDir = path.join(sandboxBase, task.id);
    fs.mkdirSync(scopeDir, { recursive: true });
    task._scopeDir = scopeDir;
    task._scopedHandlers = wrapHandlersForScope(baseHandlers, scopeDir, role.sandboxMode);

    // 系统提示词（使用子代理专用精简提示词，不继承父代理）
    task._childSystemPrompt = buildChildSystemPrompt({
      role,
      scopeDir,
      allowedTools,
      blockedSet: taskBlockedSet,
      autoDenySet: taskAutoDenySet,
      roleBlocked,
      projectRoot: process.cwd(),
      agentBody: task._agentBody || null,
    });
    logger.log(`[delegate] 子代理 ${task.id} 系统提示词: ${task._childSystemPrompt.length} 字符，可用工具: ${allowedTools.length} 个`);
    logger.debug?.(`[delegate] 子代理 ${task.id} 提示词内容:\n${task._childSystemPrompt}`);
    task._allowedTools = allowedTools;
    task._blockedSet = taskBlockedSet;
    task._autoDenySet = taskAutoDenySet;
  }

  // 并行执行（限制并发数）
  const results = await runWithConcurrency(
    tasks.map(task => () => runChildAgent({
      task,
      registry: effectiveRegistry,
      proxyUrl,
      proxyHeaders,
      defaultModel: task.model || defaultModel,
      allowedTools: task._allowedTools,
      allowedHandlers: task._scopedHandlers,
      blockedSet: task._blockedSet,
      autoDenySet: task._autoDenySet,
      childSystemPrompt: task._childSystemPrompt,
      maxRounds: effectiveMaxRounds,
      childTimeoutMs,
      maxRetries: cfg.maxRetries,
    })),
    cfg.maxConcurrent,
  );

  // 存储消息历史（供 message_task 续接），延迟清理沙盒
  for (let i = 0; i < tasks.length; i++) {
    const task = tasks[i];
    const result = results[i];
    if (result._messages) {
      registry.storeMessages(task.id, result._messages);
      delete result._messages;
    }
    // 延迟 30 分钟清理沙盒（供 message_task 续接使用）
    if (task._scopeDir) {
      setTimeout(() => cleanupScope(task._scopeDir), 30 * 60 * 1000);
    }
  }

  // 汇总
  const summary = results.map((r, i) => ({
    taskId: tasks[i].id,
    objective: tasks[i].objective,
    role: tasks[i].role,
    agent: tasks[i].agent || undefined,
    status: r.status,
    summary: r.summary || r.error || '',
  }));

  return {
    batchId,
    summary,
    allCompleted: results.every(r => r.status === 'completed'),
    completedCount: results.filter(r => r.status === 'completed').length,
    failedCount: results.filter(r => r.status === 'failed').length,
  };
}

async function runChildAgent({
  task,
  registry,
  proxyUrl,
  proxyHeaders,
  defaultModel,
  allowedTools,
  allowedHandlers,
  blockedSet,
  autoDenySet,
  childSystemPrompt,
  maxRounds,
  childTimeoutMs,
  maxRetries = 1,
}) {
  const abortController = new AbortController();
  registry.start(task.id, abortController);

  const messages = [
    { role: 'system', content: childSystemPrompt },
    { role: 'user', content: task.objective },
  ];

  try {
    for (let round = 0; round < maxRounds; round++) {
      if (abortController.signal.aborted) {
        registry.fail(task.id, 'Aborted');
        return { status: 'failed', error: 'Aborted' };
      }

      // LLM 调用（带重试）
      let body;
      let lastErr;
      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        if (attempt > 0) {
          const delay = Math.min(2000 * Math.pow(2, attempt - 1), 8000);
          logger.log(`[delegate] 重试 ${task.id} 第 ${attempt} 次，等待 ${delay}ms`);
          await new Promise(r => setTimeout(r, delay));
          if (abortController.signal.aborted) {
            registry.fail(task.id, 'Aborted');
            return { status: 'failed', error: 'Aborted' };
          }
        }
        try {
          const fetchRes = await fetch(proxyUrl, {
            method: 'POST',
            headers: proxyHeaders,
            signal: AbortSignal.any([abortController.signal, AbortSignal.timeout(childTimeoutMs)]),
            body: JSON.stringify({
              model: defaultModel || 'gpt-4o',
              messages,
              stream: false,
              tools: allowedTools.length > 0 ? allowedTools : undefined,
              tool_choice: allowedTools.length > 0 ? 'auto' : undefined,
            }),
          });
          if (!fetchRes.ok) {
            const text = await fetchRes.text();
            throw new Error(`HTTP ${fetchRes.status}: ${text.slice(0, 300)}`);
          }
          body = await fetchRes.json();
          lastErr = null;
          break;
        } catch (err) {
          lastErr = err;
          if (abortController.signal.aborted) break; // 不重试主动取消
        }
      }
      if (lastErr) throw lastErr;

      const choice = body.choices?.[0];
      if (!choice) throw new Error('Empty response from LLM');

      const assistantMsg = choice.message;

      // 截断过长的 assistant 消息以节省 token
      if (typeof assistantMsg.content === 'string' && assistantMsg.content.length > 8000) {
        assistantMsg.content = assistantMsg.content.slice(0, 8000) + TRUNCATION_MARKER;
      }

      // 注意：assistantMsg.reasoning_content 需原样保留在消息历史中（部分供应商要求回传）
      messages.push(assistantMsg);

      // 无工具调用 → 完成
      if (!assistantMsg.tool_calls || assistantMsg.tool_calls.length === 0) {
        const summary = assistantMsg.content || '';
        registry.complete(task.id, { result: summary, summary: summary.slice(0, 500) });
        return { status: 'completed', summary, _messages: messages };
      }

      // 处理工具调用
      for (const tc of assistantMsg.tool_calls) {
        let args;
        try {
          args = typeof tc.function.arguments === 'string'
            ? JSON.parse(tc.function.arguments)
            : tc.function.arguments;
        } catch {
          args = {};
        }

        const toolName = tc.function?.name;

        // 检查是否在阻止列表中
        if (blockedSet.has(toolName)) {
          messages.push({
            role: 'tool',
            tool_call_id: tc.id,
            content: JSON.stringify({ error: `子代理无权执行 ${toolName}` }),
          });
          continue;
        }

        // 自动拒绝危险操作（工具可见但不允许执行，子 Agent 可换策略）
        if (autoDenySet.has(toolName)) {
          logger.log(`[delegate] 自动拒绝子代理危险操作: ${toolName}`);
          messages.push({
            role: 'tool',
            tool_call_id: tc.id,
            content: JSON.stringify({ error: `[AUTO_DENY] 子代理不允许执行 ${toolName}，请用其他方式完成任务` }),
          });
          continue;
        }

        // 检查工具处理器是否可用（防止 MCP 工具有定义但无处理器）
        if (!allowedHandlers[toolName]) {
          messages.push({
            role: 'tool',
            tool_call_id: tc.id,
            content: JSON.stringify({ error: `工具 ${toolName} 在子代理中不可用` }),
          });
          continue;
        }

        // 执行工具
        try {
          const result = await allowedHandlers[toolName](args);
          const isErr = result && result.error;
          const resultStr = isErr ? `[ERROR] ${JSON.stringify(result)}` : JSON.stringify(result);
          messages.push({
            role: 'tool',
            tool_call_id: tc.id,
            content: resultStr.length > 10000 ? resultStr.slice(0, 10000) + TRUNCATION_MARKER : resultStr,
          });
          // 进度回报
          registry.reportProgress(task.id, {
            round: round + 1,
            lastTool: toolName,
            snippet: resultStr.slice(0, 200),
          });
        } catch (err) {
          messages.push({
            role: 'tool',
            tool_call_id: tc.id,
            content: JSON.stringify({ error: err.message }),
          });
        }
      }

      // 上下文窗口检查：保留完整的 tool_call ↔ tool_result 对
      if (estimateMessagesLength(messages) > 150000) {
        pruneMessages(messages);
      }
    }

    // 达到最大轮次
    const lastContent = messages.filter(m => m.role === 'assistant' && m.content).pop()?.content || '';
    registry.complete(task.id, { result: lastContent, summary: lastContent.slice(0, 500) });
    return { status: 'completed', summary: lastContent, _messages: messages };

  } catch (err) {
    registry.fail(task.id, err.message);
    return { status: 'failed', error: err.message, _messages: messages };
  }
}

/**
 * 续接子代理对话（message_task）
 */
async function continueTask({
  taskId,
  message,
  registry,
  proxyUrl,
  proxyHeaders,
  defaultModel,
  toolDefinitions,
  toolHandlers,
  systemPrompt,
  maxRounds,
  config,
}) {
  const cfg = resolveConfig(config);
  const task = registry.get(taskId);
  if (!task) return { error: `任务 ${taskId} 不存在` };
  if (task.status !== 'completed' && task.status !== 'failed') {
    return { error: `任务 ${taskId} 当前状态为 ${task.status}，只能续接已完成或失败的任务` };
  }

  const messages = registry.getMessages(taskId);
  if (!messages) return { error: `任务 ${taskId} 的对话历史已过期，无法续接` };

  // 获取角色和工具策略
  const role = getRole(task.role || 'full');
  const { blockedTools: roleBlocked, autoDenyTools: roleAutoDeny } = mergeToolPolicy(role, cfg.blockedTools, cfg.autoDenyTools);
  const taskBlockedSet = new Set(roleBlocked);
  const taskAutoDenySet = new Set(roleAutoDeny);
  const baseHandlers = filterToolHandlers(toolHandlers, taskBlockedSet);
  const allowedTools = filterToolDefinitions(toolDefinitions, taskBlockedSet)
    .filter(d => { const name = d.function?.name || d.name; return !!baseHandlers[name]; });

  // 应用沙盒作用域限制（续接时也需要）
  const scopeDir = task._scopeDir || path.join(os.tmpdir(), 'agent-sandbox', taskId);
  const scopedHandlers = wrapHandlersForScope(baseHandlers, scopeDir, role.sandboxMode);

  // 追加用户消息
  messages.push({ role: 'user', content: message });

  // 续接：允许从 completed/failed 状态恢复
  const abortController = new AbortController();
  registry.start(taskId, abortController, { allowResume: true });

  const childTimeoutMs = cfg.timeout * 1000;
  const effectiveMaxRounds = maxRounds || cfg.maxRounds;

  try {
    for (let round = 0; round < effectiveMaxRounds; round++) {
      if (abortController.signal.aborted) {
        registry.fail(taskId, 'Aborted');
        return { status: 'failed', error: 'Aborted' };
      }

      let body;
      let lastErr;
      for (let attempt = 0; attempt <= cfg.maxRetries; attempt++) {
        if (attempt > 0) {
          await new Promise(r => setTimeout(r, Math.min(2000 * Math.pow(2, attempt - 1), 8000)));
          if (abortController.signal.aborted) break;
        }
        try {
          const fetchRes = await fetch(proxyUrl, {
            method: 'POST',
            headers: proxyHeaders,
            signal: AbortSignal.any([abortController.signal, AbortSignal.timeout(childTimeoutMs)]),
            body: JSON.stringify({
              model: task.model || defaultModel || 'gpt-4o',
              messages,
              stream: false,
              tools: allowedTools.length > 0 ? allowedTools : undefined,
              tool_choice: allowedTools.length > 0 ? 'auto' : undefined,
            }),
          });
          if (!fetchRes.ok) throw new Error(`HTTP ${fetchRes.status}: ${(await fetchRes.text()).slice(0, 300)}`);
          body = await fetchRes.json();
          lastErr = null;
          break;
        } catch (err) { lastErr = err; if (abortController.signal.aborted) break; }
      }
      if (lastErr) throw lastErr;

      const choice = body.choices?.[0];
      if (!choice) throw new Error('Empty response from LLM');
      const assistantMsg = choice.message;
      if (typeof assistantMsg.content === 'string' && assistantMsg.content.length > 8000) {
        assistantMsg.content = assistantMsg.content.slice(0, 8000) + TRUNCATION_MARKER;
      }
      messages.push(assistantMsg);

      if (!assistantMsg.tool_calls || assistantMsg.tool_calls.length === 0) {
        const summary = assistantMsg.content || '';
        registry.complete(taskId, { result: summary, summary: summary.slice(0, 500) });
        registry.storeMessages(taskId, messages);
        return { status: 'completed', summary };
      }

      for (const tc of assistantMsg.tool_calls) {
        let args;
        try { args = typeof tc.function.arguments === 'string' ? JSON.parse(tc.function.arguments) : tc.function.arguments; } catch { args = {}; }
        const toolName = tc.function?.name;
        if (taskBlockedSet.has(toolName)) {
          messages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify({ error: `子代理无权执行 ${toolName}` }) });
          continue;
        }
        if (taskAutoDenySet.has(toolName)) {
          messages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify({ error: `[AUTO_DENY] 子代理不允许执行 ${toolName}` }) });
          continue;
        }
        if (!scopedHandlers[toolName]) {
          messages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify({ error: `工具 ${toolName} 不可用` }) });
          continue;
        }
        try {
          const result = await scopedHandlers[toolName](args);
          const resultStr = result?.error ? `[ERROR] ${JSON.stringify(result)}` : JSON.stringify(result);
          messages.push({ role: 'tool', tool_call_id: tc.id, content: resultStr.length > 10000 ? resultStr.slice(0, 10000) + TRUNCATION_MARKER : resultStr });
          registry.reportProgress(taskId, { round: round + 1, lastTool: toolName, snippet: resultStr.slice(0, 200) });
        } catch (err) {
          messages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify({ error: err.message }) });
        }
      }

      if (estimateMessagesLength(messages) > 150000) pruneMessages(messages);
    }

    const lastContent = messages.filter(m => m.role === 'assistant' && m.content).pop()?.content || '';
    registry.complete(taskId, { result: lastContent, summary: lastContent.slice(0, 500) });
    registry.storeMessages(taskId, messages);
    return { status: 'completed', summary: lastContent };
  } catch (err) {
    registry.fail(taskId, err.message);
    registry.storeMessages(taskId, messages);
    return { status: 'failed', error: err.message };
  }
}

/**
 * 估算消息总 token 数（中文约 1 字符/token，英文约 4 字符/token）
 */
function estimateMessagesLength(msgs) {
  return msgs.reduce((sum, m) => {
    const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content || '');
    let len = content.length;
    // 计入 tool_calls 的 arguments，它们也消耗 token
    if (m.tool_calls) {
      for (const tc of m.tool_calls) {
        len += (tc.function?.arguments || '').length;
      }
    }
    return sum + len;
  }, 0);
}

/**
 * 裁剪消息，保留 system + 完整的最近 N 轮对话
 * 一轮 = 从上一个最终回复（无 tool_calls 的 assistant）之后到当前最终回复（含）
 */
function pruneMessages(messages) {
  const systemMsg = messages[0];
  const MAX_ROUNDS = 4;

  // 从末尾往前找每轮的起始位置（一轮以非 tool_call 的 assistant 消息结束）
  const roundStarts = [];
  for (let i = messages.length - 1; i >= 1; i--) {
    const msg = messages[i];
    if (msg.role === 'assistant' && (!msg.tool_calls || msg.tool_calls.length === 0)) {
      roundStarts.push(i);
      if (roundStarts.length >= MAX_ROUNDS) break;
    }
  }

  if (roundStarts.length === 0) return; // 没有完整轮次可裁

  // 保留从最早一轮开始到末尾的所有消息
  const keepFrom = roundStarts[roundStarts.length - 1];
  const kept = messages.slice(keepFrom);

  // 清理开头的孤立 tool 消息（没有对应的 assistant tool_call）
  while (kept.length > 0 && kept[0].role === 'tool') {
    kept.shift();
  }

  messages.length = 0;
  messages.push(systemMsg, ...kept);
}

async function runWithConcurrency(fns, maxConcurrent) {
  const results = new Array(fns.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < fns.length) {
      const index = nextIndex++;
      try {
        results[index] = await fns[index]();
      } catch (err) {
        results[index] = { status: 'failed', error: err.message };
      }
    }
  }

  const workers = Array.from(
    { length: Math.min(maxConcurrent, fns.length) },
    () => worker(),
  );
  await Promise.all(workers);
  return results;
}

module.exports = { delegateTask, continueTask, DEFAULTS };