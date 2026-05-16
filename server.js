#!/usr/bin/env node
const path = require('path');
const { exec, spawn } = require('child_process');
const os = require('os');
const fs = require('fs');
const logger = require('./lib/logger');

// ==================== CLI ====================

const PID_FILE = path.join(os.tmpdir(), 'protocol-proxy.pid');
const pkg = require('./package.json');

function writePid() {
  try { fs.writeFileSync(PID_FILE, String(process.pid)); } catch (err) {
    console.error('[PID] 写入失败:', err.message);
  }
}

function readPid() {
  try { return parseInt(fs.readFileSync(PID_FILE, 'utf8').trim()); } catch { return null; }
}

function removePid() {
  try { fs.unlinkSync(PID_FILE); } catch (err) {
    if (err.code !== 'ENOENT') {
      console.error('[PID] 删除失败:', err.message);
    }
  }
}

function isProcessAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function showHelp() {
  console.log(`
protocol-proxy - OpenAI / Anthropic 协议转换透明代理

用法:
  protocol-proxy              前台启动服务（Ctrl+C 停止）
  protocol-proxy start        后台启动服务
  protocol-proxy stop         停止后台服务
  protocol-proxy status       查看运行状态
  protocol-proxy help         显示帮助信息
  protocol-proxy -v, --version 显示版本号
  protocol-proxy update       更新到最新版本
`);
}

function startDaemon() {
  const pid = readPid();
  if (pid && isProcessAlive(pid)) {
    console.log(`服务已在运行 (PID: ${pid})`);
    return;
  }

  const child = spawn(process.execPath, [__filename, '--daemon'], {
    detached: true,
    stdio: 'ignore',
  });
  fs.writeFileSync(PID_FILE, String(child.pid));
  child.unref();
  console.log(`服务已在后台启动 (PID: ${child.pid})`);
}

function showVersion() {
  console.log(pkg.version);
}

function showStatus() {
  const pid = readPid();
  if (pid && isProcessAlive(pid)) {
    console.log(`服务正在运行 (PID: ${pid})`);
    const configStore = require('./lib/config-store');
    const proxies = configStore.getProxies();
    if (proxies.length > 0) {
      console.log(`\n已配置的代理 (${proxies.length} 个):`);
      for (const p of proxies) {
        console.log(`  - ${p.name}: 端口 ${p.port} → ${p.target?.providerUrl || '未设置'}`);
      }
    }
  } else {
    removePid();
    console.log('服务未运行');
  }
}

function stopService() {
  const pid = readPid();
  if (!pid || !isProcessAlive(pid)) {
    removePid();
    console.log('服务未运行');
    return;
  }
  try {
    process.kill(pid, 'SIGTERM');
    removePid();
    console.log(`服务已停止 (PID: ${pid})`);
  } catch (err) {
    console.error('停止服务失败:', err.message);
    removePid();
  }
}

function updateService() {
  console.log('正在更新 protocol-proxy...');
  exec('npm install -g protocol-proxy@latest', (err, stdout, stderr) => {
    if (err) {
      console.error('更新失败:', err.message);
      process.exit(1);
    }
    if (stdout) console.log(stdout);
    if (stderr) console.error(stderr);
    console.log('更新完成');
  });
}

// ==================== 启动 ====================

