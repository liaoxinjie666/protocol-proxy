const os = require('os');
const fs = require('fs');
const path = require('path');
const logger = require('../logger');
const { filterToolDefinitions, filterToolHandlers } = require('./blocked-tools');

const DEFAULTS = {
  maxConcurrent: 3,
  maxRounds: 5,
  timeout: 300,         // 秒
  blockedTools: ['delegate_task'],
  autoDenyTools: ['execute_command', 'write_file', 'edit_file'],
};

const TRUNCATION_MARKER = '\n<!-- RESULT_TRUNCATED -->';

function resolveConfig(config) {
  const c = { ...DEFAULTS, ...config };
  c.blockedTools = Array.isArray(c.blockedTools) ? c.blockedTools : DEFAULTS.blockedTools;
  c.autoDenyTools = Array.isArray(c.autoDenyTools) ? c.autoDenyTools : DEFAULTS.autoDenyTools;
  c.maxConcurrent = Math.max(1, Math.min(10, parseInt(c.maxConcurrent) || DEFAULTS.maxConcurrent));
  c.maxRounds = Math.max(1, Math.min(100, parseInt(c.maxRounds) || DEFAULTS.maxRounds));
  c.timeout = Math.max(10, Math.min(600, parseInt(c.timeout) || DEFAULTS.timeout));
  return c;
}

function isPathInside(filePath, scopeDir) {
  const resolved = path.resolve(filePath);
  const scope = path.resolve(scopeDir);
  return resolved === scope || resolved.startsWith(scope + path.sep);
}

/**
 * 为写操作工具包装路径作用域限制（Hermes 级隔离）
 * 读操作不限制，写操作只允许在 scopeDir 内
 */
function wrapHandlersForScope(handlers, scopeDir) {
  const wrapped = { ...handlers };

  // write_file：校验路径在沙盒内
  if (wrapped.write_file) {
    const orig = wrapped.write_file;
    wrapped.write_file = async (args) => {
      const filePath = path.resolve(args.path || '');
      if (!isPathInside(filePath, scopeDir)) {
        return { error: `[SCOPE] 写入被限制在沙盒目录内，不允许写入: ${args.path}` };
      }
      return orig(args);
    };
  }

  // edit_file：校验路径在沙盒内
  if (wrapped.edit_file) {
    const orig = wrapped.edit_file;
    wrapped.edit_file = async (args) => {
      const filePath = path.resolve(args.path || '');
      if (!isPathInside(filePath, scopeDir)) {
        return { error: `[SCOPE] 编辑被限制在沙盒目录内，不允许编辑: ${args.path}` };
      }
      return orig(args);
    };
  }

  // execute_command：沙盒场景下直接拒绝（仅改 cwd 无法阻止命令访问沙盒外路径）
  if (wrapped.execute_command) {
    wrapped.execute_command = async (args) => {
      return { error: '[SCOPE] 子代理不允许执行系统命令，请用其他方式完成任务' };
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

async function delegateTask({
  goals,
  registry,
  proxyUrl,
  proxyHeaders,
  defaultModel,
  toolDefinitions,
  toolHandlers,
  systemPrompt,
  parentTaskId,
  maxRounds,
  sendSSE,
  config,
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

  // 创建任务
  const tasks = goals.map(goal => registry.create({
    objective: typeof goal === 'string' ? goal : goal.objective,
    model: typeof goal === 'object' && goal.model ? goal.model : undefined,
    parentTaskId,
  }));

  // 通知前端：子任务创建
  if (sendSSE) {
    sendSSE('delegate', {
      type: 'created',
      tasks: tasks.map(t => ({ id: t.id, objective: t.objective })),
    });
  }

  // 过滤工具（仅移除阻止列表中的工具，危险工具保留但执行时自动拒绝）
  const baseHandlers = filterToolHandlers(toolHandlers, blockedSet);
  // 只保留有 handler 的工具定义（排除有定义但无处理器的 MCP 工具）
  const allowedTools = filterToolDefinitions(toolDefinitions, blockedSet)
    .filter(d => {
      const name = d.function?.name || d.name;
      return !!baseHandlers[name];
    });

  // 为每个子任务创建沙盒目录并包装工具处理器
  const sandboxBase = path.join(os.tmpdir(), 'agent-sandbox');
  for (const task of tasks) {
    const scopeDir = path.join(sandboxBase, task.id);
    fs.mkdirSync(scopeDir, { recursive: true });
    task._scopeDir = scopeDir;
    task._scopedHandlers = wrapHandlersForScope(baseHandlers, scopeDir);
  }

  // 构建子 Agent 系统提示词
  const denyNames = cfg.autoDenyTools.join('、');
  const childSystemPrompt = systemPrompt
    + '\n\n你是子代理，负责完成特定任务。完成任务后给出简洁的总结。'
    + (blockedSet.size > 0 ? `\n注意：以下工具不可用：${cfg.blockedTools.join('、')}。` : '')
    + (autoDenySet.size > 0 ? `\n部分工具（如 ${denyNames}）可能被限制执行，如被拒绝请换其他方式完成。` : '')
    + '\n请用中文回答。';

  // 并行执行（限制并发数）
  const results = await runWithConcurrency(
    tasks.map(task => () => runChildAgent({
      task,
      registry,
      proxyUrl,
      proxyHeaders,
      defaultModel: task.model || defaultModel,
      allowedTools,
      allowedHandlers: task._scopedHandlers,
      blockedSet,
      autoDenySet,
      childSystemPrompt,
      maxRounds: effectiveMaxRounds,
      childTimeoutMs,
      sendSSE,
    })),
    cfg.maxConcurrent,
  );

  // 清理所有沙盒目录
  for (const task of tasks) {
    if (task._scopeDir) cleanupScope(task._scopeDir);
  }

  // 汇总
  const summary = results.map((r, i) => ({
    taskId: tasks[i].id,
    objective: tasks[i].objective,
    status: r.status,
    summary: r.summary || r.error || '',
  }));

  return {
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
  sendSSE,
}) {
  const abortController = new AbortController();
  registry.start(task.id, abortController);

  if (sendSSE) sendSSE('delegate', { type: 'started', taskId: task.id });

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

      const body = await fetchRes.json();
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
        if (sendSSE) sendSSE('delegate', { type: 'completed', taskId: task.id, summary: summary.slice(0, 200) });
        return { status: 'completed', summary };
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
    return { status: 'completed', summary: lastContent };

  } catch (err) {
    registry.fail(task.id, err.message);
    if (sendSSE) sendSSE('delegate', { type: 'failed', taskId: task.id, error: err.message });
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

module.exports = { delegateTask, DEFAULTS };