async function init() {
  const express = require('express');
  const cors = require('cors');
  const configStore = require('./lib/config-store');
  const proxyManager = require('./lib/proxy-manager');
  const statsStore = require('./lib/stats-store');
  const mcpClient = require('./lib/mcp-client');

  const app = express();
  const PORT = process.env.ADMIN_PORT || 3000;

  function openBrowser(url) {
    const platform = os.platform();
    let command;
    if (platform === 'win32') {
      command = `start "" "${url}"`;
    } else if (platform === 'darwin') {
      command = `open "${url}"`;
    } else {
      command = `xdg-open "${url}"`;
    }
    exec(command, (err) => {
      if (err) logger.error('[Browser] 打开浏览器失败:', err.message);
    });
  }

  app.use(cors());
  app.use(express.json({ limit: '10mb' }));

  // 访问日志
  app.use((req, res, next) => {
    const start = Date.now();
    res.on('finish', () => {
      const duration = Date.now() - start;
      logger.log(`[HTTP] ${req.method} ${req.path} - ${res.statusCode} (${duration}ms)`);
    });
    next();
  });

  app.use(express.static(path.join(__dirname, 'public')));

  // ==================== 辅助函数 ====================

  function resolveTarget(proxy) {
    const primaryProvider = configStore.getProviderById(proxy.providerId);
    if (!primaryProvider) return null;

    const pool = [];
    const seen = new Set();

    // Primary provider (no model override)
    const primaryKey = `${primaryProvider.id}\0`;
    seen.add(primaryKey);
    pool.push({
      providerId: primaryProvider.id,
      providerName: primaryProvider.name,
      providerUrl: primaryProvider.url,
      protocol: primaryProvider.protocol,
      apiKeys: primaryProvider.apiKeys || [],
      models: primaryProvider.models,
      azureDeployment: primaryProvider.azureDeployment || '',
      azureApiVersion: primaryProvider.azureApiVersion || '',
      model: '',
      weight: Math.max(1, parseInt(proxy.providerWeight, 10) || 1),
    });

    // Pool entries (may include model override)
    for (const entry of (proxy.providerPool || [])) {
      if (!entry || !entry.providerId) continue;
      const model = typeof entry.model === 'string' ? entry.model.trim() : '';
      const key = `${entry.providerId}\0${model}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const provider = configStore.getProviderById(entry.providerId);
      if (!provider) continue;
      pool.push({
        providerId: provider.id,
        providerName: provider.name,
        providerUrl: provider.url,
        protocol: provider.protocol,
        apiKeys: provider.apiKeys || [],
        models: provider.models,
        azureDeployment: provider.azureDeployment || '',
        azureApiVersion: provider.azureApiVersion || '',
        model,
        weight: Math.max(1, parseInt(entry.weight, 10) || 1),
      });
    }

    if (pool.length === 0) return null;

    return {
      protocol: pool[0].protocol,
      routingStrategy: proxy.routingStrategy || 'primary_fallback',
      providerPool: pool,
      defaultModel: proxy.defaultModel,
    };
  }

  function normalizeProviderPoolInput(pool) {
    if (!Array.isArray(pool)) return [];
    const seen = new Set();
    const result = [];
    for (const item of pool) {
      if (!item || typeof item !== 'object') continue;
      const providerId = typeof item.providerId === 'string' ? item.providerId.trim() : '';
      if (!providerId) continue;
      const model = typeof item.model === 'string' ? item.model.trim() : '';
      const key = `${providerId}\0${model}`;
      if (seen.has(key)) continue;
      seen.add(key);
      result.push({
        providerId,
        model,
        weight: Math.max(1, parseInt(item.weight, 10) || 1),
      });
    }
    return result;
  }

  function normalizeRoutingStrategyInput(strategy) {
    return ['primary_fallback', 'round_robin', 'weighted', 'fastest'].includes(strategy)
      ? strategy
      : 'primary_fallback';
  }

  // ==================== Token 估算与会话压缩 ====================

  function estimateMessageTokens(msg) {
    const len = (s) => (typeof s === 'string' ? s.length : JSON.stringify(s || '').length);
    let chars = 0;
    if (typeof msg.content === 'string') chars += len(msg.content);
    else if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        // 多模态格式：只取文本内容，不序列化整个对象
        if (typeof block === 'string') chars += len(block);
        else if (block?.text) chars += len(block.text);
        else if (block?.content) chars += len(block.content);
        else chars += len(block); // fallback
      }
    }
    if (msg.reasoning_content) chars += len(msg.reasoning_content);
    if (msg.tool_calls) {
      for (const tc of msg.tool_calls) {
        chars += len(tc.function?.name || '') + len(tc.function?.arguments || '');
      }
    }
    // chars/2 对中文更保守（中文 ~1-2 token/字），宁可高估触发压缩也别低估撑爆上下文
    return Math.ceil(chars / 2) + 4;
  }

  function estimateConversationTokens(messages) {
    return messages.reduce((sum, m) => sum + estimateMessageTokens(m), 0);
  }

  async function compressConversation(conv, maxContext, proxyUrl, proxyHeaders, defaultModel) {
    const messages = conv.messages;
    const PRESERVE_RECENT = 6;

    // 提取之前的压缩摘要（存储在 conv.compressionSummary 中）
    let existingSummary = conv.compressionSummary || '';

    // 分割：旧消息（压缩）和新消息（保留）
    let keepFrom = messages.length - PRESERVE_RECENT;
    // 边界处理：向后扫描，不拆开 assistant(tool_calls) + tool 配对
    while (keepFrom > 0) {
      const msg = messages[keepFrom];
      if (msg?.role === 'tool') {
        let j = keepFrom - 1;
        while (j > 0 && messages[j]?.role === 'tool') j--;
        if (messages[j]?.role === 'assistant' && messages[j]?.tool_calls) {
          keepFrom = j;
        }
        break;
      }
      break;
    }

    const oldMessages = messages.slice(0, keepFrom);
    const recentMessages = messages.slice(keepFrom);

    if (oldMessages.length === 0) return null;

    // 构建启发式摘要信息
    const userMsgs = oldMessages.filter(m => m.role === 'user').length;
    const assistantMsgs = oldMessages.filter(m => m.role === 'assistant').length;
    const toolMsgs = oldMessages.filter(m => m.role === 'tool').length;
    const toolNames = [...new Set(
      oldMessages.filter(m => m.tool_calls).flatMap(m => m.tool_calls.map(tc => tc.function?.name)).filter(Boolean)
    )];

    const stats = [
      `- 范围: ${oldMessages.length} 条旧消息 (user=${userMsgs}, assistant=${assistantMsgs}, tool=${toolMsgs})`,
      toolNames.length > 0 ? `- 使用的工具: ${toolNames.join(', ')}` : null,
      existingSummary ? `- 之前的摘要:\n${existingSummary}` : null,
    ].filter(Boolean).join('\n');

    const recentUserMsgs = oldMessages.filter(m => m.role === 'user').slice(-3)
      .map(m => typeof m.content === 'string' ? m.content.slice(0, 200) : '').filter(Boolean);

    // 调用 LLM 生成摘要
    const compressPrompt = `请将以下对话历史压缩为简洁的摘要。保留所有关键信息：用户的问题意图、发现的问题、工具调用的关键结果、得出的结论和建议。

对话统计:
${stats}

最近的用户问题:
${recentUserMsgs.map((m, i) => `${i + 1}. ${m}`).join('\n')}

请用中文输出摘要，格式：
1. 用户的主要目标/问题
2. 已完成的调查/操作
3. 关键发现和结论
4. 未完成的工作（如有）

摘要控制在 500 字以内。`;

    let summary;
    try {
      const res = await fetch(proxyUrl, {
        method: 'POST',
        headers: proxyHeaders,
        signal: AbortSignal.timeout(60000),
        body: JSON.stringify({
          model: defaultModel || 'gpt-4o',
          messages: [
            { role: 'system', content: '你是一个对话摘要助手。简洁准确地总结对话要点。' },
            { role: 'user', content: compressPrompt },
          ],
          max_tokens: 1024,
          stream: false,
        }),
      });
      if (res.ok) {
        const data = await res.json();
        summary = data.choices?.[0]?.message?.content || '';
      }
    } catch (err) {
      logger.log(`[compress] LLM 摘要失败: ${err.message}`);
    }

    // LLM 失败 → 启发式降级
    if (!summary) {
      const lastAssistant = oldMessages.filter(m => m.role === 'assistant' && m.content).pop();
      const userQuestions = oldMessages.filter(m => m.role === 'user')
        .map(m => typeof m.content === 'string' ? m.content.slice(0, 100) : '')
        .filter(Boolean).slice(-3);
      summary = stats +
        (userQuestions.length ? '\n- 最近用户问题:\n' + userQuestions.map((q, i) => `  ${i + 1}. ${q}`).join('\n') : '') +
        '\n- 最近内容: ' + (lastAssistant?.content || '').slice(0, 300);
      logger.log('[compress] 使用启发式降级摘要');
    }

    // 重建消息数组（不含 system 消息，由 buildMessages() 负责注入）
    const newMessages = [...recentMessages];
    const newTokens = estimateConversationTokens(newMessages);
    return { messages: newMessages, summary, removedCount: oldMessages.length, newTokens };
  }

  // ==================== 助手工具定义与执行器 ====================

  const MAX_TOOL_OUTPUT = 16384; // 16KB — 防止工具输出撑爆 LLM 上下文

  function truncateOutput(obj) {
    const str = typeof obj === 'string' ? obj : JSON.stringify(obj);
    if (str.length <= MAX_TOOL_OUTPUT) return obj;
    const truncated = str.slice(0, MAX_TOOL_OUTPUT);
    return { _truncated: true, _original_bytes: str.length, _preview: truncated + '\n... [截断，原始输出 ' + str.length + ' 字符]' };
  }

  const TOOL_DEFINITIONS = [
    {
      type: 'function',
      function: {
        name: 'get_system_status',
        description: '获取系统概览：所有代理的运行状态、供应商数量、系统运行时长。',
        parameters: { type: 'object', properties: {}, required: [] },
      },
    },
    {
      type: 'function',
      function: {
        name: 'get_providers',
        description: '获取所有供应商列表，包含协议、Key 数量和健康状态。',
        parameters: { type: 'object', properties: {}, required: [] },
      },
    },
    {
      type: 'function',
      function: {
        name: 'get_provider',
        description: '根据 ID 获取单个供应商的详细信息。',
        parameters: {
          type: 'object',
          properties: { providerId: { type: 'string', description: '供应商 ID' } },
          required: ['providerId'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'get_proxies',
        description: '获取所有代理列表，包含端口、运行状态、关联供应商和路由策略。',
        parameters: { type: 'object', properties: {}, required: [] },
      },
    },
    {
      type: 'function',
      function: {
        name: 'get_proxy',
        description: '根据 ID 获取单个代理的详细信息。',
        parameters: {
          type: 'object',
          properties: { proxyId: { type: 'string', description: '代理 ID' } },
          required: ['proxyId'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'get_usage_stats',
        description: '查询用量统计，支持按时间范围、代理筛选。返回请求数和 Token 用量。',
        parameters: {
          type: 'object',
          properties: {
            range: { type: 'string', enum: ['hourly', 'daily', 'monthly', 'yearly'], description: '统计粒度，默认 daily' },
            startDate: { type: 'string', description: '起始日期，格式 YYYY-MM-DD' },
            endDate: { type: 'string', description: '结束日期，格式 YYYY-MM-DD' },
            proxyId: { type: 'string', description: '按代理 ID 筛选' },
          },
          required: [],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'get_recent_requests',
        description: '获取最近的请求日志，包含状态、延迟、模型、Token 用量等。',
        parameters: {
          type: 'object',
          properties: {
            limit: { type: 'number', description: '返回条数，默认 20，最大 100' },
          },
          required: [],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'get_system_logs',
        description: '获取最近的系统日志（倒序），用于排查错误和异常。',
        parameters: {
          type: 'object',
          properties: {
            limit: { type: 'number', description: '返回行数，默认 30，最大 100' },
          },
          required: [],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'get_key_health',
        description: '获取所有供应商的 API Key 健康检查结果，包含每个 Key 的状态和错误信息。',
        parameters: { type: 'object', properties: {}, required: [] },
      },
    },
    {
      type: 'function',
      function: {
        name: 'get_settings',
        description: '获取系统设置项。',
        parameters: { type: 'object', properties: {}, required: [] },
      },
    },
    {
      type: 'function',
      function: {
        name: 'get_config_history',
        description: '获取配置快照历史列表，可用于了解配置变更记录。',
        parameters: { type: 'object', properties: {}, required: [] },
      },
    },
    {
      type: 'function',
      function: {
        name: 'read_file',
        description: '读取文件内容。可以读取任意文件。',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: '文件的绝对路径或相对于工作目录的路径' },
            offset: { type: 'number', description: '从第几行开始读（从 0 开始），默认 0' },
            limit: { type: 'number', description: '最多读取多少行，默认 500' },
          },
          required: ['path'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'write_file',
        description: '写入文件内容。如果文件不存在会创建（含父目录）。会覆盖已有内容。',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: '文件的绝对路径或相对于工作目录的路径' },
            content: { type: 'string', description: '要写入的内容' },
          },
          required: ['path', 'content'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'list_directory',
        description: '列出目录下的文件和子目录。',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: '目录路径，默认为当前工作目录' },
          },
          required: [],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'search_files',
        description: '按文件名模式搜索文件，支持通配符（如 *.js、**/*.log）。',
        parameters: {
          type: 'object',
          properties: {
            pattern: { type: 'string', description: 'glob 模式，如 "**/*.js" 或 "src/**/*.ts"' },
            path: { type: 'string', description: '搜索根目录，默认为当前工作目录' },
          },
          required: ['pattern'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'execute_command',
        description: '执行 shell 命令并返回输出。可以执行任意命令。',
        parameters: {
          type: 'object',
          properties: {
            command: { type: 'string', description: '要执行的 shell 命令' },
            cwd: { type: 'string', description: '工作目录，默认为当前工作目录' },
            timeout: { type: 'number', description: '超时时间（毫秒），默认 30000' },
          },
          required: ['command'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'edit_file',
        description: '精确替换文件中的字符串。比 write_file 更安全，只替换匹配的内容，不会覆盖整个文件。',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: '文件路径' },
            old_string: { type: 'string', description: '要被替换的原始字符串（必须精确匹配）' },
            new_string: { type: 'string', description: '替换后的新字符串' },
            replace_all: { type: 'boolean', description: '是否替换所有匹配项，默认 false（只替换第一个）' },
          },
          required: ['path', 'old_string', 'new_string'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'grep_search',
        description: '在文件内容中搜索正则表达式模式。用于查找代码、日志关键字等。',
        parameters: {
          type: 'object',
          properties: {
            pattern: { type: 'string', description: '正则表达式模式' },
            path: { type: 'string', description: '搜索目录或文件路径，默认当前工作目录' },
            glob: { type: 'string', description: '文件名过滤，如 "*.js" 或 "*.log"' },
            max_results: { type: 'number', description: '最大返回匹配数，默认 50' },
          },
          required: ['pattern'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'invoke_skill',
        description: '调用指定的技能，获取其指令内容。当用户输入 /技能名 或需要执行预定义流程时使用。',
        parameters: {
          type: 'object',
          properties: {
            name: { type: 'string', description: '技能名称' },
          },
          required: ['name'],
        },
      },
    },
    // --- 供应商管理 ---
    {
      type: 'function',
      function: {
        name: 'create_provider',
        description: '创建新的供应商。需提供名称、URL 和协议（默认自动检测）。',
        parameters: {
          type: 'object',
          properties: {
            name: { type: 'string', description: '供应商名称' },
            url: { type: 'string', description: '供应商 API 地址' },
            protocol: { type: 'string', enum: ['openai', 'anthropic', 'gemini'], description: '协议类型，默认自动检测' },
            apiKey: { type: 'string', description: 'API Key（单个）' },
            apiKeys: { type: 'array', items: { type: 'object', properties: { key: { type: 'string' }, alias: { type: 'string' } } }, description: '多个 API Key 数组' },
            models: { type: 'array', items: { type: 'string' }, description: '可用模型列表' },
          },
          required: ['name', 'url'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'update_provider',
        description: '更新供应商配置。只传需要修改的字段即可。',
        parameters: {
          type: 'object',
          properties: {
            providerId: { type: 'string', description: '供应商 ID' },
            name: { type: 'string', description: '新的名称' },
            url: { type: 'string', description: '新的 URL' },
            protocol: { type: 'string', enum: ['openai', 'anthropic', 'gemini'], description: '新的协议' },
            apiKey: { type: 'string', description: '新的 API Key' },
            models: { type: 'array', items: { type: 'string' }, description: '新的模型列表' },
          },
          required: ['providerId'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'delete_provider',
        description: '删除供应商。如果有代理正在使用该供应商则无法删除。',
        parameters: {
          type: 'object',
          properties: {
            providerId: { type: 'string', description: '供应商 ID' },
          },
          required: ['providerId'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'test_provider_keys',
        description: '测试供应商的 API Key 是否可用，返回每个 Key 的连通状态和延迟。',
        parameters: {
          type: 'object',
          properties: {
            providerId: { type: 'string', description: '供应商 ID' },
          },
          required: ['providerId'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'get_provider_models',
        description: '从供应商 API 拉取实际可用的模型列表。',
        parameters: {
          type: 'object',
          properties: {
            providerId: { type: 'string', description: '供应商 ID' },
          },
          required: ['providerId'],
        },
      },
    },
    // --- 代理管理 ---
    {
      type: 'function',
      function: {
        name: 'create_proxy',
        description: '创建新代理并自动启动。需要指定名称、端口和关联的供应商 ID。',
        parameters: {
          type: 'object',
          properties: {
            name: { type: 'string', description: '代理名称' },
            port: { type: 'number', description: '监听端口（不能与已有代理冲突）' },
            providerId: { type: 'string', description: '关联的供应商 ID' },
            defaultModel: { type: 'string', description: '默认模型名' },
            routingStrategy: { type: 'string', enum: ['primary_fallback', 'round_robin', 'weighted', 'fastest'], description: '路由策略' },
          },
          required: ['name', 'port', 'providerId'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'update_proxy',
        description: '更新代理配置。只传需要修改的字段即可。修改端口会自动重启代理。',
        parameters: {
          type: 'object',
          properties: {
            proxyId: { type: 'string', description: '代理 ID' },
            name: { type: 'string', description: '新名称' },
            port: { type: 'number', description: '新端口' },
            providerId: { type: 'string', description: '新的供应商 ID' },
            defaultModel: { type: 'string', description: '新的默认模型' },
            routingStrategy: { type: 'string', enum: ['primary_fallback', 'round_robin', 'weighted', 'fastest'], description: '新的路由策略' },
          },
          required: ['proxyId'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'delete_proxy',
        description: '删除代理，会先停止其运行。',
        parameters: {
          type: 'object',
          properties: {
            proxyId: { type: 'string', description: '代理 ID' },
          },
          required: ['proxyId'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'start_proxy',
        description: '启动指定代理。',
        parameters: {
          type: 'object',
          properties: {
            proxyId: { type: 'string', description: '代理 ID' },
          },
          required: ['proxyId'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'stop_proxy',
        description: '停止指定代理。',
        parameters: {
          type: 'object',
          properties: {
            proxyId: { type: 'string', description: '代理 ID' },
          },
          required: ['proxyId'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'start_all_proxies',
        description: '批量启动所有代理。已在运行中的会跳过。',
        parameters: { type: 'object', properties: {}, required: [] },
      },
    },
    {
      type: 'function',
      function: {
        name: 'stop_all_proxies',
        description: '批量停止所有运行中的代理。',
        parameters: { type: 'object', properties: {}, required: [] },
      },
    },
    // --- MCP 服务器管理 ---
    {
      type: 'function',
      function: {
        name: 'get_mcp_servers',
        description: '获取所有 MCP 服务器列表及运行状态。',
        parameters: { type: 'object', properties: {}, required: [] },
      },
    },
    {
      type: 'function',
      function: {
        name: 'add_mcp_server',
        description: '添加新的 MCP 服务器。本地进程用 command，远程服务用 url。',
        parameters: {
          type: 'object',
          properties: {
            name: { type: 'string', description: '服务名称' },
            command: { type: 'string', description: '本地进程启动命令（如 npx、uvx）' },
            args: { type: 'array', items: { type: 'string' }, description: '命令参数' },
            env: { type: 'object', description: '环境变量' },
            url: { type: 'string', description: '远程 MCP 服务 URL' },
            headers: { type: 'object', description: 'HTTP 请求头' },
          },
          required: ['name'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'update_mcp_server',
        description: '更新 MCP 服务器配置。',
        parameters: {
          type: 'object',
          properties: {
            name: { type: 'string', description: '服务名称' },
            command: { type: 'string', description: '新的启动命令' },
            args: { type: 'array', items: { type: 'string' }, description: '新的参数' },
            env: { type: 'object', description: '新的环境变量' },
            url: { type: 'string', description: '新的 URL' },
            enabled: { type: 'boolean', description: '是否启用' },
          },
          required: ['name'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'delete_mcp_server',
        description: '删除 MCP 服务器，会先断开连接。',
        parameters: {
          type: 'object',
          properties: {
            name: { type: 'string', description: '服务名称' },
          },
          required: ['name'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'connect_mcp_server',
        description: '连接指定的 MCP 服务器。',
        parameters: {
          type: 'object',
          properties: {
            name: { type: 'string', description: '服务名称' },
          },
          required: ['name'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'disconnect_mcp_server',
        description: '断开指定的 MCP 服务器。',
        parameters: {
          type: 'object',
          properties: {
            name: { type: 'string', description: '服务名称' },
          },
          required: ['name'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'get_mcp_tools',
        description: '获取所有已连接 MCP 服务器提供的工具列表。',
        parameters: { type: 'object', properties: {}, required: [] },
      },
    },
    // --- 技能管理 ---
    {
      type: 'function',
      function: {
        name: 'get_skills',
        description: '获取所有已创建的技能列表。',
        parameters: { type: 'object', properties: {}, required: [] },
      },
    },
    {
      type: 'function',
      function: {
        name: 'create_skill',
        description: '创建新技能。技能是预定义的指令模板，用户可通过 /技能名 触发。',
        parameters: {
          type: 'object',
          properties: {
            name: { type: 'string', description: '技能名称（英文、数字、下划线、连字符）' },
            description: { type: 'string', description: '技能描述' },
            content: { type: 'string', description: '技能指令内容（Markdown 格式）' },
          },
          required: ['name', 'content'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'update_skill',
        description: '更新现有技能的描述或指令内容。',
        parameters: {
          type: 'object',
          properties: {
            name: { type: 'string', description: '技能名称' },
            description: { type: 'string', description: '新的描述' },
            content: { type: 'string', description: '新的指令内容' },
          },
          required: ['name'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'delete_skill',
        description: '删除技能。系统级技能不可删除。',
        parameters: {
          type: 'object',
          properties: {
            name: { type: 'string', description: '技能名称' },
          },
          required: ['name'],
        },
      },
    },
    // --- 配置管理 ---
    {
      type: 'function',
      function: {
        name: 'export_config',
        description: '导出当前系统配置（供应商和代理），可用于备份或迁移。',
        parameters: { type: 'object', properties: {}, required: [] },
      },
    },
    {
      type: 'function',
      function: {
        name: 'import_config',
        description: '导入配置。overwrite 模式替换全部，merge 模式按 ID 合并。',
        parameters: {
          type: 'object',
          properties: {
            config: {
              type: 'object',
              description: '配置对象，包含 providers 和 proxies 数组',
              properties: {
                providers: { type: 'array', description: '供应商数组' },
                proxies: { type: 'array', description: '代理数组' },
              },
            },
            mode: { type: 'string', enum: ['overwrite', 'merge'], description: '导入模式' },
          },
          required: ['config', 'mode'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'rollback_config',
        description: '回滚到指定的配置快照。',
        parameters: {
          type: 'object',
          properties: {
            file: { type: 'string', description: '快照文件名（从 get_config_history 获取）' },
          },
          required: ['file'],
        },
      },
    },
    // --- 系统操作 ---
    {
      type: 'function',
      function: {
        name: 'update_settings',
        description: '更新系统设置。传入需要修改的键值对即可。',
        parameters: {
          type: 'object',
          properties: {
            settings: { type: 'object', description: '要更新的设置键值对' },
          },
          required: ['settings'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'trigger_key_health_check',
        description: '手动触发所有供应商的 API Key 健康检查。',
        parameters: { type: 'object', properties: {}, required: [] },
      },
    },
    {
      type: 'function',
      function: {
        name: 'check_health',
        description: '系统健康检查，返回版本、运行时长、代理状态。',
        parameters: { type: 'object', properties: {}, required: [] },
      },
    },
  ];

  const TOOL_HANDLERS = {
    get_system_status: async () => {
      const proxies = configStore.getProxies().map(p => {
        const provider = configStore.getProviderById(p.providerId);
        return { name: p.name, port: p.port, running: proxyManager.isRunning(p.id), providerName: provider?.name || '' };
      });
      return { proxies, providerCount: configStore.getProviders().length, uptime: Math.floor(process.uptime()) };
    },

    get_providers: async () => {
      return configStore.getProviders().map(p => {
        const h = keyHealth.get(p.id);
        let healthStatus = '未检测';
        if (h) {
          const ok = h.keys?.filter(k => k.ok).length || 0;
          const total = h.keys?.length || 0;
          healthStatus = h.status === 'healthy' ? `健康 (${ok}/${total})` :
            h.status === 'partial' ? `部分异常 (${ok}/${total})` :
            h.status === 'unhealthy' ? `异常 (${ok}/${total})` : '未检测';
        }
        return { id: p.id, name: p.name, url: p.url, protocol: p.protocol, keyCount: (p.apiKeys || []).length, health: healthStatus };
      });
    },

    get_provider: async (args) => {
      const p = configStore.getProviderById(args.providerId);
      if (!p) return { error: `供应商 ${args.providerId} 不存在` };
      const h = keyHealth.get(p.id);
      return { id: p.id, name: p.name, url: p.url, protocol: p.protocol, apiKeys: (p.apiKeys || []).map((k, i) => ({ index: i, alias: k.alias || '', enabled: k.enabled !== false })), health: h || null };
    },

    get_proxies: async () => {
      return configStore.getProxies().map(p => {
        const provider = configStore.getProviderById(p.providerId);
        return { id: p.id, name: p.name, port: p.port, running: proxyManager.isRunning(p.id), providerName: provider?.name || '', protocol: provider?.protocol || '', defaultModel: p.defaultModel || '', routingStrategy: p.routingStrategy || 'primary_fallback' };
      });
    },

    get_proxy: async (args) => {
      const p = configStore.getProxyById(args.proxyId);
      if (!p) return { error: `代理 ${args.proxyId} 不存在` };
      const provider = configStore.getProviderById(p.providerId);
      return { id: p.id, name: p.name, port: p.port, running: proxyManager.isRunning(p.id), providerName: provider?.name || '', protocol: provider?.protocol || '', defaultModel: p.defaultModel || '', routingStrategy: p.routingStrategy || 'primary_fallback', requireAuth: !!p.requireAuth };
    },

    get_usage_stats: async (args) => {
      return statsStore.getStats({ range: args.range || 'daily', startDate: args.startDate, endDate: args.endDate, proxyId: args.proxyId });
    },

    get_recent_requests: async (args) => {
      const limit = Math.min(Math.max(1, parseInt(args.limit) || 20), 100);
      return { entries: requestLog.getAll(limit) };
    },

    get_system_logs: async (args) => {
      const limit = Math.min(Math.max(1, parseInt(args.limit) || 30), 100);
      try {
        const content = await fs.promises.readFile(logger.LOG_FILE, 'utf8');
        const allLines = content.split('\n').filter(l => l.trim());
        return { lines: allLines.slice(-limit) };
      } catch {
        return { lines: [] };
      }
    },

    get_key_health: async () => {
      const result = {};
      for (const [providerId, health] of keyHealth) {
        result[providerId] = health;
      }
      return result;
    },

    get_settings: async () => {
      return configStore.getSettings();
    },

    get_config_history: async () => {
      return { snapshots: configStore.getSnapshots() };
    },

    read_file: async (args) => {
      const filePath = path.resolve(args.path);
      try {
        // 二进制检测：检查前 8KB 是否含 NUL 字节
        const stat = await fs.promises.stat(filePath);
        const peekSize = Math.min(8192, stat.size);
        if (peekSize > 0) {
          const fd = await fs.promises.open(filePath, 'r');
          try {
            const buf = Buffer.alloc(peekSize);
            await fd.read(buf, 0, peekSize, 0);
            if (buf.includes(0)) {
              return { error: `二进制文件，无法以文本方式读取 (${filePath}, ${stat.size} bytes)` };
            }
          } finally {
            await fd.close();
          }
        }
        const content = await fs.promises.readFile(filePath, 'utf8');
        const lines = content.split('\n');
        const offset = Math.max(0, parseInt(args.offset) || 0);
        const limit = Math.min(Math.max(1, parseInt(args.limit) || 500), 2000);
        const sliced = lines.slice(offset, offset + limit);
        return { content: sliced.join('\n'), totalLines: lines.length, offset, returnedLines: sliced.length };
      } catch (err) {
        return { error: err.message };
      }
    },

    write_file: async (args) => {
      const filePath = path.resolve(args.path);
      try {
        await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
        await fs.promises.writeFile(filePath, args.content, 'utf8');
        return { success: true, path: filePath, bytes: Buffer.byteLength(args.content, 'utf8') };
      } catch (err) {
        return { error: err.message };
      }
    },

    list_directory: async (args) => {
      const dirPath = path.resolve(args.path || '.');
      try {
        const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
        return {
          path: dirPath,
          entries: entries.map(e => ({
            name: e.name,
            type: e.isDirectory() ? 'directory' : 'file',
          })),
        };
      } catch (err) {
        return { error: err.message };
      }
    },

    search_files: async (args) => {
      const root = path.resolve(args.path || '.');
      const pattern = args.pattern;
      try {
        const results = [];
        const globToRegex = (g) => {
          const r = g.replace(/\*\*/g, '§GLOBSTAR§')
                     .replace(/\*/g, '[^/]*')
                     .replace(/\?/g, '[^/]')
                     .replace(/§GLOBSTAR§/g, '.*');
          return new RegExp('^' + r + '$');
        };
        const regex = globToRegex(pattern);
        const walk = async (dir, rel) => {
          const entries = await fs.promises.readdir(dir, { withFileTypes: true });
          for (const e of entries) {
            const fullPath = path.join(dir, e.name);
            const relPath = rel ? `${rel}/${e.name}` : e.name;
            if (e.isDirectory()) {
              if (e.name === 'node_modules' || e.name === '.git') continue;
              await walk(fullPath, relPath);
            } else if (regex.test(relPath)) {
              results.push(relPath);
            }
          }
        };
        await walk(root, '');
        return { pattern, root, matches: results.slice(0, 200), total: results.length };
      } catch (err) {
        return { error: err.message };
      }
    },

    execute_command: async (args) => {
      const timeout = Math.min(Math.max(1000, parseInt(args.timeout) || 30000), 120000);
      return new Promise((resolve) => {
        exec(args.command, { cwd: args.cwd || process.cwd(), timeout, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
          if (err) {
            resolve({ exitCode: err.code || 1, stdout: stdout || '', stderr: stderr || err.message });
          } else {
            resolve({ exitCode: 0, stdout: stdout || '', stderr: stderr || '' });
          }
        });
      });
    },

    edit_file: async (args) => {
      const filePath = path.resolve(args.path);
      try {
        const content = await fs.promises.readFile(filePath, 'utf8');
        const { old_string, new_string } = args;
        if (old_string === new_string) return { error: 'old_string 和 new_string 不能相同' };
        if (!content.includes(old_string)) return { error: `文件中未找到匹配的字符串` };
        const replaceAll = !!args.replace_all;
        const newContent = replaceAll
          ? content.split(old_string).join(new_string)
          : content.replace(old_string, new_string);
        const count = replaceAll
          ? content.split(old_string).length - 1
          : 1;
        await fs.promises.writeFile(filePath, newContent, 'utf8');
        return { success: true, path: filePath, replacements: count };
      } catch (err) {
        return { error: err.message };
      }
    },

    grep_search: async (args) => {
      const root = path.resolve(args.path || '.');
      const pattern = args.pattern;
      const maxResults = Math.min(Math.max(1, parseInt(args.max_results) || 50), 200);
      const globFilter = args.glob || '';
      try {
        const regex = new RegExp(pattern, 'gi');
        const results = [];
        const walk = async (dir) => {
          if (results.length >= maxResults) return;
          const entries = await fs.promises.readdir(dir, { withFileTypes: true });
          for (const e of entries) {
            if (results.length >= maxResults) break;
            const fullPath = path.join(dir, e.name);
            if (e.isDirectory()) {
              if (['node_modules', '.git', 'dist', 'build', '.next'].includes(e.name)) continue;
              await walk(fullPath);
            } else if (e.isFile()) {
              if (globFilter) {
                const ext = '.' + e.name.split('.').pop();
                if (!globFilter.includes(ext) && !globFilter.includes(e.name) && !globFilter.includes('*')) continue;
              }
              try {
                const content = await fs.promises.readFile(fullPath, 'utf8');
                const lines = content.split('\n');
                for (let i = 0; i < lines.length; i++) {
                  if (results.length >= maxResults) break;
                  if (regex.test(lines[i])) {
                    results.push({
                      file: path.relative(root, fullPath),
                      line: i + 1,
                      content: lines[i].trim().slice(0, 300),
                    });
                    regex.lastIndex = 0;
                  }
                }
              } catch {}
            }
          }
        };
        await walk(root);
        return { pattern, matches: results, total: results.length };
      } catch (err) {
        return { error: err.message };
      }
    },
    invoke_skill: async (args) => {
      const skill = skillStore.get(args.name);
      if (!skill) return { error: `技能 "${args.name}" 不存在` };
      const result = { name: skill.name, description: skill.description, content: skill.content, dirPath: skill.dirPath };
      if (skill.scripts.length > 0) result.scripts = skill.scripts.map(f => `scripts/${f}`);
      if (skill.references.length > 0) result.references = skill.references.map(f => `reference/${f}`);
      // 读取 reference 文件内容（文本文件）
      for (const ref of skill.references) {
        try {
          const refPath = path.join(skill.dirPath, 'reference', ref);
          const stat = fs.statSync(refPath);
          if (stat.size < 50000) { // 只读小于 50KB 的文本文件
            result[`reference:${ref}`] = fs.readFileSync(refPath, 'utf8');
          }
        } catch {}
      }
      return result;
    },

    // --- 供应商管理 ---
    create_provider: async (args) => {
      if (!args.name || !args.url) return { error: 'name 和 url 是必填项' };
      const provider = configStore.addProvider({
        name: args.name,
        url: args.url,
        protocol: args.protocol || (/anthropic/i.test(args.url) ? 'anthropic' : 'openai'),
        apiKey: args.apiKey || '',
        apiKeys: Array.isArray(args.apiKeys) ? args.apiKeys.filter(k => k && k.key && k.key.trim()) : [],
        models: args.models || [],
      });
      return { success: true, id: provider.id, name: provider.name };
    },

    update_provider: async (args) => {
      const existing = configStore.getProviderById(args.providerId);
      if (!existing) return { error: `供应商 ${args.providerId} 不存在` };
      const updates = {};
      if (args.name !== undefined) updates.name = args.name;
      if (args.url !== undefined) updates.url = args.url;
      if (args.protocol !== undefined) updates.protocol = args.protocol;
      if (args.apiKey !== undefined && args.apiKey !== '') updates.apiKey = args.apiKey;
      if (args.apiKeys !== undefined) {
        updates.apiKeys = Array.isArray(args.apiKeys) ? args.apiKeys.filter(k => k && k.key && k.key.trim()) : [];
      }
      if (args.models !== undefined) updates.models = args.models;
      const updated = configStore.updateProvider(args.providerId, updates);
      // 同步更新引用此供应商的运行中代理
      const affectedProxies = configStore.getProxies().filter(p => p.providerId === args.providerId);
      for (const proxy of affectedProxies) {
        if (!proxyManager.isRunning(proxy.id)) continue;
        const target = resolveTarget(proxy);
        if (target) proxyManager.updateProxyConfig({ ...proxy, target });
      }
      return { success: true, id: updated.id, name: updated.name };
    },

    delete_provider: async (args) => {
      const existing = configStore.getProviderById(args.providerId);
      if (!existing) return { error: `供应商 ${args.providerId} 不存在` };
      const inUse = configStore.getProxies().some(p => p.providerId === args.providerId);
      if (inUse) return { error: '该供应商正在被代理使用，无法删除' };
      configStore.removeProvider(args.providerId);
      return { success: true };
    },

    test_provider_keys: async (args) => {
      const provider = configStore.getProviderById(args.providerId);
      if (!provider) return { error: `供应商 ${args.providerId} 不存在` };
      const existingKeys = provider.apiKeys || [];
      if (existingKeys.length === 0) return { ok: false, message: '没有可用的 API Key', results: [] };
      const protocol = provider.protocol || 'openai';
      const base = provider.url.replace(/\/$/, '');
      const hasV1Suffix = base.endsWith('/v1');
      const isAzure = protocol === 'openai' && !!provider.azureDeployment;

      function buildTestUrl(key) {
        if (protocol === 'openai') {
          if (isAzure) {
            const ver = provider.azureApiVersion || '2024-02-01';
            return { url: `${base}/openai/deployments/${provider.azureDeployment}/models?api-version=${ver}`, opts: { headers: { 'api-key': key } } };
          }
          return { url: hasV1Suffix ? `${base}/models` : `${base}/v1/models`, opts: { headers: { 'Authorization': `Bearer ${key}` } } };
        }
        if (protocol === 'anthropic') {
          const testModel = (provider.models && provider.models[0]) || 'claude-3-haiku-20240307';
          return { url: hasV1Suffix ? `${base}/messages` : `${base}/v1/messages`, opts: { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' }, body: JSON.stringify({ model: testModel, max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] }) } };
        }
        if (protocol === 'gemini') return { url: `${base}/v1beta/models?key=${key}`, opts: {} };
        return null;
      }

      const results = await Promise.all(existingKeys.map(async (k, i) => {
        const { url: testUrl, opts: fetchOpts } = buildTestUrl(k.key);
        if (!testUrl) return { ok: false, index: i, message: `不支持的协议: ${protocol}` };
        try {
          const startedAt = Date.now();
          const fetchRes = await fetch(testUrl, { ...fetchOpts, signal: AbortSignal.timeout(15000) });
          const latencyMs = Date.now() - startedAt;
          if (!fetchRes.ok) {
            const errText = await fetchRes.text().catch(() => '');
            const hint = fetchRes.status === 401 || fetchRes.status === 403 ? 'API Key 无效或无权限' : `HTTP ${fetchRes.status}`;
            return { ok: false, alias: k.alias || '', index: i, message: hint, latencyMs };
          }
          return { ok: true, alias: k.alias || '', index: i, latencyMs };
        } catch (err) {
          const msg = err.name === 'TimeoutError' ? '连接超时 (15s)' : `连接失败: ${err.message}`;
          return { ok: false, alias: k.alias || '', index: i, message: msg };
        }
      }));
      const passed = results.filter(r => r.ok).length;
      return { ok: passed === existingKeys.length, passed, failed: existingKeys.length - passed, results };
    },

    get_provider_models: async (args) => {
      const provider = configStore.getProviderById(args.providerId);
      if (!provider) return { error: `供应商 ${args.providerId} 不存在` };
      const enabledKeys = (provider.apiKeys || []).filter(k => k.enabled !== false).map(k => k.key);
      if (enabledKeys.length === 0) return { error: '没有可用的 API Key' };
      const key = enabledKeys[0];
      const protocol = provider.protocol || 'openai';
      const base = provider.url.replace(/\/$/, '');
      const hasV1Suffix = base.endsWith('/v1');
      const isAzure = protocol === 'openai' && !!provider.azureDeployment;
      let url, headers = {};
      if (protocol === 'openai') {
        if (isAzure) {
          const ver = provider.azureApiVersion || '2024-02-01';
          url = `${base}/openai/deployments/${provider.azureDeployment}/models?api-version=${ver}`;
          headers['api-key'] = key;
        } else {
          url = hasV1Suffix ? `${base}/models` : `${base}/v1/models`;
          headers['Authorization'] = `Bearer ${key}`;
        }
      } else if (protocol === 'anthropic') {
        return { models: provider.models || [], message: 'Anthropic 不支持模型列表查询' };
      } else if (protocol === 'gemini') {
        url = `${base}/v1beta/models?key=${key}`;
      } else {
        return { error: `不支持的协议: ${protocol}` };
      }
      try {
        const res = await fetch(url, { headers, signal: AbortSignal.timeout(15000) });
        if (!res.ok) return { error: `HTTP ${res.status}: ${await res.text().catch(() => '')}` };
        const data = await res.json();
        const models = (data.data || data.models || []).map(m => m.id || m.name).filter(Boolean);
        return { models };
      } catch (err) {
        return { error: err.message };
      }
    },

    // --- 代理管理 ---
    create_proxy: async (args) => {
      if (!args.name || !args.port || !args.providerId) return { error: 'name, port, providerId 是必填项' };
      const provider = configStore.getProviderById(args.providerId);
      if (!provider) return { error: '供应商不存在' };
      const parsedPort = parseInt(args.port);
      const existing = configStore.getProxies().find(p => p.port === parsedPort);
      if (existing) return { error: `端口 ${parsedPort} 已被代理「${existing.name}」占用` };
      configStore.saveSnapshot('create-proxy');
      const proxy = configStore.addProxy({
        name: args.name,
        port: parsedPort,
        providerId: args.providerId,
        defaultModel: args.defaultModel || '',
        providerWeight: 1,
        routingStrategy: normalizeRoutingStrategyInput(args.routingStrategy),
        providerPool: normalizeProviderPoolInput(args.providerPool),
      });
      try {
        await startProxyWithProvider(proxy);
        return { success: true, id: proxy.id, name: proxy.name, port: proxy.port, running: true };
      } catch (err) {
        configStore.removeProxy(proxy.id);
        return { error: `代理启动失败: ${err.message}` };
      }
    },

    update_proxy: async (args) => {
      const existing = configStore.getProxyById(args.proxyId);
      if (!existing) return { error: `代理 ${args.proxyId} 不存在` };
      configStore.saveSnapshot('update-proxy');
      const updates = {};
      if (args.name !== undefined) updates.name = args.name;
      if (args.port !== undefined) updates.port = parseInt(args.port);
      if (args.providerId !== undefined) {
        if (!configStore.getProviderById(args.providerId)) return { error: '供应商不存在' };
        updates.providerId = args.providerId;
      }
      if (args.defaultModel !== undefined) updates.defaultModel = args.defaultModel;
      if (args.routingStrategy !== undefined) updates.routingStrategy = normalizeRoutingStrategyInput(args.routingStrategy);
      const needRestart = updates.port !== undefined && updates.port !== existing.port;
      if (needRestart) {
        const conflict = configStore.getProxies().find(p => p.id !== args.proxyId && p.port === updates.port);
        if (conflict) return { error: `端口 ${updates.port} 已被代理「${conflict.name}」占用` };
      }
      const updated = configStore.updateProxy(args.proxyId, updates);
      if (needRestart) {
        try {
          await startProxyWithProvider(updated);
        } catch (err) {
          return { error: `代理重启失败: ${err.message}` };
        }
      } else {
        const target = resolveTarget(updated);
        if (target) proxyManager.updateProxyConfig({ ...updated, target });
      }
      return { success: true, id: updated.id, name: updated.name, running: proxyManager.isRunning(updated.id) };
    },

    delete_proxy: async (args) => {
      const existing = configStore.getProxyById(args.proxyId);
      if (!existing) return { error: `代理 ${args.proxyId} 不存在` };
      configStore.saveSnapshot('delete-proxy');
      await proxyManager.stopProxy(args.proxyId);
      configStore.removeProxy(args.proxyId);
      return { success: true };
    },

    start_proxy: async (args) => {
      const proxy = configStore.getProxyById(args.proxyId);
      if (!proxy) return { error: `代理 ${args.proxyId} 不存在` };
      try {
        await startProxyWithProvider(proxy);
        return { success: true, running: true };
      } catch (err) {
        return { error: `启动失败: ${err.message}` };
      }
    },

    stop_proxy: async (args) => {
      const proxy = configStore.getProxyById(args.proxyId);
      if (!proxy) return { error: `代理 ${args.proxyId} 不存在` };
      await proxyManager.stopProxy(args.proxyId);
      return { success: true, running: false };
    },

    start_all_proxies: async () => {
      const proxies = configStore.getProxies();
      const results = [];
      for (const proxy of proxies) {
        if (proxyManager.isRunning(proxy.id)) {
          results.push({ id: proxy.id, name: proxy.name, skipped: true });
          continue;
        }
        try {
          await startProxyWithProvider(proxy);
          results.push({ id: proxy.id, name: proxy.name, success: true });
        } catch (err) {
          results.push({ id: proxy.id, name: proxy.name, success: false, error: err.message });
        }
      }
      return { results };
    },

    stop_all_proxies: async () => {
      const running = proxyManager.getRunningPorts();
      const results = [];
      for (const r of running) {
        await proxyManager.stopProxy(r.id);
        results.push({ id: r.id, name: r.name, success: true });
      }
      return { results };
    },

    // --- MCP 服务器管理 ---
    get_mcp_servers: async () => {
      const servers = configStore.getMcpServers();
      const status = mcpClient.getStatus();
      const statusMap = Object.fromEntries(status.map(s => [s.name, s]));
      return Object.entries(servers).map(([name, config]) => ({
        name,
        enabled: config.enabled !== false,
        transport: config.url ? 'http' : 'stdio',
        command: config.command,
        url: config.url,
        ...(statusMap[name] || { status: 'disconnected', tools: [], lastError: null }),
      }));
    },

    add_mcp_server: async (args) => {
      if (!args.name) return { error: '需要服务名称' };
      if (!args.command && !args.url) return { error: '需要 command（本地）或 url（远程）' };
      const existing = configStore.getMcpServer(args.name);
      if (existing) return { error: '服务名已存在' };
      const serverConfig = {};
      if (args.url) {
        serverConfig.url = args.url;
        if (args.headers) serverConfig.headers = args.headers;
      } else {
        serverConfig.command = args.command;
        if (args.args) serverConfig.args = Array.isArray(args.args) ? args.args : String(args.args).split(/\s+/).filter(Boolean);
        if (args.env && Object.keys(args.env).length) serverConfig.env = args.env;
      }
      serverConfig.enabled = args.enabled !== false;
      configStore.addMcpServer(args.name, serverConfig);
      if (serverConfig.enabled) {
        mcpClient.connectServer(args.name, serverConfig).catch(err => {
          logger.error(`[MCP] 后台连接 ${args.name} 失败: ${err.message}`);
        });
      }
      return { success: true, name: args.name };
    },

    update_mcp_server: async (args) => {
      const existing = configStore.getMcpServer(args.name);
      if (!existing) return { error: `MCP 服务 "${args.name}" 不存在` };
      const updates = {};
      if (args.url !== undefined) {
        updates.url = args.url;
        if (args.headers !== undefined) updates.headers = args.headers;
        delete updates.command;
        delete updates.args;
        delete updates.env;
      }
      if (args.command !== undefined) {
        updates.command = args.command;
        if (args.args !== undefined) updates.args = Array.isArray(args.args) ? args.args : String(args.args).split(/\s+/).filter(Boolean);
        if (args.env !== undefined) updates.env = args.env;
        delete updates.url;
        delete updates.headers;
      }
      if (args.enabled !== undefined) updates.enabled = args.enabled;
      configStore.updateMcpServer(args.name, updates);
      const newConfig = configStore.getMcpServer(args.name);
      if (newConfig.enabled) {
        await mcpClient.reconnectIfChanged(args.name, newConfig).catch(() => {});
      } else {
        await mcpClient.disconnectServer(args.name);
      }
      return { success: true };
    },

    delete_mcp_server: async (args) => {
      const existing = configStore.getMcpServer(args.name);
      if (!existing) return { error: `MCP 服务 "${args.name}" 不存在` };
      await mcpClient.disconnectServer(args.name);
      configStore.removeMcpServer(args.name);
      return { success: true };
    },

    connect_mcp_server: async (args) => {
      const config = configStore.getMcpServer(args.name);
      if (!config) return { error: `MCP 服务 "${args.name}" 不存在` };
      try {
        await mcpClient.connectServer(args.name, config);
        const status = mcpClient.getStatus().find(s => s.name === args.name);
        return status || { status: 'error', lastError: '连接失败' };
      } catch (err) {
        return { error: err.message };
      }
    },

    disconnect_mcp_server: async (args) => {
      await mcpClient.disconnectServer(args.name);
      return { success: true };
    },

    get_mcp_tools: async () => {
      const status = mcpClient.getStatus();
      return status.filter(s => s.status === 'connected').flatMap(s =>
        s.tools.map(t => ({ ...t, server: s.name, transport: s.transport }))
      );
    },

    // --- 技能管理 ---
    get_skills: async () => {
      return { skills: skillStore.list() };
    },

    create_skill: async (args) => {
      if (!args.name || !args.content) return { error: '需要 name 和 content' };
      const skill = skillStore.create(args.name, args.description || '', args.content);
      if (!skill) return { error: '技能已存在' };
      return { success: true, name: skill.name };
    },

    update_skill: async (args) => {
      const skill = skillStore.update(args.name, args.description || '', args.content || '');
      if (!skill) return { error: `技能 "${args.name}" 不存在或不可编辑` };
      return { success: true, name: skill.name };
    },

    delete_skill: async (args) => {
      const skill = skillStore.get(args.name);
      if (!skill) return { error: `技能 "${args.name}" 不存在` };
      if (skill.category === 'system') return { error: '系统级技能不可删除' };
      if (!skillStore.remove(args.name)) return { error: '删除失败' };
      return { success: true };
    },

    // --- 配置管理 ---
    export_config: async () => {
      const providers = configStore.getProviders();
      const proxies = configStore.getProxies().map(p => {
        const provider = configStore.getProviderById(p.providerId);
        return { id: p.id, name: p.name, port: p.port, providerId: p.providerId, defaultModel: p.defaultModel || '', routingStrategy: p.routingStrategy || 'primary_fallback', providerName: provider?.name || '' };
      });
      return { providers, proxies, exportedAt: new Date().toISOString() };
    },

    import_config: async (args) => {
      if (!args.config || !args.mode || !['overwrite', 'merge'].includes(args.mode)) {
        return { error: '需要 config 和 mode（overwrite/merge）' };
      }
      if (!Array.isArray(args.config.providers) || !Array.isArray(args.config.proxies)) {
        return { error: '配置格式错误：需要 providers 和 proxies 数组' };
      }
      configStore.saveSnapshot('import-' + args.mode);
      if (args.mode === 'overwrite') {
        const newConfig = {
          providers: args.config.providers.map(p => ({
            id: p.id, name: p.name, url: p.url, protocol: p.protocol,
            apiKey: p.apiKey || '', models: Array.isArray(p.models) ? p.models : [],
          })),
          proxies: args.config.proxies.map(p => ({
            id: p.id, name: p.name, port: p.port, providerId: p.providerId,
            defaultModel: p.defaultModel || '', routingStrategy: normalizeRoutingStrategyInput(p.routingStrategy),
            providerPool: normalizeProviderPoolInput(p.providerPool),
          })),
        };
        configStore.saveConfig(newConfig);
        return { success: true, mode: 'overwrite', providers: newConfig.providers.length, proxies: newConfig.proxies.length };
      }
      // merge 模式
      const existingProviders = configStore.getProviders();
      const existingProxies = configStore.getProxies();
      const providerMap = new Map(existingProviders.map(p => [p.id, p]));
      for (const p of args.config.providers) {
        providerMap.set(p.id, { id: p.id, name: p.name, url: p.url, protocol: p.protocol, apiKey: p.apiKey || '', models: Array.isArray(p.models) ? p.models : [] });
      }
      const proxyMap = new Map(existingProxies.map(p => [p.id, p]));
      for (const p of args.config.proxies) {
        const conflict = proxyMap.get(p.id) ? null : Array.from(proxyMap.values()).find(ep => ep.port === p.port);
        if (conflict) return { error: `端口 ${p.port} 已被代理「${conflict.name}」占用` };
        proxyMap.set(p.id, { id: p.id, name: p.name, port: p.port, providerId: p.providerId, defaultModel: p.defaultModel || '', routingStrategy: normalizeRoutingStrategyInput(p.routingStrategy), providerPool: normalizeProviderPoolInput(p.providerPool) });
      }
      const merged = { providers: Array.from(providerMap.values()), proxies: Array.from(proxyMap.values()) };
      configStore.saveConfig(merged);
      return { success: true, mode: 'merge', providers: merged.providers.length, proxies: merged.proxies.length };
    },

    rollback_config: async (args) => {
      if (!args.file) return { error: '需要指定快照文件' };
      const result = configStore.restoreSnapshot(args.file);
      if (result.error) return { error: result.error };
      return { success: true };
    },

    // --- 系统操作 ---
    update_settings: async (args) => {
      if (!args.settings || typeof args.settings !== 'object') return { error: '需要 settings 对象' };
      for (const [key, value] of Object.entries(args.settings)) {
        configStore.setSetting(key, value);
      }
      return { success: true, settings: configStore.getSettings() };
    },

    trigger_key_health_check: async () => {
      await checkAllProviderKeys();
      return { success: true };
    },

    check_health: async () => {
      return {
        status: 'ok',
        version: require('./package.json').version,
        uptime: Math.floor(process.uptime()),
        proxies: {
          total: configStore.getProxies().length,
          running: proxyManager.getRunningPorts().length,
        },
      };
    },
  };

  async function startProxyWithProvider(proxy) {
    const target = resolveTarget(proxy);
    if (!target) throw new Error(`供应商 ${proxy.providerId} 不存在`);
    const proxyConfig = { ...proxy, target };
    return proxyManager.startProxy(proxyConfig);
  }

  // ==================== API Key 健康检查 ====================

  const keyHealth = new Map(); // providerId -> { status, lastCheck, keys: [{index, ok, message}] }
  let healthCheckRunning = false;

  async function checkAllProviderKeys() {
    if (healthCheckRunning) return;
    healthCheckRunning = true;
    try {
      const providers = configStore.getProviders();
      logger.log(`[Health] 开始检查 ${providers.length} 个供应商的 API Key...`);
      for (const provider of providers) {
        await checkProviderKeys(provider);
      }
      logger.log('[Health] API Key 健康检查完成');
    } finally {
      healthCheckRunning = false;
    }
  }

  async function checkProviderKeys(provider) {
    const keys = (provider.apiKeys || []).filter(k => k.enabled !== false);
    if (keys.length === 0) {
      keyHealth.set(provider.id, { status: 'unknown', lastCheck: Date.now(), keys: [] });
      return;
    }

    const protocol = provider.protocol || 'openai';
    const base = provider.url.replace(/\/$/, '');
    const hasV1Suffix = base.endsWith('/v1');
    const isAzure = protocol === 'openai' && !!provider.azureDeployment;

    const results = await Promise.all(keys.map(async (k, i) => {
      try {
        let testUrl, fetchOpts;
        if (protocol === 'openai') {
          if (isAzure) {
            const ver = provider.azureApiVersion || '2024-02-01';
            testUrl = `${base}/openai/deployments/${provider.azureDeployment}/models?api-version=${ver}`;
            fetchOpts = { headers: { 'api-key': k.key } };
          } else {
            testUrl = hasV1Suffix ? `${base}/models` : `${base}/v1/models`;
            fetchOpts = { headers: { 'Authorization': `Bearer ${k.key}` } };
          }
        } else if (protocol === 'anthropic') {
          const testModel = (provider.models && provider.models[0]) || 'claude-3-haiku-20240307';
          testUrl = hasV1Suffix ? `${base}/messages` : `${base}/v1/messages`;
          fetchOpts = {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-api-key': k.key, 'anthropic-version': '2023-06-01' },
            body: JSON.stringify({ model: testModel, max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] }),
          };
        } else if (protocol === 'gemini') {
          testUrl = `${base}/v1beta/models?key=${k.key}`;
          fetchOpts = {};
        } else {
          return { index: i, ok: false, message: '不支持的协议' };
        }
        const res = await fetch(testUrl, { ...fetchOpts, signal: AbortSignal.timeout(15000) });
        if (!res.ok) {
          const hint = res.status === 401 || res.status === 403 ? 'Key 无效或无权限' : `HTTP ${res.status}`;
          return { index: i, ok: false, message: hint };
        }
        return { index: i, ok: true };
      } catch (err) {
        return { index: i, ok: false, message: err.name === 'TimeoutError' ? '连接超时' : err.message };
      }
    }));

    const allOk = results.every(r => r.ok);
    const anyOk = results.some(r => r.ok);
    keyHealth.set(provider.id, {
      status: allOk ? 'healthy' : anyOk ? 'partial' : 'unhealthy',
      lastCheck: Date.now(),
      keys: results,
    });
  }

  // 启动后延迟 5 秒执行首次检查
  setTimeout(() => checkAllProviderKeys(), 5000);
  // 每 24 小时检查一次
  setInterval(() => checkAllProviderKeys(), 24 * 60 * 60 * 1000);

  // ==================== 供应商 API ====================

  app.get('/api/providers', (req, res) => {
    const providers = configStore.getProviders().map(p => ({
      ...p,
      apiKey: p.apiKey ? '***' : '',
      apiKeys: (p.apiKeys || []).map((k, i) => ({ alias: k.alias || '', masked: true, index: i, enabled: k.enabled !== false })),
    }));
    res.json(providers);
  });

  app.get('/api/providers/:id', (req, res) => {
    const provider = configStore.getProviderById(req.params.id);
    if (!provider) return res.status(404).json({ error: 'Provider not found' });
    res.json({ ...provider, apiKey: provider.apiKey ? '***' : '', apiKeys: (provider.apiKeys || []).map((k, i) => ({ alias: k.alias || '', masked: true, index: i, enabled: k.enabled !== false })) });
  });

  app.post('/api/providers', (req, res) => {
    const { name, url, protocol, apiKey, apiKeys, models, azureDeployment, azureApiVersion } = req.body;
    if (!name || !url) {
      return res.status(400).json({ error: 'name and url are required' });
    }
    const provider = configStore.addProvider({
      name, url,
      protocol: protocol || (/anthropic/i.test(url) ? 'anthropic' : 'openai'),
      apiKey: apiKey || '',
      apiKeys: Array.isArray(apiKeys) ? apiKeys.filter(k => k && typeof k === 'object' && k.key && k.key.trim()) : [],
      models: models || [],
      azureDeployment: azureDeployment || '',
      azureApiVersion: azureApiVersion || '',
    });
    res.status(201).json(provider);
  });

  app.put('/api/providers/:id', async (req, res) => {
    const existing = configStore.getProviderById(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Provider not found' });

    const updates = {};
    if (req.body.name !== undefined) updates.name = req.body.name;
    if (req.body.url !== undefined) updates.url = req.body.url;
    if (req.body.protocol !== undefined) updates.protocol = req.body.protocol;
    if (req.body.apiKey !== undefined && req.body.apiKey !== '') updates.apiKey = req.body.apiKey;
    if (req.body.apiKeys !== undefined) {
      // Map masked entries back to existing keys by index
      const existingKeys = existing.apiKeys || [];
      updates.apiKeys = req.body.apiKeys
        .map(k => {
          if (k && typeof k === 'object' && k.masked && typeof k.index === 'number') {
            const existing = existingKeys[k.index];
            if (!existing) return null;
            return { ...existing, alias: typeof k.alias === 'string' ? k.alias.trim() : (existing.alias || ''), enabled: k.enabled !== false };
          }
          if (k && typeof k === 'object' && typeof k.key === 'string' && k.key.trim()) {
            return { key: k.key.trim(), alias: typeof k.alias === 'string' ? k.alias.trim() : '', enabled: k.enabled !== false };
          }
          if (typeof k === 'string' && k.trim()) {
            return { key: k.trim(), alias: '' };
          }
          return null;
        })
        .filter(Boolean);
    }
    if (req.body.models !== undefined) updates.models = req.body.models;
    if (req.body.azureDeployment !== undefined) updates.azureDeployment = req.body.azureDeployment;
    if (req.body.azureApiVersion !== undefined) updates.azureApiVersion = req.body.azureApiVersion;

    const updated = configStore.updateProvider(req.params.id, updates);

    // 同步更新引用此供应商的运行中代理
    const affectedProxies = configStore.getProxies().filter(p => p.providerId === req.params.id);
    for (const proxy of affectedProxies) {
      if (!proxyManager.isRunning(proxy.id)) continue;
      const target = resolveTarget(proxy);
      if (target) proxyManager.updateProxyConfig({ ...proxy, target });
    }

    res.json(updated);
  });

  app.post('/api/providers/:id/test', async (req, res) => {
    const provider = configStore.getProviderById(req.params.id);
    if (!provider) return res.status(404).json({ error: 'Provider not found' });

    const existingKeys = provider.apiKeys || [];
    const reqKeys = Array.isArray(req.body.apiKeys) ? req.body.apiKeys : [];
    const resolved = reqKeys
      .map((k, i) => {
        if (k && typeof k === 'object' && k.masked && typeof k.index === 'number') {
          const ex = existingKeys[k.index];
          return ex ? { key: ex.key, alias: k.alias || ex.alias || '', domIndex: i } : null;
        }
        if (k && typeof k === 'object' && typeof k.key === 'string' && k.key.trim()) {
          return { key: k.key.trim(), alias: k.alias || '', domIndex: i };
        }
        if (typeof k === 'string' && k.trim()) return { key: k.trim(), alias: '', domIndex: i };
        return null;
      })
      .filter(Boolean);

    if (resolved.length === 0) {
      return res.json({ ok: false, message: '没有可用的 API Key', results: [] });
    }

    const protocol = req.body.protocol || provider.protocol || 'openai';
    const base = provider.url.replace(/\/$/, '');
    const hasV1Suffix = base.endsWith('/v1');
    const isAzure = protocol === 'openai' && !!provider.azureDeployment;

    function buildTestOpts(key) {
      if (protocol === 'openai') {
        if (isAzure) {
          const ver = provider.azureApiVersion || '2024-02-01';
          return {
            url: `${base}/openai/deployments/${provider.azureDeployment}/models?api-version=${ver}`,
            opts: { headers: { 'api-key': key } },
          };
        }
        return {
          url: hasV1Suffix ? `${base}/models` : `${base}/v1/models`,
          opts: { headers: { 'Authorization': `Bearer ${key}` } },
        };
      }
      if (protocol === 'anthropic') {
        const testModel = req.body.model || (provider.models && provider.models[0]) || 'claude-3-haiku-20240307';
        return {
          url: hasV1Suffix ? `${base}/messages` : `${base}/v1/messages`,
          opts: {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
            body: JSON.stringify({ model: testModel, max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] }),
          },
        };
      }
      if (protocol === 'gemini') {
        return { url: `${base}/v1beta/models?key=${key}`, opts: {} };
      }
      return null;
    }

    if (protocol !== 'openai' && protocol !== 'anthropic' && protocol !== 'gemini') {
      return res.json({ ok: false, message: `不支持的协议: ${protocol}`, results: [] });
    }

    const results = await Promise.all(resolved.map(async entry => {
      const { url: testUrl, opts: fetchOpts } = buildTestOpts(entry.key);
      try {
        const startedAt = Date.now();
        const fetchRes = await fetch(testUrl, { ...fetchOpts, signal: AbortSignal.timeout(15000) });
        const latencyMs = Date.now() - startedAt;
        if (!fetchRes.ok) {
          const errText = await fetchRes.text().catch(() => '');
          const hint = fetchRes.status === 401 || fetchRes.status === 403
            ? 'API Key 无效或无权限'
            : `HTTP ${fetchRes.status}: ${errText.slice(0, 200) || '未知错误'}`;
          return { ok: false, alias: entry.alias, index: entry.domIndex, message: hint, latencyMs };
        }
        return { ok: true, alias: entry.alias, index: entry.domIndex, latencyMs };
      } catch (err) {
        const msg = err.name === 'TimeoutError' ? '连接超时 (15s)' : `连接失败: ${err.message}`;
        return { ok: false, alias: entry.alias, index: entry.domIndex, message: msg };
      }
    }));

    const passed = results.filter(r => r.ok).length;
    const failed = results.length - passed;
    res.json({ ok: failed === 0, passed, failed, total: results.length, results });
  });

  app.post('/api/test-connection', async (req, res) => {
    const { url, protocol, apiKeys, models, azureDeployment, azureApiVersion } = req.body || {};
    if (!url || !protocol) return res.json({ ok: false, message: '缺少 url 或 protocol', results: [] });
    if (!Array.isArray(apiKeys) || apiKeys.length === 0) {
      return res.json({ ok: false, message: '没有可用的 API Key', results: [] });
    }
    const keys = apiKeys.filter(k => k && k.key);
    if (keys.length === 0) return res.json({ ok: false, message: '没有可用的 API Key', results: [] });
    const base = url.replace(/\/$/, '');
    const hasV1Suffix = base.endsWith('/v1');
    const isAzure = protocol === 'openai' && !!azureDeployment;

    function buildTestOpts(key) {
      if (protocol === 'openai') {
        if (isAzure) {
          const ver = azureApiVersion || '2024-02-01';
          return { url: `${base}/openai/deployments/${azureDeployment}/models?api-version=${ver}`, opts: { headers: { 'api-key': key } } };
        }
        return { url: hasV1Suffix ? `${base}/models` : `${base}/v1/models`, opts: { headers: { 'Authorization': `Bearer ${key}` } } };
      }
      if (protocol === 'anthropic') {
        const testModel = (Array.isArray(models) && models[0]) || 'claude-3-haiku-20240307';
        return {
          url: hasV1Suffix ? `${base}/messages` : `${base}/v1/messages`,
          opts: { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' }, body: JSON.stringify({ model: testModel, max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] }) },
        };
      }
      if (protocol === 'gemini') return { url: `${base}/v1beta/models?key=${key}`, opts: {} };
      return null;
    }

    const results = await Promise.all(keys.map(async (k) => {
      const built = buildTestOpts(k.key);
      if (!built) return { ok: false, alias: k.alias || '', message: '不支持的协议' };
      try {
        const started = Date.now();
        const fetchRes = await fetch(built.url, { ...built.opts, signal: AbortSignal.timeout(15000) });
        const latency = Date.now() - started;
        if (!fetchRes.ok) {
          const hint = fetchRes.status === 401 || fetchRes.status === 403 ? 'API Key 无效或无权限' : `HTTP ${fetchRes.status}`;
          return { ok: false, alias: k.alias || '', message: hint, latency };
        }
        return { ok: true, alias: k.alias || '', latency };
      } catch (err) {
        return { ok: false, alias: k.alias || '', message: err.name === 'TimeoutError' ? '连接超时' : err.message };
      }
    }));

    const passed = results.filter(r => r.ok).length;
    res.json({ ok: passed === keys.length, passed, failed: keys.length - passed, results });
  });

  app.post('/api/providers/available-models', async (req, res) => {
    const { url, protocol, apiKey, azureDeployment, azureApiVersion } = req.body || {};
    if (!url || !protocol) return res.json({ models: [], message: '缺少 url 或 protocol 参数' });
    const key = apiKey || '';
    const base = url.replace(/\/$/, '');
    const hasV1Suffix = base.endsWith('/v1');
    const isAzure = protocol === 'openai' && !!azureDeployment;
    try {
      let fetchUrl, fetchOpts;
      if (protocol === 'openai') {
        if (isAzure) {
          const ver = azureApiVersion || '2024-02-01';
          fetchUrl = `${base}/openai/deployments/${azureDeployment}/models?api-version=${ver}`;
          fetchOpts = { headers: { 'api-key': key } };
        } else {
          fetchUrl = hasV1Suffix ? `${base}/models` : `${base}/v1/models`;
          fetchOpts = key ? { headers: { 'Authorization': `Bearer ${key}` } } : {};
        }
      } else if (protocol === 'gemini') {
        fetchUrl = `${base}/v1beta/models?key=${key}`;
        fetchOpts = {};
      } else if (protocol === 'anthropic') {
        fetchUrl = hasV1Suffix ? `${base}/models` : `${base}/v1/models`;
        fetchOpts = key ? { headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' } } : {};
      } else {
        return res.json({ models: [], message: `不支持的协议: ${protocol}` });
      }
      const fetchRes = await fetch(fetchUrl, { ...fetchOpts, signal: AbortSignal.timeout(15000) });
      if (!fetchRes.ok) {
        const hint = fetchRes.status === 404 ? '该供应商不支持模型列表接口' : `获取失败: HTTP ${fetchRes.status}`;
        return res.json({ models: [], message: hint });
      }
      const data = await fetchRes.json().catch(() => null);
      let models = [];
      if (Array.isArray(data?.data)) {
        models = data.data.map(m => m.id || m.name).filter(Boolean).sort();
      } else if (Array.isArray(data?.models)) {
        models = data.models.map(m => (m.name || m.id)?.replace('models/', '')).filter(Boolean).sort();
      }
      res.json({ models });
    } catch (err) {
      res.json({ models: [], message: `获取失败: ${err.message}` });
    }
  });

  app.post('/api/providers/:id/available-models', async (req, res) => {
    const provider = configStore.getProviderById(req.params.id);
    if (!provider) return res.status(404).json({ error: 'Provider not found' });

    // Support unsaved API keys from form
    let keys;
    const reqKeys = Array.isArray(req.body?.apiKeys) ? req.body.apiKeys : [];
    if (reqKeys.length > 0) {
      const existingKeys = provider.apiKeys || [];
      keys = reqKeys
        .map(k => {
          if (k && typeof k === 'object' && k.masked && typeof k.index === 'number') {
            return existingKeys[k.index]?.key || null;
          }
          if (k && typeof k === 'object' && typeof k.key === 'string' && k.key.trim()) {
            return k.key.trim();
          }
          return null;
        })
        .filter(Boolean);
    } else {
      keys = (provider.apiKeys || []).map(k => k.key).filter(Boolean);
    }
    if (keys.length === 0) return res.json({ models: [], message: '没有可用的 API Key' });

    const protocol = provider.protocol || 'openai';
    const base = provider.url.replace(/\/$/, '');
    const hasV1Suffix = base.endsWith('/v1');
    const key = keys[0];
    const isAzure = protocol === 'openai' && !!provider.azureDeployment;

    try {
      let fetchUrl, fetchOpts;
      if (protocol === 'openai') {
        if (isAzure) {
          const ver = provider.azureApiVersion || '2024-02-01';
          fetchUrl = `${base}/openai/deployments/${provider.azureDeployment}/models?api-version=${ver}`;
          fetchOpts = { headers: { 'api-key': key } };
        } else {
          fetchUrl = hasV1Suffix ? `${base}/models` : `${base}/v1/models`;
          fetchOpts = { headers: { 'Authorization': `Bearer ${key}` } };
        }
      } else if (protocol === 'gemini') {
        fetchUrl = `${base}/v1beta/models?key=${key}`;
        fetchOpts = {};
      } else if (protocol === 'anthropic') {
        fetchUrl = hasV1Suffix ? `${base}/models` : `${base}/v1/models`;
        fetchOpts = { headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' } };
      } else {
        return res.json({ models: [], message: `不支持的协议: ${protocol}` });
      }

      const fetchRes = await fetch(fetchUrl, { ...fetchOpts, signal: AbortSignal.timeout(15000) });
      if (!fetchRes.ok) {
        const hint = fetchRes.status === 404 ? '该供应商不支持模型列表接口' : `获取失败: HTTP ${fetchRes.status}`;
        return res.json({ models: [], message: hint });
      }

      const data = await fetchRes.json().catch(() => null);
      let models = [];
      if (Array.isArray(data?.data)) {
        // OpenAI 格式（含第三方 Anthropic 兼容供应商）
        models = data.data.map(m => m.id || m.name).filter(Boolean).sort();
      } else if (Array.isArray(data?.models)) {
        // Gemini 格式
        models = data.models.map(m => (m.name || m.id)?.replace('models/', '')).filter(Boolean).sort();
      }

      res.json({ models });
    } catch (err) {
      res.json({ models: [], message: `获取失败: ${err.message}` });
    }
  });

  app.delete('/api/providers/:id', (req, res) => {
    const existing = configStore.getProviderById(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Provider not found' });

    // 检查是否有代理在使用此供应商
    const inUse = configStore.getProxies().some(p => p.providerId === req.params.id);
    if (inUse) {
      return res.status(409).json({ error: '该供应商正在被代理使用，无法删除' });
    }

    configStore.removeProvider(req.params.id);
    res.json({ success: true });
  });

  // ==================== 代理 API ====================

  // 获取所有代理配置
  app.get('/api/proxies', (req, res) => {
    const proxies = configStore.getProxies().map(p => {
      const provider = configStore.getProviderById(p.providerId);
      return {
        id: p.id,
        name: p.name,
        port: p.port,
        requireAuth: p.requireAuth,
        authToken: p.authToken,
        providerId: p.providerId,
        providerName: provider?.name || '',
        providerUrl: provider?.url || '',
        protocol: provider?.protocol || '',
        defaultModel: p.defaultModel || '',
        providerWeight: Math.max(1, parseInt(p.providerWeight, 10) || 1),
        routingStrategy: p.routingStrategy || 'primary_fallback',
        providerPool: Array.isArray(p.providerPool) ? p.providerPool : [],
        hasApiKey: !!(provider?.apiKey || (provider?.apiKeys && provider.apiKeys.length > 0)),
        running: proxyManager.isRunning(p.id),
      };
    });
    res.json(proxies);
  });

  // 获取单个代理配置
  app.get('/api/proxies/:id', (req, res) => {
    const proxy = configStore.getProxyById(req.params.id);
    if (!proxy) return res.status(404).json({ error: 'Proxy not found' });
    const provider = configStore.getProviderById(proxy.providerId);
    res.json({
      ...proxy,
      providerName: provider?.name || '',
      providerUrl: provider?.url || '',
      protocol: provider?.protocol || '',
      routingStrategy: proxy.routingStrategy || 'primary_fallback',
      providerPool: Array.isArray(proxy.providerPool) ? proxy.providerPool : [],
      hasApiKey: !!(provider?.apiKey || (provider?.apiKeys && provider.apiKeys.length > 0)),
    });
  });

  // 创建代理
  app.post('/api/proxies', async (req, res) => {
    configStore.saveSnapshot('create-proxy');
    const { name, port, requireAuth, authToken, providerId, defaultModel, routingStrategy, providerPool, providerWeight } = req.body;

    if (!name || !port || !providerId) {
      return res.status(400).json({ error: 'name, port and providerId are required' });
    }

    const provider = configStore.getProviderById(providerId);
    if (!provider) return res.status(400).json({ error: '供应商不存在' });

    const parsedPort = parseInt(port);

    const existing = configStore.getProxies().find(p => p.port === parsedPort);
    if (existing) {
      return res.status(409).json({
        error: `端口 ${parsedPort} 已被代理「${existing.name}」占用，请更换端口`,
      });
    }

    const proxy = configStore.addProxy({
      name,
      port: parsedPort,
      requireAuth: !!requireAuth,
      authToken: authToken || null,
      providerId,
      defaultModel: defaultModel || '',
      providerWeight: Math.max(1, parseInt(providerWeight, 10) || 1),
      routingStrategy: normalizeRoutingStrategyInput(routingStrategy),
      providerPool: normalizeProviderPoolInput(providerPool),
    });

    try {
      await startProxyWithProvider(proxy);
      res.status(201).json({ ...proxy, running: true });
    } catch (err) {
      configStore.removeProxy(proxy.id);
      res.status(500).json({ error: `代理启动失败: ${err.message}` });
    }
  });

  // 更新代理
  app.put('/api/proxies/:id', async (req, res) => {
    configStore.saveSnapshot('update-proxy');
    const existing = configStore.getProxyById(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Proxy not found' });

    const updates = {};
    if (req.body.name !== undefined) updates.name = req.body.name;
    if (req.body.port !== undefined) updates.port = parseInt(req.body.port);
    if (req.body.requireAuth !== undefined) updates.requireAuth = !!req.body.requireAuth;
    if (req.body.authToken !== undefined) updates.authToken = req.body.authToken || null;
    if (req.body.providerId !== undefined) {
      if (!configStore.getProviderById(req.body.providerId)) {
        return res.status(400).json({ error: '供应商不存在' });
      }
      updates.providerId = req.body.providerId;
    }
    if (req.body.defaultModel !== undefined) updates.defaultModel = req.body.defaultModel;
    if (req.body.providerWeight !== undefined) updates.providerWeight = Math.max(1, parseInt(req.body.providerWeight, 10) || 1);
    if (req.body.routingStrategy !== undefined) updates.routingStrategy = normalizeRoutingStrategyInput(req.body.routingStrategy);
    if (req.body.providerPool !== undefined) updates.providerPool = normalizeProviderPoolInput(req.body.providerPool);

    const needRestart = updates.port !== undefined && updates.port !== existing.port;
    if (needRestart) {
      const conflict = configStore.getProxies().find(p => p.id !== req.params.id && p.port === updates.port);
      if (conflict) {
        return res.status(409).json({
          error: `端口 ${updates.port} 已被代理「${conflict.name}」占用，请更换端口`,
        });
      }
    }

    const updated = configStore.updateProxy(req.params.id, updates);

    if (needRestart) {
      try {
        await startProxyWithProvider(updated);
      } catch (err) {
        return res.status(500).json({ error: `代理重启失败: ${err.message}` });
      }
    } else {
      // 更新供应商配置引用
      const target = resolveTarget(updated);
      if (target) proxyManager.updateProxyConfig({ ...updated, target });
    }

    res.json({ ...updated, running: proxyManager.isRunning(updated.id) });
  });

  // 删除代理
  app.delete('/api/proxies/:id', async (req, res) => {
    configStore.saveSnapshot('delete-proxy');
    const existing = configStore.getProxyById(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Proxy not found' });

    await proxyManager.stopProxy(req.params.id);
    configStore.removeProxy(req.params.id);
    res.json({ success: true });
  });

  // 启动/停止代理
  app.post('/api/proxies/:id/start', async (req, res) => {
    const proxy = configStore.getProxyById(req.params.id);
    if (!proxy) return res.status(404).json({ error: 'Proxy not found' });

    try {
      await startProxyWithProvider(proxy);
      res.json({ success: true, running: true });
    } catch (err) {
      res.status(500).json({ error: 'Failed to start proxy', message: err.message });
    }
  });

  app.post('/api/proxies/:id/stop', async (req, res) => {
    await proxyManager.stopProxy(req.params.id);
    res.json({ success: true, running: false });
  });

  // 批量启动所有代理
  app.post('/api/proxies/start-all', async (req, res) => {
    const proxies = configStore.getProxies();
    const results = [];
    for (const proxy of proxies) {
      if (proxyManager.isRunning(proxy.id)) {
        results.push({ id: proxy.id, name: proxy.name, skipped: true });
        continue;
      }
      try {
        await startProxyWithProvider(proxy);
        results.push({ id: proxy.id, name: proxy.name, success: true });
      } catch (err) {
        results.push({ id: proxy.id, name: proxy.name, success: false, error: err.message });
      }
    }
    res.json({ results });
  });

  // 批量停止所有代理
  app.post('/api/proxies/stop-all', async (req, res) => {
    const running = proxyManager.getRunningPorts();
    const results = [];
    for (const r of running) {
      await proxyManager.stopProxy(r.id);
      results.push({ id: r.id, name: r.name, success: true });
    }
    res.json({ results });
  });

  // 获取运行状态
  app.get('/api/status', (req, res) => {
    res.json({
      running: proxyManager.getRunningPorts(),
      total: configStore.getProxies().length,
    });
  });

  // 健康检查
  app.get('/api/health', (req, res) => {
    res.json({
      status: 'ok',
      version: pkg.version,
      uptime: process.uptime(),
      proxies: {
        total: configStore.getProxies().length,
        running: proxyManager.getRunningPorts().length,
      },
    });
  });

  // API Key 健康状态
  app.get('/api/key-health', (req, res) => {
    const result = {};
    for (const [providerId, health] of keyHealth) {
      result[providerId] = health;
    }
    res.json(result);
  });

  // 手动触发健康检查
  app.post('/api/key-health/check', async (req, res) => {
    await checkAllProviderKeys();
    res.json({ success: true });
  });

  // 设置
  app.get('/api/settings', (req, res) => {
    res.json(configStore.getSettings());
  });

  app.put('/api/settings', (req, res) => {
    const settings = req.body;
    if (!settings || typeof settings !== 'object') {
      return res.status(400).json({ error: '需要 settings 对象' });
    }
    for (const [key, value] of Object.entries(settings)) {
      configStore.setSetting(key, value);
    }
    res.json(configStore.getSettings());
  });

  // Token 用量统计
  app.get('/api/stats', (req, res) => {
    const { range, startDate, endDate, proxyId } = req.query;
    const stats = statsStore.getStats({
      range: range || 'daily',
      startDate: startDate || undefined,
      endDate: endDate || undefined,
      proxyId: proxyId || undefined,
    });
    const proxies = configStore.getProxies().map(p => ({
      id: p.id,
      name: p.name,
      providerName: configStore.getProviderById(p.providerId)?.name || '',
    }));
    res.json({ ...stats, proxies });
  });

  // 日志查看
  app.get('/api/logs', (req, res) => {
    const lines = Math.min(parseInt(req.query.lines) || 200, 2000);
    try {
      if (!fs.existsSync(logger.LOG_FILE)) {
        return res.json({ lines: [] });
      }
      const content = fs.readFileSync(logger.LOG_FILE, 'utf8');
      const allLines = content.split('\n').filter(l => l.trim());
      const tail = allLines.slice(-lines);
      res.json({ lines: tail, total: allLines.length });
    } catch (err) {
      res.json({ lines: [], error: err.message });
    }
  });

  // 实时请求日志
  const requestLog = require('./lib/request-log');
  app.get('/api/request-logs', (req, res) => {
    const limit = Math.min(parseInt(req.query.limit) || 200, 2000);
    res.json({ entries: requestLog.getAll(limit), total: requestLog.getCount() });
  });

  // ==================== 智控助手上下文 API ====================

  app.get('/api/assistant/context', async (req, res) => {
    const proxyList = configStore.getProxies().map(p => {
      const provider = configStore.getProviderById(p.providerId);
      return {
        id: p.id,
        name: p.name,
        port: p.port,
        running: proxyManager.isRunning(p.id),
        providerId: p.providerId,
        providerName: provider?.name || '',
        protocol: provider?.protocol || '',
        defaultModel: p.defaultModel || '',
        routingStrategy: p.routingStrategy || 'primary_fallback',
      };
    });

    const providerList = configStore.getProviders().map(p => ({
      id: p.id,
      name: p.name,
      url: p.url,
      protocol: p.protocol,
      apiKeys: (p.apiKeys || []).map((k, i) => ({ alias: k.alias || '', index: i, enabled: k.enabled !== false })),
    }));

    const healthData = {};
    for (const [providerId, health] of keyHealth) {
      healthData[providerId] = health;
    }

    const stats = statsStore.getStats({ range: 'daily' });

    let recentLogs = [];
    try {
      const content = await fs.promises.readFile(logger.LOG_FILE, 'utf8');
      const allLines = content.split('\n').filter(l => l.trim());
      recentLogs = allLines.slice(-30);
    } catch {}

    const recentRequests = requestLog.getAll(20);

    res.json({
      proxies: proxyList,
      providers: providerList,
      health: healthData,
      stats,
      recentLogs,
      recentRequests,
    });
  });

  // ==================== 智控助手 Tool Calling API ====================

  const conversationStore = require('./lib/conversation-store');
  conversationStore.init();

  const skillStore = require('./lib/skill-store');
  skillStore.init();

  const promptBuilder = require('./lib/prompt-builder');

  // 会话并发锁：convId → true 表示正在 streaming
  const activeStreams = new Set();

  function sendSSE(res, event, data) {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  // 会话管理 API
  app.get('/api/assistant/conversations', (req, res) => {
    res.json({ conversations: conversationStore.list() });
  });

  app.delete('/api/assistant/conversations/:id', (req, res) => {
    const conv = conversationStore.get(req.params.id);
    if (!conv) return res.status(404).json({ error: '会话不存在' });
    conversationStore.remove(req.params.id);
    res.json({ success: true });
  });

  // 获取单个会话的消息历史（用于恢复会话显示）
  app.get('/api/assistant/conversations/:id/messages', (req, res) => {
    const conv = conversationStore.get(req.params.id);
    if (!conv) return res.status(404).json({ error: '会话不存在' });
    // 返回消息历史（过滤掉 system 消息，前端不需要显示）
    const messages = (conv.messages || []).filter(m => m.role !== 'system');
    const compressionSummary = conv.compressionSummary || null;
    res.json({ id: conv.id, proxyId: conv.proxyId, messages, compressionSummary });
  });

  // 获取代理的候选供应商及其模型列表（供前端级联选择）
  app.get('/api/assistant/proxy-providers/:proxyId', (req, res) => {
    const proxy = configStore.getProxyById(req.params.proxyId);
    if (!proxy) return res.status(404).json({ error: '代理不存在' });
    const providers = configStore.getProviders().map(p => ({
      id: p.id,
      name: p.name,
      protocol: p.protocol,
      models: p.models || [],
    }));
    res.json({ providers, defaultModel: proxy.defaultModel || '' });
  });

  // ========== Skill API ==========
  app.get('/api/skills', (req, res) => {
    res.json({ skills: skillStore.list() });
  });

  app.get('/api/skills/:name', (req, res) => {
    const skill = skillStore.get(req.params.name);
    if (!skill) return res.status(404).json({ error: '技能不存在' });
    res.json(skill);
  });

  app.post('/api/skills', (req, res) => {
    const { name, description, content } = req.body;
    if (!name || !content) return res.status(400).json({ error: '需要 name 和 content' });
    const skill = skillStore.create(name, description || '', content);
    if (!skill) return res.status(409).json({ error: '技能已存在' });
    res.json(skill);
  });

  // 上传技能文件夹创建技能
  app.post('/api/skills/upload', (req, res) => {
    const { files } = req.body;
    if (!files || !files.length) return res.status(400).json({ error: '需要文件列表' });
    const skillMd = files.find(f => f.path === 'SKILL.md');
    if (!skillMd) return res.status(400).json({ error: '缺少 SKILL.md' });
    const MAX_BASE64 = 1024 * 1024;
    for (const f of files) {
      if (f.content.length > MAX_BASE64) return res.status(413).json({ error: `文件 ${f.path} 过大` });
    }
    const skill = skillStore.createFromUpload(files);
    if (!skill) return res.status(400).json({ error: 'SKILL.md 缺少 name 字段或技能已存在' });
    res.json(skill);
  });

  app.put('/api/skills/:name', (req, res) => {
    const { description, content } = req.body;
    const skill = skillStore.update(req.params.name, description || '', content || '');
    if (!skill) return res.status(404).json({ error: '技能不存在或不可编辑' });
    res.json(skill);
  });

  // 上传 skill 附属文件（scripts/reference）
  app.post('/api/skills/:name/upload', (req, res) => {
    const skill = skillStore.get(req.params.name);
    if (!skill) return res.status(404).json({ error: '技能不存在' });
    if (skill.category === 'system') return res.status(403).json({ error: '系统级技能不可修改' });
    const { filename, subDir, content } = req.body; // content: base64
    if (!filename || !content) return res.status(400).json({ error: '需要 filename 和 content' });
    const MAX_BASE64 = 1024 * 1024; // ~768KB decoded
    if (content.length > MAX_BASE64) return res.status(413).json({ error: '文件过大，最大 768KB' });
    const dir = subDir === 'reference' ? 'reference' : 'scripts';
    const targetDir = path.join(skill.dirPath, dir);
    fs.mkdirSync(targetDir, { recursive: true });
    const safeName = path.basename(filename).replace(/[^a-zA-Z0-9._-]/g, '_');
    fs.writeFileSync(path.join(targetDir, safeName), Buffer.from(content, 'base64'));
    skillStore.init(); // 重新加载
    res.json({ success: true, path: `${dir}/${safeName}` });
  });

  // 删除 skill 附属文件
  app.delete('/api/skills/:name/file', (req, res) => {
    const skill = skillStore.get(req.params.name);
    if (!skill) return res.status(404).json({ error: '技能不存在' });
    if (skill.category === 'system') return res.status(403).json({ error: '系统级技能不可修改' });
    const { filePath } = req.body;
    if (!filePath) return res.status(400).json({ error: '需要 filePath' });
    const fullPath = path.join(skill.dirPath, filePath);
    if (!fullPath.startsWith(skill.dirPath)) return res.status(400).json({ error: '无效路径' });
    try { fs.unlinkSync(fullPath); } catch {}
    skillStore.init();
    res.json({ success: true });
  });

  app.delete('/api/skills/:name', (req, res) => {
    const skill = skillStore.get(req.params.name);
    if (!skill) return res.status(404).json({ error: '技能不存在' });
    if (skill.category === 'system') return res.status(403).json({ error: '系统级技能不可删除' });
    if (!skillStore.remove(req.params.name)) {
      return res.status(500).json({ error: '删除失败，请检查文件权限' });
    }
    res.json({ success: true });
  });

  // ==================== MCP 服务管理 API ====================

  app.get('/api/mcp/servers', (req, res) => {
    const servers = configStore.getMcpServers();
    const status = mcpClient.getStatus();
    const statusMap = Object.fromEntries(status.map(s => [s.name, s]));
    const result = Object.entries(servers).map(([name, config]) => ({
      name,
      enabled: config.enabled !== false,
      transport: config.url ? 'http' : 'stdio',
      command: config.command,
      url: config.url,
      ...(statusMap[name] || { status: 'disconnected', tools: [], lastError: null }),
    }));
    res.json(result);
  });

  app.get('/api/mcp/servers/:name', (req, res) => {
    const config = configStore.getMcpServer(req.params.name);
    if (!config) return res.status(404).json({ error: 'MCP 服务不存在' });
    const status = mcpClient.getStatus().find(s => s.name === req.params.name);
    res.json({ name: req.params.name, config, ...(status || { status: 'disconnected', tools: [] }) });
  });

  app.post('/api/mcp/servers', async (req, res) => {
    const { name, command, args, env, url, headers, enabled } = req.body;
    if (!name) return res.status(400).json({ error: '需要服务名称' });
    if (!command && !url) return res.status(400).json({ error: '需要 command（本地）或 url（远程）' });
    const existing = configStore.getMcpServer(name);
    if (existing) return res.status(409).json({ error: '服务名已存在' });
    const serverConfig = {};
    if (url) {
      serverConfig.url = url;
      if (headers) serverConfig.headers = headers;
    } else {
      serverConfig.command = command;
      if (args) serverConfig.args = Array.isArray(args) ? args : args.split(/\s+/).filter(Boolean);
      if (env && Object.keys(env).length) serverConfig.env = env;
    }
    serverConfig.enabled = enabled !== false;
    configStore.addMcpServer(name, serverConfig);
    if (serverConfig.enabled) {
      mcpClient.connectServer(name, serverConfig).catch(err => {
        logger.error(`[MCP] 后台连接 ${name} 失败: ${err.message}`);
      });
    }
    res.json({ success: true, name });
  });

  app.put('/api/mcp/servers/:name', async (req, res) => {
    const { command, args, env, url, headers, enabled } = req.body;
    const existing = configStore.getMcpServer(req.params.name);
    if (!existing) return res.status(404).json({ error: 'MCP 服务不存在' });
    const updates = {};
    if (url !== undefined) {
      updates.url = url;
      if (headers !== undefined) updates.headers = headers;
      delete updates.command;
      delete updates.args;
      delete updates.env;
    }
    if (command !== undefined) {
      updates.command = command;
      if (args !== undefined) updates.args = Array.isArray(args) ? args : args.split(/\s+/).filter(Boolean);
      if (env !== undefined) updates.env = env;
      delete updates.url;
      delete updates.headers;
    }
    if (enabled !== undefined) updates.enabled = enabled;
    configStore.updateMcpServer(req.params.name, updates);
    const newConfig = configStore.getMcpServer(req.params.name);
    if (newConfig.enabled) {
      mcpClient.reconnectIfChanged(req.params.name, newConfig).catch(() => {});
    } else {
      await mcpClient.disconnectServer(req.params.name);
    }
    res.json({ success: true });
  });

  app.delete('/api/mcp/servers/:name', async (req, res) => {
    const existing = configStore.getMcpServer(req.params.name);
    if (!existing) return res.status(404).json({ error: 'MCP 服务不存在' });
    await mcpClient.disconnectServer(req.params.name);
    configStore.removeMcpServer(req.params.name);
    res.json({ success: true });
  });

  app.post('/api/mcp/servers/:name/connect', async (req, res) => {
    const config = configStore.getMcpServer(req.params.name);
    if (!config) return res.status(404).json({ error: 'MCP 服务不存在' });
    try {
      await mcpClient.connectServer(req.params.name, config);
      const status = mcpClient.getStatus().find(s => s.name === req.params.name);
      res.json(status || { status: 'error', lastError: '连接失败' });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/mcp/servers/:name/disconnect', async (req, res) => {
    await mcpClient.disconnectServer(req.params.name);
    res.json({ success: true });
  });

  app.get('/api/mcp/tools', (req, res) => {
    const status = mcpClient.getStatus();
    const allTools = status.filter(s => s.status === 'connected').flatMap(s =>
      s.tools.map(t => ({ ...t, server: s.name, transport: s.transport }))
    );
    res.json(allTools);
  });


  app.post('/api/assistant/chat', async (req, res) => {
    const { proxyId, conversationId, message, compress, providerId, model } = req.body;
    if (!proxyId || (!compress && !message)) {
      return res.status(400).json({ error: '需要 proxyId 和 message' });
    }

    const proxy = configStore.getProxyById(proxyId);
    if (!proxy) return res.status(404).json({ error: '代理不存在' });
    if (!resolveTarget(proxy)) return res.status(500).json({ error: '代理目标未配置' });

    // 查找或创建对话
    const settings = configStore.getSettings();
    let convId = conversationId;
    let conv;
    if (convId) {
      conv = conversationStore.get(convId);
    }
    if (!conv && compress) {
      return res.status(404).json({ error: '会话不存在，无法压缩' });
    }
    if (!conv) {
      const maxConvs = parseInt(settings.maxConversations) || 0;
      conv = conversationStore.create(proxyId, maxConvs);
      convId = conv.id;
    }

    // 并发锁：同一会话正在 streaming 时拒绝新请求
    if (activeStreams.has(convId)) {
      return res.status(429).json({ error: '该会话正在处理中，请稍后再试' });
    }
    activeStreams.add(convId);
    conversationStore.touch(conv);

    // 追加用户消息到对话历史（压缩请求不追加空消息）
    // 检测 /skillname 前缀触发技能
    let activeSkill = null;
    if (!compress && message) {
      const slashMatch = message.match(/^\/([a-zA-Z0-9_-]+)(?:\s+([\s\S]*))?$/);
      if (slashMatch) {
        const skillName = slashMatch[1];
        const skill = skillStore.get(skillName);
        if (skill) {
          activeSkill = skill;
          // 将用户消息中的参数部分也保留
          const args = slashMatch[2]?.trim();
          if (args) {
            conv.messages.push({ role: 'user', content: args });
          }
        } else {
          conv.messages.push({ role: 'user', content: message });
        }
      } else {
        conv.messages.push({ role: 'user', content: message });
      }
      conversationStore.touch(conv);
    }

    const proxyUrl = `http://localhost:${proxy.port}/v1/chat/completions`;
    const proxyHeaders = { 'Content-Type': 'application/json' };
    if (proxy.requireAuth && proxy.authToken) {
      proxyHeaders['Authorization'] = `Bearer ${proxy.authToken}`;
    }
    if (providerId) proxyHeaders['x-pp-provider-id'] = providerId;
    if (model) proxyHeaders['x-pp-model'] = model;
    // 若供应商不在代理候选池中，传递完整供应商配置供代理动态构建临时候选
    if (providerId) {
      const target = resolveTarget(proxy);
      const inPool = target?.providerPool?.some(c => c.providerId === providerId);
      if (!inPool) {
        const provider = configStore.getProviderById(providerId);
        if (provider) {
          proxyHeaders['x-pp-provider-url'] = provider.url;
          proxyHeaders['x-pp-provider-protocol'] = provider.protocol;
          const enabledKeys = (provider.apiKeys || []).filter(k => k.enabled !== false).map(k => k.key);
          if (enabledKeys.length > 0) proxyHeaders['x-pp-provider-keys'] = JSON.stringify(enabledKeys);
        }
      }
    }

    // SSE 响应头
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    function safeSSE(event, data) {
      try { sendSSE(res, event, data); } catch {}
    }
    const MAX_CONTEXT = Math.max(10000, parseInt(settings.maxContext) || 200000);
    const MAX_TOOL_ROUNDS = Math.max(1, Math.min(100, parseInt(settings.maxRounds) || 10));

    // 手动压缩请求
    if (compress) {
      logger.log(`[assistant] 压缩请求 — ${conv.messages.length} messages`);
      safeSSE('compressing', {});
      const result = await compressConversation(conv, MAX_CONTEXT, proxyUrl, proxyHeaders, proxy.defaultModel);
      if (result) {
        conv.messages = result.messages;
        conv.compressionSummary = result.summary;
        conversationStore.touch(conv);
        safeSSE('compressed', { summary: result.summary, removedCount: result.removedCount, tokens: result.newTokens, maxTokens: MAX_CONTEXT, messages: conv.messages.length });
        logger.log(`[assistant] 压缩完成 — 移除 ${result.removedCount} 条`);
      } else {
        safeSSE('compressed', { summary: null, removedCount: 0, tokens: estimateConversationTokens(conv.messages), maxTokens: MAX_CONTEXT, messages: conv.messages.length });
      }
      safeSSE('done', {});
      res.end();
      return;
    }

    // 发送 conversationId 给前端
    safeSSE('conversation', { id: convId });

    try {
      // 请求级别缓存 system prompt（避免每轮重建导致 prompt cache 失效）
      const systemPrompt = promptBuilder.buildSystemPrompt({ skillStore, mcpClient });
      const buildMessages = () => {
        const msgs = [{ role: 'system', content: systemPrompt }];
        if (activeSkill) {
          let skillInfo = `[技能指令: ${activeSkill.name}]\n${activeSkill.content}`;
          if (activeSkill.dirPath) skillInfo += `\n\n技能目录: ${activeSkill.dirPath}`;
          if (activeSkill.scripts?.length > 0) skillInfo += `\n可用脚本: ${activeSkill.scripts.map(f => 'scripts/' + f).join(', ')}`;
          msgs.push({ role: 'system', content: skillInfo });
        }
        if (conv.compressionSummary) {
          msgs.push({ role: 'system', content: `[压缩摘要]\n${conv.compressionSummary}\n\n---\n以上是之前对话的压缩摘要。最近的消息保留原文。请继续对话，不要复述摘要内容。` });
        }
        msgs.push(...conv.messages);
        return msgs;
      };

      let currentTokens = estimateConversationTokens(buildMessages());
      const sendContext = () => {
        const pct = Math.round(currentTokens / MAX_CONTEXT * 1000) / 10;
        safeSSE('context', { tokens: currentTokens, maxTokens: MAX_CONTEXT, percent: pct, messages: conv.messages.length });
      };
      sendContext();

      for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
        const messages = buildMessages();
        logger.log(`[assistant] round ${round} — ${messages.length} messages, ~${currentTokens} tokens`);

        let fetchRes;
        try {
          fetchRes = await fetch(proxyUrl, {
            method: 'POST',
            headers: proxyHeaders,
            signal: AbortSignal.timeout(300000),
            body: JSON.stringify({
              model: proxy.defaultModel || 'gpt-4o',
              messages,
              stream: true,
              tools: [...TOOL_DEFINITIONS, ...mcpClient.getToolDefinitions()],
              tool_choice: 'auto',
            }),
          });
        } catch (fetchErr) {
          logger.log(`[assistant] round ${round} fetch error: ${fetchErr.message}`);
          safeSSE('error', { message: `代理请求失败: ${fetchErr.message}` });
          break;
        }

        if (!fetchRes.ok) {
          const text = await fetchRes.text();
          logger.log(`[assistant] round ${round} HTTP ${fetchRes.status}: ${text.slice(0, 200)}`);
          safeSSE('error', { message: `代理请求失败: HTTP ${fetchRes.status} - ${text}` });
          break;
        }

        // 解析 SSE 流
        const reader = fetchRes.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let fullContent = '';
        let reasoningContent = '';
        const toolCallAccumulator = {};

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop();
          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || !trimmed.startsWith('data: ')) continue;
            const payload = trimmed.slice(6);
            if (payload === '[DONE]') continue;
            try {
              const data = JSON.parse(payload);
              const delta = data.choices?.[0]?.delta;
              if (!delta) continue;
              if (delta.content) { fullContent += delta.content; safeSSE('content', { delta: delta.content }); }
              if (delta.reasoning_content) reasoningContent += delta.reasoning_content;
              if (delta.tool_calls) {
                for (const tc of delta.tool_calls) {
                  const idx = tc.index;
                  if (!toolCallAccumulator[idx]) toolCallAccumulator[idx] = { id: '', name: '', arguments: '' };
                  if (tc.id) toolCallAccumulator[idx].id = tc.id;
                  if (tc.function?.name) toolCallAccumulator[idx].name = tc.function.name;
                  if (tc.function?.arguments) toolCallAccumulator[idx].arguments += tc.function.arguments;
                }
              }
            } catch {}
          }
        }

        const toolCalls = Object.values(toolCallAccumulator).filter(tc => tc.id && tc.name);
        logger.log(`[assistant] round ${round} done — ${fullContent.length} chars, ${toolCalls.length} tool calls`);

        if (toolCalls.length === 0) {
          // 最终回复，追加到对话历史（跳过空响应避免 null content 污染历史）
          if (fullContent || reasoningContent) {
            const assistantMsg = { role: 'assistant', content: fullContent || null };
            if (reasoningContent) assistantMsg.reasoning_content = reasoningContent;
            conv.messages.push(assistantMsg);
          }
          currentTokens = estimateConversationTokens(buildMessages());
          sendContext();
          safeSSE('done', { reasoning_content: reasoningContent || undefined });
          break;
        }

        // 通知前端
        safeSSE('tool_calls', {
          reasoning_content: reasoningContent || undefined,
          calls: toolCalls.map(tc => {
            let args = {};
            try { args = JSON.parse(tc.arguments); } catch (e) {
              logger.log(`[assistant] tool_calls args parse error (${tc.name}): ${e.message}, raw: ${(tc.arguments || '').slice(0, 200)}`);
              args = { _raw: tc.arguments, _parseError: true };
            }
            return { id: tc.id, name: tc.name, arguments: args };
          }),
        });

        // 追加 assistant(tool_calls) 到对话历史
        const assistantMsg = {
          role: 'assistant',
          content: fullContent || null,
          tool_calls: toolCalls.map(tc => ({ id: tc.id, type: 'function', function: { name: tc.name, arguments: tc.arguments } })),
        };
        if (reasoningContent) assistantMsg.reasoning_content = reasoningContent;
        conv.messages.push(assistantMsg);

        // 执行工具
        for (const tc of toolCalls) {
          let args = {};
          let argsParseError = false;
          try { args = JSON.parse(tc.arguments); } catch (e) {
            logger.log(`[assistant] tool args parse error (${tc.name}): ${e.message}`);
            argsParseError = true;
          }
          logger.log(`[assistant] EXEC tool: ${tc.name}`);
          let result;
          let isError = false;
          if (argsParseError) {
            result = { error: `工具 ${tc.name} 的参数 JSON 解析失败，原始内容: ${(tc.arguments || '').slice(0, 200)}` };
            isError = true;
          } else try {
            const mcpHandler = tc.name.startsWith('mcp__') ? mcpClient.getToolHandlerMap()[tc.name] : null;
            result = await (TOOL_HANDLERS[tc.name] || mcpHandler)?.(args) || { error: `未知工具: ${tc.name}` };
            if (result && result.error) isError = true;
          } catch (err) {
            logger.log(`[assistant] tool ${tc.name} error: ${err.message}`);
            result = { error: err.message };
            isError = true;
          }
          result = truncateOutput(result);
          const resultStr = JSON.stringify(result);
          logger.log(`[assistant] tool ${tc.name} done: ${resultStr.length} chars${isError ? ' (error)' : ''}`);
          safeSSE('tool_result', { tool_call_id: tc.id, name: tc.name, result, is_error: isError });
          conv.messages.push({ role: 'tool', tool_call_id: tc.id, content: isError ? `[ERROR] ${resultStr}` : resultStr });
        }

        // token 检查 + 压缩
        currentTokens = estimateConversationTokens(buildMessages());
        sendContext();
        if (currentTokens >= MAX_CONTEXT * 0.8) {
          logger.log(`[assistant] 上下文 ${Math.round(currentTokens / MAX_CONTEXT * 100)}%，自动压缩`);
          safeSSE('compressing', {});
          const compResult = await compressConversation(conv, MAX_CONTEXT, proxyUrl, proxyHeaders, proxy.defaultModel);
          if (compResult) {
            conv.messages = compResult.messages;
            conv.compressionSummary = compResult.summary;
            conversationStore.touch(conv);
            currentTokens = compResult.newTokens;
            safeSSE('compressed', { summary: compResult.summary, removedCount: compResult.removedCount, tokens: currentTokens, maxTokens: MAX_CONTEXT, messages: conv.messages.length });
            sendContext();
            logger.log(`[assistant] 压缩完成 — 移除 ${compResult.removedCount} 条`);
          }
        }
      }

      // 达到最大轮次 → 总结回复
      logger.log(`[assistant] max rounds reached, requesting summary`);
      try {
        const summaryRes = await fetch(proxyUrl, {
          method: 'POST',
          headers: proxyHeaders,
          signal: AbortSignal.timeout(120000),
          body: JSON.stringify({
            model: proxy.defaultModel || 'gpt-4o',
            messages: [
              ...buildMessages(),
              { role: 'system', content: '你已达到最大工具调用轮次限制（' + MAX_TOOL_ROUNDS + ' 轮），无法继续调用工具。请基于已获取的信息给出回复，并明确告知用户：由于达到工具调用轮次上限，信息获取可能不完整或操作被迫中断。如果还有未完成的工作，请说明并建议用户重新提问以继续。' },
            ],
            stream: true,
          }),
        });
        if (summaryRes.ok) {
          const sr = summaryRes.body.getReader();
          const sd = new TextDecoder();
          let sb = '';
          let summaryContent = '';
          let summaryReasoning = '';
          while (true) {
            const { done: finished, value: v } = await sr.read();
            if (finished) break;
            sb += sd.decode(v, { stream: true });
            const lines = sb.split('\n');
            sb = lines.pop();
            for (const line of lines) {
              const t = line.trim();
              if (!t || !t.startsWith('data: ') || t === 'data: [DONE]') continue;
              try {
                const chunk = JSON.parse(t.slice(6));
                const delta = chunk.choices?.[0]?.delta;
                if (!delta) continue;
                if (delta.content) { summaryContent += delta.content; safeSSE('content', { delta: delta.content }); }
                if (delta.reasoning_content) summaryReasoning += delta.reasoning_content;
              } catch {}
            }
          }
          // 追加总结到对话历史
          const summaryMsg = { role: 'assistant', content: summaryContent || null };
          if (summaryReasoning) summaryMsg.reasoning_content = summaryReasoning;
          conv.messages.push(summaryMsg);
          safeSSE('done', { reasoning_content: summaryReasoning || undefined });
        } else {
          safeSSE('done', {});
        }
      } catch {
        safeSSE('done', {});
      }
    } catch (err) {
      logger.log(`[assistant] error: ${err.message}`);
      if (!res.headersSent) {
        res.status(502).json({ error: `助手请求失败: ${err.message}` });
      } else {
        safeSSE('error', { message: err.message });
      }
    } finally {
      activeStreams.delete(convId);
      conversationStore.touch(conv); // 保存最终对话状态
      res.end();
    }
  });

  // ==================== 配置导入/导出 ====================

  app.get('/api/config/export', (req, res) => {
    const providers = configStore.getProviders();
    const proxies = configStore.getProxies().map(p => {
      const provider = configStore.getProviderById(p.providerId);
      return {
        id: p.id,
        name: p.name,
        port: p.port,
        requireAuth: p.requireAuth,
        authToken: p.authToken,
        providerId: p.providerId,
        defaultModel: p.defaultModel || '',
        routingStrategy: p.routingStrategy || 'primary_fallback',
        providerPool: Array.isArray(p.providerPool) ? p.providerPool : [],
        providerName: provider?.name || '',
      };
    });
    res.json({ providers, proxies, exportedAt: new Date().toISOString() });
  });

  app.post('/api/config/import', async (req, res) => {
    const { config, mode } = req.body;

    if (!config || !mode || !['overwrite', 'merge'].includes(mode)) {
      return res.status(400).json({ error: '需要 config 和 mode（overwrite/merge）' });
    }

    configStore.saveSnapshot('import-' + mode);

    // 校验结构
    if (!Array.isArray(config.providers) || !Array.isArray(config.proxies)) {
      return res.status(400).json({ error: '配置格式错误：需要 providers 和 proxies 数组' });
    }

    for (const p of config.providers) {
      if (!p.name || !p.url || !p.protocol) {
        return res.status(400).json({ error: `供应商 "${p.name || '?'}" 缺少必要字段（name/url/protocol）` });
      }
    }

    for (const p of config.proxies) {
      if (!p.name || !p.port || !p.providerId) {
        return res.status(400).json({ error: `代理 "${p.name || '?'}" 缺少必要字段（name/port/providerId）` });
      }
    }

    if (mode === 'overwrite') {
      // 覆盖模式：直接替换整个配置
      const newConfig = {
        providers: config.providers.map(p => ({
          id: p.id,
          name: p.name,
          url: p.url,
          protocol: p.protocol,
          apiKey: p.apiKey || '',
          models: Array.isArray(p.models) ? p.models : [],
        })),
        proxies: config.proxies.map(p => ({
          id: p.id,
          name: p.name,
          port: p.port,
          requireAuth: !!p.requireAuth,
          authToken: p.authToken || null,
          providerId: p.providerId,
          defaultModel: p.defaultModel || '',
          routingStrategy: normalizeRoutingStrategyInput(p.routingStrategy),
          providerPool: normalizeProviderPoolInput(p.providerPool),
        })),
      };
      configStore.saveConfig(newConfig);
      return res.json({ success: true, mode, providers: newConfig.providers.length, proxies: newConfig.proxies.length });
    }

    // 合并模式：按 ID 去重
    const existingProviders = configStore.getProviders();
    const existingProxies = configStore.getProxies();

    const providerMap = new Map(existingProviders.map(p => [p.id, p]));
    for (const p of config.providers) {
      providerMap.set(p.id, {
        id: p.id,
        name: p.name,
        url: p.url,
        protocol: p.protocol,
        apiKey: p.apiKey || '',
        models: Array.isArray(p.models) ? p.models : [],
        routingStrategy: normalizeRoutingStrategyInput(p.routingStrategy),
        providerPool: normalizeProviderPoolInput(p.providerPool),
      });
    }

    const proxyMap = new Map(existingProxies.map(p => [p.id, p]));
    for (const p of config.proxies) {
      // 检查端口冲突：导入的代理端口不能和现有代理或其他导入代理重复
      const conflict = proxyMap.get(p.id)
        ? null // 同 ID 是覆盖，不算冲突
        : Array.from(proxyMap.values()).find(ep => ep.port === p.port);
      if (conflict) {
        return res.status(409).json({
          error: `端口 ${p.port} 已被代理「${conflict.name}」占用，无法导入代理「${p.name}」`,
        });
      }
        proxyMap.set(p.id, {
          id: p.id,
          name: p.name,
          port: p.port,
          requireAuth: !!p.requireAuth,
          authToken: p.authToken || null,
          providerId: p.providerId,
          defaultModel: p.defaultModel || '',
          routingStrategy: normalizeRoutingStrategyInput(p.routingStrategy),
          providerPool: normalizeProviderPoolInput(p.providerPool),
        });
      }

    const merged = {
      providers: Array.from(providerMap.values()),
      proxies: Array.from(proxyMap.values()),
    };
    configStore.saveConfig(merged);

    res.json({
      success: true,
      mode,
      providers: merged.providers.length,
      proxies: merged.proxies.length,
      added: {
        providers: merged.providers.length - existingProviders.length,
        proxies: merged.proxies.length - existingProxies.length,
      },
    });
  });

  // ==================== 配置版本历史 ====================

  app.get('/api/config/history', (req, res) => {
    const snapshots = configStore.getSnapshots();
    res.json({ snapshots });
  });

  app.post('/api/config/rollback', async (req, res) => {
    const { file } = req.body;
    if (!file) return res.status(400).json({ error: '需要指定快照文件' });
    const result = configStore.restoreSnapshot(file);
    if (result.error) return res.status(400).json({ error: result.error });
    res.json({ success: true });
  });

  // 前端首页
  app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
  });

  // 启动
  logger.init();
  writePid();

  // 启动所有已配置的代理
  const proxies = configStore.getProxies();
  await Promise.all(proxies.map(async (proxy) => {
    try {
      await startProxyWithProvider(proxy);
    } catch (err) {
      logger.error(`[Init] Failed to start proxy ${proxy.name}:`, err.message);
    }
  }));

  const http = require('http');
  const server = app.listen(PORT, () => {
    const adminUrl = `http://localhost:${PORT}`;
    logger.log(`[Admin] Management server running on ${adminUrl}`);
    logger.log(`[Admin] ${proxies.length} proxy config(s) loaded`);
    logger.log(`[Admin] 日志文件: ${logger.LOG_FILE}`);

    // 初始化 WebSocket 实时日志
    const wsServer = require('./lib/ws-server');
    wsServer.init(server);
    requestLog.onEntry((entry) => wsServer.broadcast(entry));
    logger.log(`[Admin] WebSocket 已附加 (ws://localhost:${PORT})`);

    // 初始化 MCP 客户端
    mcpClient.init({
      onUpdate: (serverName, status) => {
        wsServer.broadcast({ type: 'mcp_status', server: serverName, ...status });
      }
    }).then(() => {
      const status = mcpClient.getStatus();
      const connected = status.filter(s => s.status === 'connected').length;
      if (status.length > 0) logger.log(`[MCP] ${connected}/${status.length} 个 MCP 服务已连接`);
    }).catch(err => {
      logger.error('[MCP] 初始化失败:', err.message);
    });

    openBrowser(adminUrl);
  });
}

// 优雅关闭
process.on('SIGINT', async () => {
  logger.log('[Shutdown] Shutting down...');
  removePid();
  try {
    const wsServer = require('./lib/ws-server');
    wsServer.close();
    const mcpClient = require('./lib/mcp-client');
    await mcpClient.shutdown();
    const proxyManager = require('./lib/proxy-manager');
    const statsStore = require('./lib/stats-store');
    statsStore.flush();
    await proxyManager.stopAll();
  } catch (err) {
    logger.error('[Shutdown] stopAll error:', err.message);
  }
  process.exit(0);
});

process.on('SIGTERM', async () => {
  removePid();
  try {
    const wsServer = require('./lib/ws-server');
    wsServer.close();
    const mcpClient = require('./lib/mcp-client');
    await mcpClient.shutdown();
    const proxyManager = require('./lib/proxy-manager');
    const statsStore = require('./lib/stats-store');
    statsStore.flush();
    await proxyManager.stopAll();
  } catch (err) {
    logger.error('[Shutdown] stopAll error:', err.message);
  }
  process.exit(0);
});

// ==================== CLI Dispatch ====================

const cmd = process.argv[2];

switch (cmd) {
  case 'help':
    showHelp();
    break;
  case '-v':
  case '--version':
    showVersion();
    break;
  case 'update':
    updateService();
    break;
  case 'stop':
    stopService();
    break;
  case 'status':
    showStatus();
    break;
  case 'start':
    startDaemon();
    break;
  case '--daemon':
    init();
    break;
  case undefined:
    init();
    break;
  default:
    console.error(`未知命令: ${cmd}`);
    showHelp();
    process.exit(1);
}
