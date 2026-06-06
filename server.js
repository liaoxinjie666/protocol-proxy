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

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 3; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const key = argv[i].slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        args[key] = next;
        i++;
      } else {
        args[key] = true;
      }
    } else {
      args._.push(argv[i]);
    }
  }
  return args;
}

function getAdminPort() {
  return process.env.ADMIN_PORT || 3000;
}

function requireServiceRunning() {
  const pid = readPid();
  if (!pid || !isProcessAlive(pid)) {
    console.log('服务未运行，请先执行: protocol-proxy start');
    process.exit(1);
  }
  return pid;
}

function pad(str, len) {
  const s = String(str);
  return s.length >= len ? s : s + ' '.repeat(len - s.length);
}

function formatNum(n) {
  return Number(n || 0).toLocaleString();
}

async function testProvider(nameFilter) {
  const configStore = require('./lib/config-store');
  let providers = configStore.getProviders();
  if (providers.length === 0) {
    console.log('没有已配置的供应商');
    return;
  }
  if (nameFilter) {
    const q = nameFilter.toLowerCase();
    providers = providers.filter(p => p.name.toLowerCase().includes(q));
    if (providers.length === 0) {
      console.log(`未找到名称包含 "${nameFilter}" 的供应商`);
      return;
    }
  }

  console.log('测试 Provider 连通性...\n');
  let totalKeys = 0, totalPassed = 0, totalFailed = 0;

  for (const provider of providers) {
    const keys = (provider.apiKeys || []).filter(k => k.enabled !== false);
    if (keys.length === 0) {
      console.log(`[${provider.name}] ${provider.url} (${provider.protocol || 'openai'})`);
      console.log('  无可用 API Key\n');
      continue;
    }

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
        const _fm = provider.models?.[0]; const testModel = (typeof _fm === 'string' ? _fm : _fm?.name) || 'claude-3-haiku-20240307';
        return { url: hasV1Suffix ? `${base}/messages` : `${base}/v1/messages`, opts: { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' }, body: JSON.stringify({ model: testModel, max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] }) } };
      }
      if (protocol === 'responses') {
        return { url: hasV1Suffix ? `${base}/models` : `${base}/v1/models`, opts: { headers: { 'Authorization': `Bearer ${key}` } } };
      }
      if (protocol === 'gemini') return { url: `${base}/v1beta/models?key=${key}`, opts: {} };
      return null;
    }

    console.log(`[${provider.name}] ${provider.url} (${protocol})`);
    for (const k of keys) {
      totalKeys++;
      const built = buildTestUrl(k.key);
      if (!built) {
        console.log(`  - ${k.alias || '***'}  X 不支持的协议: ${protocol}`);
        totalFailed++;
        continue;
      }
      try {
        const startedAt = Date.now();
        const res = await fetch(built.url, { ...built.opts, signal: AbortSignal.timeout(10000) });
        const latencyMs = Date.now() - startedAt;
        if (res.ok) {
          console.log(`  - ${k.alias || '***'}  V ${latencyMs}ms`);
          totalPassed++;
        } else {
          const hint = res.status === 401 || res.status === 403 ? 'Key 无效或无权限' : `HTTP ${res.status}`;
          console.log(`  - ${k.alias || '***'}  X ${hint} (${latencyMs}ms)`);
          totalFailed++;
        }
      } catch (err) {
        const msg = err.name === 'TimeoutError' ? '连接超时 (10s)' : `连接失败: ${err.message}`;
        console.log(`  - ${k.alias || '***'}  X ${msg}`);
        totalFailed++;
      }
    }
    console.log('');
  }

  console.log(`测试完成: ${providers.length} 个 provider, ${totalKeys} 个 key, ${totalPassed} 通过, ${totalFailed} 失败`);
}

async function showLogs(opts) {
  requireServiceRunning();
  const port = getAdminPort();
  const limit = parseInt(opts.limit) || 20;

  if (opts.tail) {
    console.log(`实时跟踪请求日志 (Ctrl+C 退出)...\n`);
    try {
      const res = await fetch(`http://localhost:${port}/api/request-logs?limit=${limit}`);
      const data = await res.json();
      if (data.entries && data.entries.length > 0) {
        printLogEntries(data.entries);
      }
    } catch {}

    const WebSocket = require('ws');
    const ws = new WebSocket(`ws://localhost:${port}`);
    ws.on('message', (raw) => {
      try {
        const entry = JSON.parse(raw);
        if (entry.id && entry.timestamp) {
          printLogEntry(entry);
        }
      } catch {}
    });
    ws.on('error', (err) => {
      console.error('WebSocket 连接失败:', err.message);
      process.exit(1);
    });
    process.on('SIGINT', () => { ws.close(); process.exit(0); });
    return;
  }

  try {
    const params = new URLSearchParams();
    params.set('limit', String(Math.min(limit, 2000)));
    const res = await fetch(`http://localhost:${port}/api/request-logs?${params}`);
    const data = await res.json();
    let entries = data.entries || [];

    if (opts.status) {
      entries = entries.filter(e => e.status === opts.status);
    }
    if (opts.model) {
      const q = opts.model.toLowerCase();
      entries = entries.filter(e => (e.model || '').toLowerCase().includes(q));
    }

    console.log(`请求日志 (最近 ${entries.length} 条, 缓冲区 ${data.total || 0} 条)\n`);
    if (entries.length === 0) {
      console.log('暂无请求日志');
      return;
    }
    printLogEntries(entries);
  } catch (err) {
    console.error('获取日志失败:', err.message);
    process.exit(1);
  }
}

function formatTime(ts) {
  if (!ts) return '-';
  const d = new Date(ts);
  const MM = String(d.getMonth() + 1).padStart(2, '0');
  const DD = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${d.getFullYear()}-${MM}-${DD} ${hh}:${mm}:${ss}`;
}

function printLogEntries(entries) {
  for (const e of entries) {
    printLogEntry(e);
  }
}

function printLogEntry(e) {
  const time = formatTime(e.timestamp);
  const statusIcon = e.status === 'success' ? 'V' : e.status === '429' ? '!' : 'X';
  const statusText = e.status === 'success' ? '成功' : e.status === '429' ? '限流' : '失败';
  const model = pad((e.model || '-').slice(0, 20), 20);
  const latency = e.latencyMs != null ? `${e.latencyMs}ms` : '-';
  const input = e.promptTokens != null ? String(e.promptTokens) : '-';
  const output = e.completionTokens != null ? String(e.completionTokens) : '-';
  const proxy = e.proxyName || '-';
  console.log(`${time}  ${statusIcon} ${pad(statusText, 4)}  ${model}  ${pad(latency, 8)}  ${pad(input, 7)}  ${pad(output, 7)}  ${proxy}`);
  if (e.status !== 'success' && e.errorMessage) {
    console.log(`  错误: ${e.errorMessage}`);
  }
}

async function showStats(opts) {
  requireServiceRunning();
  const port = getAdminPort();
  const range = opts.today ? 'hourly' : (opts.range || 'daily');

  try {
    const params = new URLSearchParams();
    params.set('range', range);
    if (opts.proxy) params.set('proxyId', opts.proxy);
    const res = await fetch(`http://localhost:${port}/api/stats?${params}`);
    const data = await res.json();
    const s = data.summary;

    const rangeLabel = { hourly: '小时', daily: '天', monthly: '月', yearly: '年' }[range] || range;
    console.log(`用量统计 (${rangeLabel})\n`);

    if (!s || s.total === 0) {
      console.log('暂无统计数据');
      return;
    }

    console.log(`总计: ${formatNum(s.total)} tokens (输入 ${formatNum(s.prompt)} / 输出 ${formatNum(s.completion)}) | ${formatNum(s.requests)} 次请求`);
    if (s.hasEstimated) {
      console.log(`  (含 ${formatNum(s.estimatedCount)} 次估算用量)`);
    }

    if (data.byProvider && data.byProvider.length > 0) {
      console.log(`\n按 Provider:`);
      for (const p of data.byProvider) {
        console.log(`  ${pad(p.name, 20)} ${pad(formatNum(p.total) + ' tokens', 18)} ${formatNum(p.requests)} 次请求`);
      }
    }

    if (data.byModel && data.byModel.length > 0) {
      console.log(`\n按模型:`);
      for (const m of data.byModel) {
        console.log(`  ${pad(m.provider + '/' + m.model, 30)} ${pad(formatNum(m.total) + ' tokens', 18)} ${formatNum(m.requests)} 次请求`);
      }
    }
  } catch (err) {
    console.error('获取统计失败:', err.message);
    process.exit(1);
  }
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
  protocol-proxy autostart       查看/设置开机自启动 (status|on|off)
  protocol-proxy update       更新到最新版本

诊断命令:
  protocol-proxy test [name]  测试供应商连通性（可按名称过滤）
  protocol-proxy logs         查看最近请求日志
    --tail                    实时跟踪新请求
    --status <status>         按状态过滤 (success|failure|429)
    --model <name>            按模型名过滤
    --limit <n>               显示条数 (默认 20)
  protocol-proxy stats        查看用量统计
    --range <range>           统计粒度 (hourly|daily|monthly|yearly)
    --today                   只显示今天（按小时）
    --proxy <id>              按代理过滤
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
  const mcpToolStats = require('./lib/mcp-tool-stats');
  const clientConfig = require('./lib/client-config');
  mcpToolStats.load();

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
  app.use(express.json({ limit: '100mb' }));

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

  function generateMsgId() {
    return 'msg-' + Date.now() + '-' + Math.random().toString(36).slice(2, 10);
  }

  function resolveTarget(proxy) {
    const primaryProvider = configStore.getProviderById(proxy.providerId);
    if (!primaryProvider) return null;

    const pool = [];
    const seen = new Set();

    // Primary provider (no model override) — 跳过已禁用的供应商
    if (primaryProvider.enabled !== false) {
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
        adapter: primaryProvider.adapter || '',
        capabilities: Array.isArray(primaryProvider.capabilities) ? primaryProvider.capabilities : [],
        model: '',
        weight: Math.max(1, parseInt(proxy.providerWeight, 10) || 1),
      });
    }

    // Pool entries (may include model override) — 跳过已禁用的供应商
    for (const entry of (proxy.providerPool || [])) {
      if (!entry || !entry.providerId) continue;
      const model = typeof entry.model === 'string' ? entry.model.trim() : '';
      const key = `${entry.providerId}\0${model}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const provider = configStore.getProviderById(entry.providerId);
      if (!provider || provider.enabled === false) continue;
      pool.push({
        providerId: provider.id,
        providerName: provider.name,
        providerUrl: provider.url,
        protocol: provider.protocol,
        apiKeys: provider.apiKeys || [],
        models: provider.models,
        azureDeployment: provider.azureDeployment || '',
        azureApiVersion: provider.azureApiVersion || '',
        adapter: provider.adapter || '',
        capabilities: Array.isArray(provider.capabilities) ? provider.capabilities : [],
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

  function resolveModelContext(effectiveModel, proxy, settings, overrideProviderId) {
    if (effectiveModel) {
      // 优先查找用户在助手面板手动指定的供应商
      if (overrideProviderId) {
        const p = configStore.getProviderById(overrideProviderId);
        if (p) {
          const m = (p.models || []).find(m => m.name === effectiveModel);
          if (m && m.contextLength > 0) return m.contextLength;
        }
      }
      if (proxy) {
        const provider = configStore.getProviderById(proxy.providerId);
        if (provider) {
          const m = (provider.models || []).find(m => m.name === effectiveModel);
          if (m && m.contextLength > 0) return m.contextLength;
        }
        for (const entry of (proxy.providerPool || [])) {
          const p = configStore.getProviderById(entry.providerId);
          if (!p) continue;
          const m = (p.models || []).find(m => m.name === effectiveModel);
          if (m && m.contextLength > 0) return m.contextLength;
        }
      }
    }
    return Math.max(10000, parseInt(settings.maxContext) || 200000);
  }

  function resolveThinkingEffort(effectiveModel, proxy, overrideProviderId) {
    if (effectiveModel) {
      if (overrideProviderId) {
        const p = configStore.getProviderById(overrideProviderId);
        if (p) {
          const entry = (p.models || []).find(m => m.name === effectiveModel);
          if (entry && entry.thinkingEffort) return entry.thinkingEffort;
        }
      }
      if (proxy) {
        const provider = configStore.getProviderById(proxy.providerId);
        if (provider) {
          const entry = (provider.models || []).find(m => m.name === effectiveModel);
          if (entry && entry.thinkingEffort) return entry.thinkingEffort;
        }
        for (const poolItem of (proxy.providerPool || [])) {
          const p = configStore.getProviderById(poolItem.providerId);
          if (!p) continue;
          const entry = (p.models || []).find(m => m.name === effectiveModel);
          if (entry && entry.thinkingEffort) return entry.thinkingEffort;
        }
      }
    }
    return '';
  }

  function buildThinkingParams(thinkingEffort, protocol, adapter) {
    if (protocol !== 'openai' && protocol !== 'responses') return {};
    if (thinkingEffort === 'high' || thinkingEffort === 'max') {
      const params = { reasoning_effort: thinkingEffort };
      // thinking 参数仅 DeepSeek 支持
      if (adapter === 'deepseek') params.thinking = { type: 'enabled' };
      return params;
    }
    // DeepSeek 默认开启思考，需显式传 thinking.type=disabled 关闭
    if (adapter === 'deepseek') {
      return { thinking: { type: 'disabled' } };
    }
    return {};
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
    let fixedTokens = 0;
    if (typeof msg.content === 'string') chars += len(msg.content);
    else if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (typeof block === 'string') chars += len(block);
        else if (block?.text) chars += len(block.text);
        else if (block?.type === 'image_url' || block?.type === 'image' || block?.type === 'input_image') {
          fixedTokens += 1000; // 图片：按 ~800-1500 token 估算，取保守值
        } else if (block?.type === 'input_audio') {
          fixedTokens += 500; // 音频：粗略估算
        } else if (block?.content) chars += len(block.content);
      }
    }
    if (msg.reasoning_content) chars += len(msg.reasoning_content);
    if (msg.tool_calls) {
      for (const tc of msg.tool_calls) {
        chars += len(tc.function?.name || '') + len(tc.function?.arguments || '');
      }
    }
    // chars/2 对中文更保守（中文 ~1-2 token/字），宁可高估触发压缩也别低估撑爆上下文
    return Math.ceil(chars / 2) + 4 + fixedTokens;
  }

  function estimateConversationTokens(messages) {
    return messages.reduce((sum, m) => sum + estimateMessageTokens(m), 0);
  }

  // 规则提取：从消息中提取结构化骨架（无需 LLM）
  function extractStructuredSkeleton(oldMessages, existingSummary) {
    const userMsgs = oldMessages.filter(m => m.role === 'user').length;
    const assistantMsgs = oldMessages.filter(m => m.role === 'assistant').length;
    const toolMsgs = oldMessages.filter(m => m.role === 'tool').length;

    // 工具使用
    const toolNames = [...new Set(
      oldMessages.filter(m => m.tool_calls).flatMap(m => m.tool_calls.map(tc => tc.function?.name)).filter(Boolean)
    )];

    // 用户请求（最近 5 条，截断 300 字符）
    const userQuestions = oldMessages.filter(m => m.role === 'user')
      .map(m => typeof m.content === 'string' ? m.content.slice(0, 300) : '')
      .filter(Boolean).slice(-5);

    // 关键文件（从所有消息中提取路径模式）
    const filePathRegex = /[A-Za-z]:\\[^\s"'<>]+|\/[\w./-]+\.\w{1,6}|(?:[\w-]+\/){2,}[\w.-]+/g;
    const allText = oldMessages.map(m => {
      if (typeof m.content === 'string') return m.content;
      if (Array.isArray(m.content)) return m.content.map(b => b.text || b.content || '').join(' ');
      return '';
    }).join(' ');
    const keyFiles = [...new Set((allText.match(filePathRegex) || []))]
      .filter(f => /\.(js|ts|py|json|md|html|css|yaml|yml|toml|rs|go|java|sql|sh)$/i.test(f))
      .slice(0, 15);

    // 待办/未完成事项（关键词匹配）
    const pendingPatterns = /(?:todo|待办|未完成|下一步|接下来|pending|next|remaining|还需|需要修改|需要添加|待优化|还需检查)/i;
    const pendingItems = [];
    for (const m of oldMessages.filter(m => m.role === 'assistant' && m.content)) {
      const text = typeof m.content === 'string' ? m.content : '';
      const lines = text.split('\n').filter(line => pendingPatterns.test(line));
      for (const line of lines.slice(0, 3)) {
        const trimmed = line.trim().slice(0, 150);
        if (trimmed && !pendingItems.includes(trimmed)) pendingItems.push(trimmed);
      }
      if (pendingItems.length >= 8) break;
    }

    // 时间线（每条消息截断 160 字符）
    const timeline = oldMessages.slice(-15).map(m => {
      const role = m.role === 'tool' ? 'tool' : m.role;
      let text = '';
      if (typeof m.content === 'string') text = m.content.slice(0, 160);
      else if (Array.isArray(m.content)) text = m.content.map(b => b.text || '').join(' ').slice(0, 160);
      if (m.tool_calls) text = `[调用 ${m.tool_calls.map(tc => tc.function?.name).join(', ')}] ${text}`;
      return `- ${role}: ${text}`;
    });

    // 最近助手回复的关键内容
    const lastAssistant = oldMessages.filter(m => m.role === 'assistant' && m.content).pop();
    const currentWork = lastAssistant?.content
      ? (typeof lastAssistant.content === 'string' ? lastAssistant.content : '').slice(0, 300)
      : '';

    const sections = [];
    sections.push(`## 对话范围\n${oldMessages.length} 条消息 (user=${userMsgs}, assistant=${assistantMsgs}, tool=${toolMsgs})`);

    if (toolNames.length) sections.push(`## 使用的工具\n${toolNames.join(', ')}`);

    if (userQuestions.length) {
      sections.push(`## 用户请求\n${userQuestions.map((q, i) => `${i + 1}. ${q}`).join('\n')}`);
    }

    if (keyFiles.length) sections.push(`## 涉及文件\n${keyFiles.join('\n')}`);

    if (pendingItems.length) {
      sections.push(`## 待办/未完成\n${pendingItems.map(p => `- ${p}`).join('\n')}`);
    }

    if (currentWork) sections.push(`## 最近工作\n${currentWork}`);

    if (existingSummary) sections.push(`## 之前的摘要\n${existingSummary}`);

    sections.push(`## 时间线\n${timeline.join('\n')}`);

    return sections.join('\n\n');
  }

  // LLM 增强：在骨架基础上补充关键发现和未完成工作
  async function enhanceSummaryWithLLM(skeleton, proxyUrl, proxyHeaders, defaultModel) {
    try {
      const res = await fetch(proxyUrl, {
        method: 'POST',
        headers: proxyHeaders,
        signal: AbortSignal.timeout(45000),
        body: JSON.stringify({
          model: defaultModel || 'gpt-4o',
          messages: [
            { role: 'system', content: '你是一个对话摘要助手。基于提供的结构化信息，生成简洁的中文摘要。重点关注：1) 用户的核心目标 2) 已取得的关键进展 3) 未完成的工作。控制在 400 字以内。' },
            { role: 'user', content: `以下是对话的结构化信息：\n\n${skeleton}\n\n请基于以上信息生成精炼的对话摘要。` },
          ],
          max_tokens: 800,
          stream: false,
        }),
      });
      if (res.ok) {
        const data = await res.json();
        const content = data.choices?.[0]?.message?.content;
        if (content) return content;
      }
    } catch (err) {
      logger.log(`[compress] LLM 增强失败: ${err.message}`);
    }
    return null;
  }

  async function compressConversation(conv, maxContext, proxyUrl, proxyHeaders, defaultModel) {
    const messages = conv.messages;
    const PRESERVE_RECENT = 6;

    // 提取之前的压缩摘要
    const existingSummary = conv.compressionSummary || '';

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

    // 第一步：规则提取结构化骨架（必然成功）
    const skeleton = extractStructuredSkeleton(oldMessages, existingSummary);

    // 第二步：尝试用 LLM 增强
    let summary = await enhanceSummaryWithLLM(skeleton, proxyUrl, proxyHeaders, defaultModel);
    if (summary) {
      logger.log('[compress] LLM 增强摘要生成成功');
    } else {
      // LLM 失败 → 骨架即为最终摘要（比旧版启发式降级信息丰富得多）
      summary = skeleton;
      logger.log('[compress] 使用结构化骨架作为摘要');
    }

    // 重建消息数组（不含 system 消息，由 buildMessages() 负责注入）
    const newMessages = [...recentMessages];
    const newTokens = estimateConversationTokens(newMessages);
    return { messages: newMessages, summary, removedCount: oldMessages.length, newTokens };
  }

  // 检测是否为上下文窗口溢出错误
  function isContextWindowError(status, body) {
    if (status === 400 || status === 413 || status === 422) {
      const markers = ['maximum context length', 'too many tokens', 'prompt is too long',
        'input tokens exceed', 'context_length_exceeded', 'context window', 'max_tokens',
        '请求体过大', '上下文长度', 'token 数量超过'];
      return markers.some(m => body.toLowerCase().includes(m));
    }
    return false;
  }

  // ==================== 助手工具定义与执行器 ====================

  const MAX_TOOL_OUTPUT = 16384; // 16KB — 防止工具输出撑爆 LLM 上下文

  // ---------- 对话文件存储（供 Code Interpreter 使用） ----------
  const CONV_FILES_DIR = path.join(os.tmpdir(), 'pp-conv-files');

  function getConvFilesPath(convId) {
    return path.join(CONV_FILES_DIR, convId);
  }

  // 文件所有权映射：convId → { msgId → [filename] }
  const convFileOwnership = new Map();

  function saveConvFiles(convId, messageContent, msgId) {
    if (!Array.isArray(messageContent)) return;
    const dir = getConvFilesPath(convId);
    let saved = false;
    const ownedFiles = [];
    for (const part of messageContent) {
      try {
        // 从前端 __FILE_DATA__ 标记中提取文件并保存到磁盘
        if (part.type === 'text' && part.text?.startsWith('__FILE_DATA__')) {
          const match = part.text.match(/^__FILE_DATA__(.+?)\|(.+?)\|(.+)__END_FILE_DATA__$/s);
          if (match) {
            if (!saved) { fs.mkdirSync(dir, { recursive: true }); saved = true; }
            fs.writeFileSync(path.join(dir, match[1]), Buffer.from(match[3], 'base64'));
            ownedFiles.push(match[1]);
            logger.log(`[conv-files] 保存文件: ${match[1]}`);
          }
        }
        // 图片也保存一份供 Code Interpreter 使用
        if (part.type === 'image_url' && part.image_url?.url?.startsWith('data:')) {
          const match = part.image_url.url.match(/^data:([^;]+);base64,(.+)$/);
          if (match) {
            if (!saved) { fs.mkdirSync(dir, { recursive: true }); saved = true; }
            const ext = match[1].split('/')[1] || 'png';
            const name = `image_${Date.now()}.${ext}`;
            fs.writeFileSync(path.join(dir, name), Buffer.from(match[2], 'base64'));
            ownedFiles.push(name);
          }
        }
        // 文本附件也保存
        if (part.type === 'text' && part.text?.startsWith('📄')) {
          const lines = part.text.split('\n');
          const nameMatch = lines[0].match(/📄\s*(.+?)[:：]/);
          if (nameMatch) {
            if (!saved) { fs.mkdirSync(dir, { recursive: true }); saved = true; }
            fs.writeFileSync(path.join(dir, nameMatch[1]), lines.slice(1).join('\n'), 'utf8');
            ownedFiles.push(nameMatch[1]);
          }
        }
      } catch {}
    }
    // 记录文件所有权
    if (msgId && ownedFiles.length > 0) {
      if (!convFileOwnership.has(convId)) convFileOwnership.set(convId, {});
      convFileOwnership.get(convId)[msgId] = ownedFiles;
    }
    // 从消息中移除 __FILE_DATA__ 标记（不发给 LLM）
    if (saved) {
      for (let i = messageContent.length - 1; i >= 0; i--) {
        if (messageContent[i].type === 'text' && messageContent[i].text?.startsWith('__FILE_DATA__')) {
          messageContent.splice(i, 1);
        }
      }
    }
  }

  function cleanupConvFiles(convId) {
    try { fs.rmSync(getConvFilesPath(convId), { recursive: true, force: true }); } catch {}
    convFileOwnership.delete(convId);
  }

  function deleteConvMsgFiles(convId, msgId) {
    const ownership = convFileOwnership.get(convId);
    if (!ownership || !ownership[msgId]) return;
    const dir = getConvFilesPath(convId);
    for (const fname of ownership[msgId]) {
      try { fs.unlinkSync(path.join(dir, fname)); } catch {}
    }
    delete ownership[msgId];
  }

  function loadConvFiles(convId) {
    const dir = getConvFilesPath(convId);
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir)
      .filter(f => fs.statSync(path.join(dir, f)).isFile())
      .map(f => ({ name: f, base64: fs.readFileSync(path.join(dir, f)).toString('base64') }));
  }

  // ==================== 多模态服务工具自动生成 ====================

  const MULTIMODAL_TEMPLATES = {
    image: {
      toolName: 'generate_image',
      description: '生成图片。根据文字描述生成图片。',
      paramName: 'prompt',
      paramDesc: '图片描述（英文效果更佳）',
      extraParams: { size: { type: 'string', description: '图片尺寸/比例，如 1024x1024、16:9、1:1', default: '1024x1024' } },
      buildRequest: (provider, args) => {
        const base = provider.url.replace(/\/$/, '');
        const key = provider.apiKeys?.[0]?.key || provider.apiKey || '';
        // MiniMax 图片生成
        if (provider.brand === 'minimax') {
          const ratioMap = { '1:1': '1:1', '16:9': '16:9', '4:3': '4:3', '3:2': '3:2', '2:3': '2:3', '3:4': '3:4', '9:16': '9:16', '21:9': '21:9' };
          const aspectRatio = ratioMap[args.size] || '1:1';
          return {
            url: base + (base.includes('/v1') ? '/image_generation' : '/v1/image_generation'),
            options: {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
              body: JSON.stringify({ model: provider.models?.[0]?.name || 'image-01', prompt: args.prompt, aspect_ratio: aspectRatio }),
            },
            parseResponse: async (res) => {
              const data = await res.json();
              const urls = data.data?.image_urls || data.image_urls || [];
              if (urls.length === 0) return { error: '图片生成失败: ' + (data.base_resp?.status_msg || JSON.stringify(data).slice(0, 200)) };
              // 下载第一张图片转 base64
              try {
                const imgRes = await fetch(urls[0]);
                const buf = await imgRes.arrayBuffer();
                const base64 = Buffer.from(buf).toString('base64');
                return { images: [{ name: 'generated.png', base64_data: base64 }] };
              } catch { return { url: urls[0], message: `图片已生成: ${urls[0]}` }; }
            },
          };
        }
        // OpenAI 兼容
        return {
          url: base + (base.includes('/v1') ? '/images/generations' : '/v1/images/generations'),
          options: {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
            body: JSON.stringify({ model: provider.models?.[0]?.name || 'dall-e-3', prompt: args.prompt, size: args.size || '1024x1024', n: 1 }),
          },
          parseResponse: async (res) => {
            const data = await res.json();
            const url = data.data?.[0]?.url;
            if (!url) return { error: '图片生成失败: 无返回数据' };
            if (url.startsWith('data:')) {
              const match = url.match(/^data:([^;]+);base64,(.+)$/);
              return match ? { images: [{ name: 'generated.png', base64_data: match[2] }] } : { url };
            }
            return { url, message: `图片已生成: ${url}` };
          },
        };
      },
    },
    video: {
      toolName: 'generate_video',
      description: '生成视频。根据文字描述生成短视频。可在 prompt 中用 [Push in] [Truck left] 等控制镜头。',
      paramName: 'prompt',
      paramDesc: '视频内容描述',
      extraParams: { duration: { type: 'number', description: '视频时长（秒），默认 6', default: 6 } },
      buildRequest: (provider, args) => {
        const base = provider.url.replace(/\/$/, '');
        const key = provider.apiKeys?.[0]?.key || provider.apiKey || '';
        // MiniMax 视频（异步：创建任务 → 轮询 → 下载）
        if (provider.brand === 'minimax') {
          return {
            url: base + (base.includes('/v1') ? '/video_generation' : '/v1/video_generation'),
            options: {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
              body: JSON.stringify({ model: provider.models?.[0]?.name || 'MiniMax-Hailuo-2.3', prompt: args.prompt, duration: String(args.duration || 6) }),
            },
            parseResponse: async (res, convId) => {
              const data = await res.json();
              const taskId = data.task_id;
              if (!taskId) return { error: '视频任务创建失败: ' + (data.base_resp?.status_msg || JSON.stringify(data).slice(0, 200)) };
              // 轮询等待完成
              const pollUrl = base + (base.includes('/v1') ? '/query/video_generation' : '/v1/query/video_generation');
              const maxWait = 600000, interval = 10000;
              const start = Date.now();
              while (Date.now() - start < maxWait) {
                await new Promise(r => setTimeout(r, interval));
                try {
                  const pollRes = await fetch(`${pollUrl}?task_id=${taskId}`, { headers: { 'Authorization': `Bearer ${key}` } });
                  const pollData = await pollRes.json();
                  const status = pollData.status;
                  if (status === 'Success') {
                    const fileId = pollData.file_id;
                    if (!fileId) return { task_id: taskId, message: '视频生成完成但无法获取文件ID' };
                    // 下载视频
                    const fileUrl = base + (base.includes('/v1') ? '/files/retrieve' : '/v1/files/retrieve');
                    const fileRes = await fetch(`${fileUrl}?file_id=${fileId}`, { headers: { 'Authorization': `Bearer ${key}` } });
                    const fileData = await fileRes.json();
                    const downloadUrl = fileData.file?.download_url || fileData.download_url;
                    if (downloadUrl && convId) {
                      const videoRes = await fetch(downloadUrl);
                      const buf = await videoRes.arrayBuffer();
                      const fname = `video_${Date.now()}.mp4`;
                      const dir = getConvFilesPath(convId);
                      fs.mkdirSync(dir, { recursive: true });
                      fs.writeFileSync(path.join(dir, fname), Buffer.from(buf));
                      return { video_file: fname, message: `视频已生成: ${fname}` };
                    }
                    return downloadUrl ? { video_url: downloadUrl, message: `视频已生成: ${downloadUrl}` } : { task_id: taskId, file_id: fileId, message: '视频已生成，请查看文件' };
                  }
                  if (status === 'Fail') return { error: '视频生成失败: ' + (pollData.status_msg || '未知错误') };
                } catch (pollErr) { logger.log(`[minimax-video] 轮询异常: ${pollErr.message}`); }
              }
              return { task_id: taskId, message: '视频生成超时（10分钟），请稍后用 task_id 查询' };
            },
          };
        }
        // 通用
        return {
          url: base + '/v1/video/generations',
          options: {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
            body: JSON.stringify({ model: provider.models?.[0]?.name || 'default', prompt: args.prompt, duration: args.duration || 5 }),
          },
          parseResponse: async (res) => {
            const data = await res.json();
            if (data.video_url || data.data?.[0]?.url) {
              return { video_url: data.video_url || data.data[0].url, message: '视频生成中，请稍候通过链接查看' };
            }
            if (data.id) return { task_id: data.id, message: '视频生成任务已提交，请通过 task_id 查询进度' };
            return { error: '视频生成失败: 无返回数据' };
          },
        };
      },
    },
    tts: {
      toolName: 'text_to_speech',
      description: '文字转语音。将文字转换为语音音频。',
      paramName: 'text',
      paramDesc: '要转换为语音的文字',
      extraParams: { voice: { type: 'string', description: '语音角色（OpenAI: alloy/echo/nova；MiMo: 冰糖/茉莉；MiniMax: male-qn-qingse/female-shaonv 等）', default: 'alloy' } },
      buildRequest: (provider, args) => {
        const key = provider.apiKeys?.[0]?.key || provider.apiKey || '';
        const model = provider.models?.[0]?.name || 'tts-1';
        const base = provider.url.replace(/\/$/, '');
        // MiniMax TTS: /v1/t2a_v2
        if (provider.brand === 'minimax') {
          return {
            url: base + (base.includes('/v1') ? '/t2a_v2' : '/v1/t2a_v2'),
            options: {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
              body: JSON.stringify({
                model: model || 'speech-2.8-hd',
                text: args.text,
                voice_setting: { voice_id: args.voice || 'male-qn-qingse', speed: 1.0, vol: 1.0, pitch: 0 },
              }),
            },
            parseResponse: async (res, convId) => {
              if (!res.ok) return { error: `MiniMax TTS 失败: HTTP ${res.status}` };
              const data = await res.json();
              const audioHex = data.data?.audio;
              if (!audioHex) return { error: 'MiniMax TTS 失败: ' + (data.base_resp?.status_msg || '无音频数据') };
              const audioBuf = Buffer.from(audioHex, 'hex');
              const fname = `tts_${Date.now()}.mp3`;
              if (convId) {
                const dir = getConvFilesPath(convId);
                fs.mkdirSync(dir, { recursive: true });
                fs.writeFileSync(path.join(dir, fname), audioBuf);
              }
              return { audio_file: fname, message: `语音已生成: ${fname}` };
            },
          };
        }
        // MiMo TTS: 使用 Chat Completions 格式
        if (provider.brand === 'mimo') {
          return {
            url: base + (base.includes('/v1') ? '/chat/completions' : '/v1/chat/completions'),
            options: {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'api-key': key },
              body: JSON.stringify({
                model,
                messages: [
                  { role: 'user', content: '' },
                  { role: 'assistant', content: args.text },
                ],
                audio: { format: 'wav', voice: args.voice || 'mimo_default' },
              }),
            },
            parseResponse: async (res, convId) => {
              if (!res.ok) return { error: `MiMo TTS 失败: HTTP ${res.status}` };
              const data = await res.json();
              const audioData = data.choices?.[0]?.message?.audio?.data;
              if (!audioData) return { error: 'MiMo TTS 失败: 无音频数据' };
              const fname = `tts_${Date.now()}.wav`;
              if (convId) {
                const dir = getConvFilesPath(convId);
                fs.mkdirSync(dir, { recursive: true });
                fs.writeFileSync(path.join(dir, fname), Buffer.from(audioData, 'base64'));
              }
              return { audio_file: fname, message: `语音已生成: ${fname}` };
            },
          };
        }
        // OpenAI 兼容 TTS
        return {
          url: base + (base.includes('/v1') ? '/audio/speech' : '/v1/audio/speech'),
          options: {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
            body: JSON.stringify({ model, input: args.text, voice: args.voice || 'alloy' }),
          },
          parseResponse: async (res, convId) => {
            if (!res.ok) return { error: `语音合成失败: HTTP ${res.status}` };
            const buffer = await res.arrayBuffer();
            const base64 = Buffer.from(buffer).toString('base64');
            const fname = `tts_${Date.now()}.mp3`;
            if (convId) {
              const dir = getConvFilesPath(convId);
              fs.mkdirSync(dir, { recursive: true });
              fs.writeFileSync(path.join(dir, fname), Buffer.from(base64, 'base64'));
            }
            return { audio_file: fname, message: `语音已生成: ${fname}` };
          },
        };
      },
    },
    music: {
      toolName: 'generate_music',
      description: '生成音乐。根据文字描述生成音乐。可用 lyrics 参数提供歌词，加 instrumental 参数生成纯音乐。',
      paramName: 'prompt',
      paramDesc: '音乐风格和内容描述（如 "Jazz piano, smooth, relaxing"）',
      extraParams: {
        lyrics: { type: 'string', description: '歌词（含结构标签如 [Verse] [Chorus]），不填则自动生成' },
        instrumental: { type: 'boolean', description: '是否纯音乐（无人声），默认 false' },
      },
      buildRequest: (provider, args) => {
        const base = provider.url.replace(/\/$/, '');
        const key = provider.apiKeys?.[0]?.key || provider.apiKey || '';
        // MiniMax 音乐
        if (provider.brand === 'minimax') {
          const body = {
            model: provider.models?.[0]?.name || 'music-2.5+',
            prompt: args.prompt || '',
          };
          if (args.instrumental) body.instrumental = true;
          else if (args.lyrics) body.lyrics = args.lyrics;
          else body.lyrics_optimizer = true;
          return {
            url: base + (base.includes('/v1') ? '/music_generation' : '/v1/music_generation'),
            options: {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
              body: JSON.stringify(body),
            },
            parseResponse: async (res, convId) => {
              if (!res.ok) return { error: `MiniMax 音乐生成失败: HTTP ${res.status}` };
              const data = await res.json();
              const audioHex = data.data?.audio;
              if (!audioHex) return { error: 'MiniMax 音乐生成失败: ' + (data.base_resp?.status_msg || '无音频数据') };
              const audioBuf = Buffer.from(audioHex, 'hex');
              const fname = `music_${Date.now()}.mp3`;
              if (convId) {
                const dir = getConvFilesPath(convId);
                fs.mkdirSync(dir, { recursive: true });
                fs.writeFileSync(path.join(dir, fname), audioBuf);
              }
              return { audio_file: fname, duration: data.data?.duration, message: `音乐已生成: ${fname}` };
            },
          };
        }
        // 通用
        return {
          url: base + '/v1/music/generations',
          options: {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
            body: JSON.stringify({ model: provider.models?.[0]?.name || 'default', prompt: args.prompt, duration: args.duration || 30 }),
          },
          parseResponse: async (res, convId) => {
            if (!res.ok) return { error: `音乐生成失败: HTTP ${res.status}` };
            const buffer = await res.arrayBuffer();
            const base64 = Buffer.from(buffer).toString('base64');
            const fname = `music_${Date.now()}.mp3`;
            if (convId) {
              const dir = getConvFilesPath(convId);
              fs.mkdirSync(dir, { recursive: true });
              fs.writeFileSync(path.join(dir, fname), Buffer.from(base64, 'base64'));
            }
            return { audio_file: fname, message: `音乐已生成: ${fname}` };
          },
        };
      },
    },
  };

  function getMultimodalTools() {
    const definitions = [];
    const handlers = {};
    const allServices = configStore.getMultimodalServices();
    for (const [serviceType, template] of Object.entries(MULTIMODAL_TEMPLATES)) {
      const services = allServices.filter(s => s.serviceType === serviceType && s.enabled !== false);
      if (services.length === 0) continue;
      // 按 brand 分组，每个品牌独立工具定义
      const brandGroups = {};
      for (const svc of services) {
        const brand = svc.brand || svc.name;
        if (!brandGroups[brand]) brandGroups[brand] = [];
        brandGroups[brand].push(svc);
      }
      const multiBrand = Object.keys(brandGroups).length > 1;
      for (const [brand, brandServices] of Object.entries(brandGroups)) {
        const brandCfg = (template.brandConfig && template.brandConfig[brand]) || {};
        let toolName = brandServices.length === 1 && brandServices[0].toolName
          ? brandServices[0].toolName : template.toolName;
        // 多品牌时加后缀避免工具名重复
        if (multiBrand && !brandCfg.toolName) {
          toolName = toolName + '_' + brand;
        }
        const availableModels = [];
        for (const svc of brandServices) {
          const models = (svc.models && svc.models.length > 0) ? svc.models : (svc.model ? [{ name: svc.model }] : []);
          for (const m of models) availableModels.push({ name: typeof m === 'string' ? m : m.name, service: svc.name });
        }
        const serviceNames = brandServices.map(s => s.name).join('/');
        const modelHint = availableModels.length > 0
          ? ` 可用模型: ${availableModels.map(m => m.name).join('、')}` : '';
        const description = brandCfg.description || template.description;
        const extraParams = { ...template.extraParams, ...(brandCfg.extraParams || {}) };
        const props = { [template.paramName]: { type: 'string', description: brandCfg.paramDesc || template.paramDesc } };
        if (availableModels.length > 0) {
          props.model = { type: 'string', description: `指定使用的模型名称。${modelHint}` };
        }
        for (const [k, v] of Object.entries(extraParams)) {
          props[k] = { type: v.type, description: v.description + (v.default !== undefined ? `（默认: ${v.default}）` : '') };
        }
        const required = [template.paramName];
        for (const [k, v] of Object.entries(extraParams)) {
          if (v.required) required.push(k);
        }
        definitions.push({
          type: 'function',
          function: {
            name: toolName,
            description: `${description} 服务: ${serviceNames}.${modelHint}`,
            parameters: { type: 'object', properties: props, required },
          },
        });
        handlers[toolName] = async (args) => {
          // 根据 args.model 选择对应的服务和模型
          let svc = brandServices[0];
          let modelName = args.model;
          if (modelName) {
            let found = false;
            for (const s of brandServices) {
              const models = (s.models && s.models.length > 0) ? s.models : (s.model ? [{ name: s.model }] : []);
              if (models.some(m => (typeof m === 'string' ? m : m.name) === modelName)) {
                svc = s;
                found = true;
                break;
              }
            }
            if (!found) {
              const available = brandServices.flatMap(s => {
                const ms = (s.models && s.models.length > 0) ? s.models : (s.model ? [{ name: s.model }] : []);
                return ms.map(m => (typeof m === 'string' ? m : m.name));
              });
              return { error: `模型 "${modelName}" 不可用。可用模型: ${available.join('、') || '无'}` };
            }
          }
          const svcModels = (svc.models && svc.models.length > 0) ? svc.models : (svc.model ? [{ name: svc.model }] : []);
          if (!modelName && svcModels.length > 0) modelName = (typeof svcModels[0] === 'string' ? svcModels[0] : svcModels[0].name);
          const provider = { url: svc.url, apiKey: svc.apiKey, apiKeys: svc.apiKey ? [{ key: svc.apiKey }] : [], models: svcModels.map(m => typeof m === 'string' ? { name: m } : m), brand: svc.brand };
          if (modelName) provider._selectedModel = modelName;
          const { url, options, parseResponse } = template.buildRequest(provider, args);
          // 替换 body 中的 model 为用户指定的模型
          if (modelName && options.body) {
            try {
              const bodyObj = JSON.parse(options.body);
              if (bodyObj.model) { bodyObj.model = modelName; options.body = JSON.stringify(bodyObj); }
            } catch {}
          }
          try {
            const signals = [AbortSignal.timeout(120000)];
            if (args._abortSignal) signals.push(args._abortSignal);
            const res = await fetch(url, { ...options, signal: signals.length > 1 ? AbortSignal.any(signals) : signals[0] });
            return await parseResponse(res, args._convId);
          } catch (err) {
            return { error: `${toolName} 失败: ${err.message}` };
          }
      };
      }
    }
    return { definitions, handlers };
  }

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
        description: '获取最近的请求日志，支持按代理、状态、模型过滤。',
        parameters: {
          type: 'object',
          properties: {
            limit: { type: 'number', description: '返回条数，默认 20，最大 100' },
            proxyId: { type: 'string', description: '按代理 ID 精确筛选' },
            status: { type: 'string', enum: ['success', 'failure', '429'], description: '按请求状态筛选' },
            model: { type: 'string', description: '按模型名模糊匹配' },
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
        name: 'execute_code',
        description: '在沙箱中执行 Python 或 JavaScript 代码。用于数据分析、文件处理、画图表等。图表应保存为 PNG 文件（如 plt.savefig("output.png")），会自动返回生成的图片。用户上传的文件可通过 files 参数传入。',
        parameters: {
          type: 'object',
          properties: {
            code: { type: 'string', description: '要执行的代码' },
            language: { type: 'string', enum: ['python', 'javascript'], description: '代码语言，默认 python' },
            files: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, base64: { type: 'string' } } }, description: '临时文件列表，代码中可直接用文件名引用' },
          },
          required: ['code'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'parse_document',
        description: '解析文档文件（PDF/DOCX/PPTX/XLSX），提取文本内容和内嵌媒体（图片、视频、音频）。比 execute_code 更快，无需编写代码。返回文本和图片，视频/音频保存到工作目录。',
        parameters: {
          type: 'object',
          properties: {
            filename: { type: 'string', description: '对话中已上传的文件名（如 document.docx）' },
          },
          required: ['filename'],
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
            protocol: { type: 'string', enum: ['openai', 'anthropic', 'gemini', 'responses'], description: '协议类型，默认自动检测' },
            enabled: { type: 'boolean', description: '是否启用，默认 true' },
            apiKey: { type: 'string', description: 'API Key（单个）' },
            apiKeys: { type: 'array', items: { type: 'object', properties: { key: { type: 'string' }, alias: { type: 'string' } } }, description: '多个 API Key 数组' },
            models: { type: 'array', items: { type: 'string' }, description: '可用模型列表' },
            adapter: { type: 'string', enum: ['qwen', 'deepseek', 'kimi', 'doubao', 'zhipu', 'minimax', 'mimo'], description: '供应商适配器，用于国内模型特殊处理' },
            capabilities: { type: 'array', items: { type: 'string' }, description: '供应商能力标签，如 vision、tools、json 等' },
            azureDeployment: { type: 'string', description: 'Azure OpenAI 部署名称' },
            azureApiVersion: { type: 'string', description: 'Azure OpenAI API 版本' },
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
            protocol: { type: 'string', enum: ['openai', 'anthropic', 'gemini', 'responses'], description: '新的协议' },
            enabled: { type: 'boolean', description: '是否启用' },
            apiKey: { type: 'string', description: '新的 API Key' },
            models: { type: 'array', items: { type: 'string' }, description: '新的模型列表' },
            adapter: { type: 'string', enum: ['qwen', 'deepseek', 'kimi', 'doubao', 'zhipu', 'minimax', 'mimo'], description: '新的供应商适配器' },
            capabilities: { type: 'array', items: { type: 'string' }, description: '新的能力标签' },
            azureDeployment: { type: 'string', description: '新的 Azure 部署名称' },
            azureApiVersion: { type: 'string', description: '新的 Azure API 版本' },
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
            providerPool: { type: 'array', description: '多供应商池配置，用于加权/轮询/最快路由', items: { type: 'object', properties: { providerId: { type: 'string', description: '供应商 ID' }, model: { type: 'string', description: '模型名称' }, weight: { type: 'number', description: '权重，默认 1' } } } },
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
            providerPool: { type: 'array', description: '新的多供应商池配置', items: { type: 'object', properties: { providerId: { type: 'string' }, model: { type: 'string' }, weight: { type: 'number' } } } },
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
        description: '创建新技能。技能是预定义的指令模板，用户可通过 /技能名 触发，也可由模型根据触发条件自主调用。',
        parameters: {
          type: 'object',
          properties: {
            name: { type: 'string', description: '技能名称（英文、数字、下划线、连字符）' },
            description: { type: 'string', description: '技能描述' },
            trigger: { type: 'string', description: '触发条件，描述何时应调用此技能（如：用户询问系统健康状态时）' },
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
        description: '更新现有技能的描述、触发条件或指令内容。',
        parameters: {
          type: 'object',
          properties: {
            name: { type: 'string', description: '技能名称' },
            description: { type: 'string', description: '新的描述' },
            trigger: { type: 'string', description: '新的触发条件' },
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
        description: '回滚到指定的配置快照。支持通过快照文件名或版本ID回滚，包括已清理快照的版本重建。',
        parameters: {
          type: 'object',
          properties: {
            file: { type: 'string', description: '快照文件名（从 get_config_history 获取）' },
            versionId: { type: 'string', description: '版本ID（从 get_config_history 获取，用于重建已清理的快照）' },
          },
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'reconstruct_config',
        description: '通过回溯差异链重建指定的配置版本（即使快照已被清理）。用于恢复超出快照保留上限的历史版本。',
        parameters: {
          type: 'object',
          properties: {
            versionId: { type: 'string', description: '版本ID（从 get_config_history 获取）' },
          },
          required: ['versionId'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'get_config_diff',
        description: '比较两个配置版本之间的差异，返回新增、删除和修改的字段。支持通过文件名或版本ID比较。',
        parameters: {
          type: 'object',
          properties: {
            from: { type: 'string', description: '起始版本文件名（从 get_config_history 获取）' },
            to: { type: 'string', description: '目标版本文件名（从 get_config_history 获取）' },
            fromVersionId: { type: 'string', description: '起始版本ID（用于重建已清理的快照）' },
            toVersionId: { type: 'string', description: '目标版本ID（用于重建已清理的快照）' },
          },
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
    {
      type: 'function',
      function: {
        name: 'save_memory',
        description: '保存一条持久记忆。记忆会跨会话保留并注入到未来的对话中。tier=1 始终注入上下文（适合关键信息），tier=2 按需加载（适合细节信息，通过 read_memory 读取）。',
        parameters: {
          type: 'object',
          properties: {
            target: {
              type: 'string',
              enum: ['memory', 'user'],
              description: "记忆类型：'user' 存用户画像（姓名、角色、偏好等），'memory' 存经验笔记（环境事实、工具惯例等）",
            },
            content: {
              type: 'string',
              description: '记忆内容，应为简短的事实性陈述，例如"用户偏好简洁回答"',
            },
            summary: {
              type: 'string',
              description: '摘要，不超过50个字符，概括这条记忆的核心要点。二级记忆必填。',
            },
            tier: {
              type: 'number',
              enum: [1, 2],
              description: '记忆级别：1=始终注入上下文(默认)，2=按需加载（标题索引注入，详情需 read_memory 读取）',
            },
          },
          required: ['target', 'content', 'summary'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'get_memory',
        description: '查看当前已保存的所有记忆，包括经验笔记、用户画像和 Agent 人设。',
        parameters: { type: 'object', properties: {}, required: [] },
      },
    },
    {
      type: 'function',
      function: {
        name: 'edit_memory',
        description: '编辑或删除已有的记忆条目。通过 old_text 子串匹配要修改的条目。',
        parameters: {
          type: 'object',
          properties: {
            action: {
              type: 'string',
              enum: ['replace', 'remove'],
              description: "'replace' 更新条目内容，'remove' 删除条目",
            },
            target: {
              type: 'string',
              enum: ['memory', 'user'],
              description: '记忆类型',
            },
            old_text: {
              type: 'string',
              description: '要匹配的条目子串（用于定位目标条目）',
            },
            content: {
              type: 'string',
              description: "replace 时的新内容（remove 时不需要）",
            },
          },
          required: ['action', 'target', 'old_text'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'read_memory',
        description: '读取二级记忆条目的详情。当二级记忆索引中某条与当前话题相关时，使用此工具读取完整内容。',
        parameters: {
          type: 'object',
          properties: {
            target: {
              type: 'string',
              enum: ['memory', 'user'],
              description: "记忆类型：'memory' 或 'user'",
            },
            index: {
              type: 'number',
              description: '条目索引号（从二级记忆索引中获取）',
            },
          },
          required: ['target', 'index'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'search_memory',
        description: '按关键词搜索记忆条目（一级和二级记忆均搜索），返回匹配的内容片段。',
        parameters: {
          type: 'object',
          properties: {
            keyword: {
              type: 'string',
              description: '搜索关键词',
            },
            target: {
              type: 'string',
              enum: ['memory', 'user', 'all'],
              description: "搜索范围：'memory'=经验记忆，'user'=用户画像，'all'=全部（默认）",
            },
          },
          required: ['keyword'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'delegate_task',
        description: '将任务委派给子代理并行执行。子代理拥有独立的对话上下文和受限的工具集，完成后返回结果摘要。适合将大任务拆分为多个独立子任务并行处理。可用权限：full（完全访问）、readonly（只读分析）、writer（读写执行）。',
        parameters: {
          type: 'object',
          properties: {
            goals: {
              type: 'array',
              items: { type: 'string' },
              description: '子任务目标列表，每个元素是一个独立子任务的目标描述',
            },
            role: {
              type: 'string',
              enum: ['full', 'readonly', 'writer'],
              description: '所有子任务的默认权限（可选，默认 full）。readonly=只读分析，writer=读写执行，full=完全访问。',
            },
            goal_roles: {
              type: 'array',
              items: { type: 'string', enum: ['full', 'readonly', 'writer'] },
              description: '与 goals 一一对应的角色列表（可选）。长度需与 goals 一致，优先级高于 role 参数。',
            },
            model: {
              type: 'string',
              description: '子代理使用的模型（可选，默认与父代理相同）',
            },
            maxRounds: {
              type: 'number',
              description: '每个子代理的最大工具调用轮次（可选，默认5）',
            },
            agent: {
              type: 'string',
              description: '子代理身份名称（可选，slug 格式如 code-reviewer）。指定后子代理将获得该代理身份的系统提示词注入，并使用其默认权限。可通过 list_agents 查看可用代理列表。',
            },
          },
          required: ['goals'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'list_agents',
        description: '列出所有可用的代理身份。每个代理包含名称（slug）、描述、默认权限等信息。用于在 delegate_task 中选择合适的代理。',
        parameters: { type: 'object', properties: {} },
      },
    },
    {
      type: 'function',
      function: {
        name: 'list_tasks',
        description: '列出委派的子任务。可按状态筛选（created/running/completed/failed/stopped）。',
        parameters: {
          type: 'object',
          properties: {
            status: {
              type: 'string',
              enum: ['created', 'running', 'completed', 'failed', 'stopped'],
              description: '按状态筛选（可选，不传则返回全部）',
            },
          },
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'get_task',
        description: '获取单个子任务的详细信息，包括状态、结果摘要、耗时等。',
        parameters: {
          type: 'object',
          properties: {
            taskId: {
              type: 'string',
              description: '任务 ID',
            },
          },
          required: ['taskId'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'stop_task',
        description: '停止一个正在运行的子任务。',
        parameters: {
          type: 'object',
          properties: {
            taskId: {
              type: 'string',
              description: '要停止的任务 ID',
            },
          },
          required: ['taskId'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'message_task',
        description: '向已完成或失败的子任务追加消息，子代理从上次对话上下文继续执行。适合在子任务结果不完整时追加指令细化。',
        parameters: {
          type: 'object',
          properties: {
            taskId: {
              type: 'string',
              description: '目标任务 ID',
            },
            message: {
              type: 'string',
              description: '追加的消息内容',
            },
            maxRounds: {
              type: 'number',
              description: '最大工具调用轮次（可选）',
            },
          },
          required: ['taskId', 'message'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'update_soul',
        description: '更新智能体人设（SOUL.md），定义智能体的角色、性格和行为准则。',
        parameters: {
          type: 'object',
          properties: {
            content: {
              type: 'string',
              description: '人设内容（Markdown 格式）',
            },
          },
          required: ['content'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'get_exec_policy',
        description: '获取当前执行策略概览，包括默认规则和用户自定义规则的数量及详情。',
        parameters: { type: 'object', properties: {} },
      },
    },
    {
      type: 'function',
      function: {
        name: 'test_exec_policy',
        description: '测试某个 shell 命令在当前策略下的决策结果（allow/prompt/forbidden）。',
        parameters: {
          type: 'object',
          properties: {
            command: {
              type: 'string',
              description: '要测试的 shell 命令',
            },
          },
          required: ['command'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'list_conversations',
        description: '列出所有历史会话，包含消息数和最后活动时间。',
        parameters: { type: 'object', properties: {} },
      },
    },
    {
      type: 'function',
      function: {
        name: 'delete_conversation',
        description: '删除指定的会话，此操作不可恢复。',
        parameters: {
          type: 'object',
          properties: {
            conversationId: { type: 'string', description: '要删除的会话 ID' },
          },
          required: ['conversationId'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'clear_conversation',
        description: '清空指定会话的消息历史，保留会话本身。',
        parameters: {
          type: 'object',
          properties: {
            conversationId: { type: 'string', description: '要清空的会话 ID' },
          },
          required: ['conversationId'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'clear_all_conversations',
        description: '清空所有历史会话及关联文件，此操作不可恢复。',
        parameters: { type: 'object', properties: {} },
      },
    },
    {
      type: 'function',
      function: {
        name: 'get_autostart_status',
        description: '获取开机自启动状态，返回是否支持、是否已启用及注册命令。',
        parameters: { type: 'object', properties: {} },
      },
    },
    {
      type: 'function',
      function: {
        name: 'toggle_autostart',
        description: '设置或取消开机自启动。仅支持 Windows 系统。',
        parameters: {
          type: 'object',
          properties: {
            enabled: { type: 'boolean', description: 'true 开启，false 关闭' },
          },
          required: ['enabled'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'get_exec_policy_rules',
        description: '获取所有执行策略规则详情，包括默认规则和用户自定义规则。',
        parameters: { type: 'object', properties: {} },
      },
    },
    {
      type: 'function',
      function: {
        name: 'add_exec_policy_rule',
        description: '添加一条用户自定义执行策略规则。category 可选 allow（允许）、prompt（需确认）、forbidden（禁止）。',
        parameters: {
          type: 'object',
          properties: {
            category: { type: 'string', description: '规则类别: allow、prompt 或 forbidden' },
            pattern: { type: 'string', description: '命令匹配模式（支持通配符 *）' },
            description: { type: 'string', description: '规则说明（可选）' },
          },
          required: ['category', 'pattern'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'remove_exec_policy_rule',
        description: '删除一条用户自定义执行策略规则。',
        parameters: {
          type: 'object',
          properties: {
            category: { type: 'string', description: '规则类别: allow、prompt 或 forbidden' },
            pattern: { type: 'string', description: '要删除的规则匹配模式' },
          },
          required: ['category', 'pattern'],
        },
      },
    },
    // ==================== 客户端配置管理 ====================
    {
      type: 'function',
      function: {
        name: 'detect_client_config',
        description: '检测客户端工具（Claude Code / Codex）的安装状态和配置情况。',
        parameters: {
          type: 'object',
          properties: {
            tool: { type: 'string', enum: ['claude-code', 'codex'], description: '客户端工具名称' },
          },
          required: ['tool'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'preview_client_config',
        description: '预览客户端工具的配置内容（写入前查看）。',
        parameters: {
          type: 'object',
          properties: {
            tool: { type: 'string', enum: ['claude-code', 'codex'], description: '客户端工具名称' },
            proxyId: { type: 'string', description: '要关联的代理 ID' },
          },
          required: ['tool', 'proxyId'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'write_client_config',
        description: '将代理配置写入客户端工具的配置文件（写入前会自动备份）。',
        parameters: {
          type: 'object',
          properties: {
            tool: { type: 'string', enum: ['claude-code', 'codex'], description: '客户端工具名称' },
            proxyId: { type: 'string', description: '要关联的代理 ID' },
          },
          required: ['tool', 'proxyId'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'test_client_connection',
        description: '测试客户端工具通过代理的连接是否正常。',
        parameters: {
          type: 'object',
          properties: {
            proxyId: { type: 'string', description: '要测试的代理 ID' },
          },
          required: ['proxyId'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'list_client_backups',
        description: '列出客户端工具配置的历史备份。',
        parameters: {
          type: 'object',
          properties: {
            tool: { type: 'string', enum: ['claude-code', 'codex'], description: '客户端工具名称' },
          },
          required: ['tool'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'restore_client_backup',
        description: '从备份恢复客户端工具的配置文件。',
        parameters: {
          type: 'object',
          properties: {
            tool: { type: 'string', enum: ['claude-code', 'codex'], description: '客户端工具名称' },
            backupId: { type: 'string', description: '备份 ID（时间戳）' },
          },
          required: ['tool', 'backupId'],
        },
      },
    },
    // ==================== Agent 身份管理 ====================
    {
      type: 'function',
      function: {
        name: 'get_agent',
        description: '获取单个 Agent 身份的详细信息。',
        parameters: {
          type: 'object',
          properties: {
            slug: { type: 'string', description: 'Agent 的 slug 标识' },
          },
          required: ['slug'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'create_agent',
        description: '创建新的 Agent 身份。',
        parameters: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Agent 名称' },
            body: { type: 'string', description: 'Agent 的人设/指令内容（Markdown）' },
            description: { type: 'string', description: '简短描述' },
            color: { type: 'string', description: '显示颜色，如 #6B7280' },
            defaultRole: { type: 'string', description: '默认角色: writer / reviewer / assistant' },
          },
          required: ['name', 'body'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'update_agent',
        description: '更新已有 Agent 身份的配置。',
        parameters: {
          type: 'object',
          properties: {
            slug: { type: 'string', description: 'Agent 的 slug 标识' },
            name: { type: 'string', description: '新的名称' },
            body: { type: 'string', description: '新的人设/指令内容' },
            description: { type: 'string', description: '新的描述' },
            color: { type: 'string', description: '新的颜色' },
            defaultRole: { type: 'string', description: '新的默认角色' },
          },
          required: ['slug'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'delete_agent',
        description: '删除一个 Agent 身份（系统级 Agent 不可删除）。',
        parameters: {
          type: 'object',
          properties: {
            slug: { type: 'string', description: 'Agent 的 slug 标识' },
          },
          required: ['slug'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'reload_agents',
        description: '重新加载所有 Agent 身份定义（从磁盘读取）。',
        parameters: { type: 'object', properties: {} },
      },
    },
    // ==================== MCP 预设 ====================
    {
      type: 'function',
      function: {
        name: 'get_mcp_presets',
        description: '获取可用的 MCP 服务器预设列表，包含是否已添加的状态。',
        parameters: { type: 'object', properties: {} },
      },
    },

    // ==================== 多模态服务管理 ====================
    {
      type: 'function',
      function: {
        name: 'list_multimodal_services',
        description: '获取所有多模态服务（图片生成、视频生成、语音合成、音乐生成）的配置列表。',
        parameters: { type: 'object', properties: {} },
      },
    },
    {
      type: 'function',
      function: {
        name: 'create_multimodal_service',
        description: '创建一个新的多模态服务。',
        parameters: {
          type: 'object',
          properties: {
            name: { type: 'string', description: '服务名称' },
            serviceType: { type: 'string', enum: ['image', 'video', 'tts', 'music'], description: '服务类型' },
            brand: { type: 'string', enum: ['openai', 'mimo', 'minimax', 'custom'], description: '服务商' },
            url: { type: 'string', description: 'API 地址' },
            apiKey: { type: 'string', description: 'API Key（custom 类型可不填）' },
            models: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' } } }, description: '模型列表' },
            enabled: { type: 'boolean', description: '是否启用，默认 true' },
          },
          required: ['name', 'serviceType', 'brand', 'url'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'update_multimodal_service',
        description: '更新多模态服务配置。',
        parameters: {
          type: 'object',
          properties: {
            serviceId: { type: 'string', description: '服务 ID' },
            name: { type: 'string', description: '新的名称' },
            serviceType: { type: 'string', enum: ['image', 'video', 'tts', 'music'], description: '新的服务类型' },
            brand: { type: 'string', enum: ['openai', 'mimo', 'minimax', 'custom'], description: '新的服务商' },
            url: { type: 'string', description: '新的 API 地址' },
            apiKey: { type: 'string', description: '新的 API Key' },
            models: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' } } }, description: '新的模型列表' },
            enabled: { type: 'boolean', description: '是否启用' },
          },
          required: ['serviceId'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'delete_multimodal_service',
        description: '删除一个已配置的多模态服务。',
        parameters: {
          type: 'object',
          properties: {
            serviceId: { type: 'string', description: '服务 ID' },
          },
          required: ['serviceId'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'access_file',
        description: '读取本地文件。图片/音频/视频会以多模态内容注入对话，模型可直接"看/听/读"。支持绝对路径、相对路径、文件名（会在会话目录中查找）。如果模型不支持某种格式，API 会返回错误，届时可用 execute_code 等替代方案分析。',
        parameters: {
          type: 'object',
          properties: {
            file_path: { type: 'string', description: '文件路径或文件名' },
            question: { type: 'string', description: '可选。对该文件的具体问题或分析要求' },
          },
          required: ['file_path'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'audio_analyze',
        description: '分析或转写音频文件（返回文字信息）。支持 mp3/wav/m4a/ogg/flac 格式。如果需要模型直接"听"音频内容，请使用 access_file 工具加载音频。',
        parameters: {
          type: 'object',
          properties: {
            file_path: { type: 'string', description: '音频文件路径或文件名' },
            task: { type: 'string', enum: ['transcribe', 'analyze'], description: '任务类型', default: 'transcribe' },
          },
          required: ['file_path'],
        },
      },
    },
  ];

  // ==================== 工具权限分级 ====================
  // 1: 只读（查询+文件读取）  2: 配置写入  3: 危险操作（需确认）  4: 完全放开
  const TOOL_PERMISSION = {
    // 1: 只读
    get_system_status: 1, get_providers: 1, get_provider: 1, get_proxies: 1, get_proxy: 1,
    get_usage_stats: 1, get_recent_requests: 1, get_system_logs: 1, get_key_health: 1,
    get_settings: 1, get_config_history: 1, read_file: 1, list_directory: 1,
    search_files: 1, grep_search: 1, get_mcp_servers: 1, get_mcp_tools: 1,
    access_file: 1, audio_analyze: 1,
    get_skills: 1, export_config: 1, check_health: 1, invoke_skill: 1,
    test_provider_keys: 1, get_provider_models: 1,
    // 2: 配置写入
    create_provider: 2, update_provider: 2, delete_provider: 2,
    create_proxy: 2, update_proxy: 2, delete_proxy: 2,
    start_proxy: 2, stop_proxy: 2, start_all_proxies: 2, stop_all_proxies: 2,
    add_mcp_server: 2, update_mcp_server: 2, delete_mcp_server: 2,
    connect_mcp_server: 2, disconnect_mcp_server: 2,
    create_skill: 2, update_skill: 2, delete_skill: 2,
    import_config: 2, rollback_config: 2, reconstruct_config: 2, get_config_diff: 1, update_settings: 2, trigger_key_health_check: 2,
    // 1-2: 记忆系统
    get_memory: 1, save_memory: 2, edit_memory: 2, read_memory: 1, search_memory: 1,
    // 1-2: 会话管理
    list_conversations: 1, delete_conversation: 2, clear_conversation: 2, clear_all_conversations: 3,
    // 2: 委派任务
    delegate_task: 2, stop_task: 2, message_task: 2, update_soul: 2,
    get_exec_policy: 1, test_exec_policy: 1,
    get_autostart_status: 1, toggle_autostart: 2,
    get_exec_policy_rules: 1, add_exec_policy_rule: 2, remove_exec_policy_rule: 2,
    // 1: 任务查询 / 代理查询
    list_tasks: 1, get_task: 1, list_agents: 1, get_agent: 1,
    // 1-2: 客户端配置
    detect_client_config: 1, preview_client_config: 1, list_client_backups: 1,
    write_client_config: 2, restore_client_backup: 2, test_client_connection: 1,
    // 2: Agent 管理
    create_agent: 2, update_agent: 2, delete_agent: 2, reload_agents: 2,
    // 1: MCP 预设
    get_mcp_presets: 1,
    // 1-2: 多模态服务管理
    list_multimodal_services: 1, create_multimodal_service: 2, update_multimodal_service: 2, delete_multimodal_service: 2,
    // 3: 危险操作（需确认）
    execute_command: 3, execute_code: 3, write_file: 3, edit_file: 3,
    parse_document: 1,
    // 1: 多模态内容生成
    generate_image: 1, generate_video: 1, text_to_speech: 1, generate_music: 1,
  };

  // 工具审批等待机制
  const pendingApprovals = new Map();
  const TOOL_APPROVAL_TIMEOUT_MS = 60000;

  function requestToolApproval(id, name, args) {
    return new Promise((resolve) => {
      pendingApprovals.set(id, { resolve, name, arguments: args, timestamp: Date.now() });
      setTimeout(() => {
        if (pendingApprovals.has(id)) {
          pendingApprovals.get(id).resolve(false);
          pendingApprovals.delete(id);
        }
      }, TOOL_APPROVAL_TIMEOUT_MS);
    });
  }

  // 多 Agent 委派共享的代理上下文（chat handler 中更新，delegate_task handler 中读取）
  const _chatProxy = { url: null, headers: null, defaultModel: null, safeSSE: null, currentBatchId: null };

  // 工具处理器：所有 handler 签名为 async (args) => {...}
  // 约定：args._abortSignal（AbortSignal | undefined）由 chat handler 在调用前注入，
  // 用于 execute_code / execute_command 等子进程工具在客户端断开时终止子进程。
  // 其他工具可忽略此字段。
  function resolveFilePath(file_path, convId) {
    const candidates = [
      path.resolve(file_path),
      convId ? path.join(getConvFilesPath(convId), file_path) : null,
      path.join(process.cwd(), file_path),
    ].filter(Boolean);
    for (const p of candidates) {
      if (fs.existsSync(p)) return p;
    }
    return null;
  }

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
        return { id: p.id, name: p.name, url: p.url, protocol: p.protocol, enabled: p.enabled !== false, keyCount: (p.apiKeys || []).length, health: healthStatus };
      });
    },

    get_provider: async (args) => {
      const p = configStore.getProviderById(args.providerId);
      if (!p) return { error: `供应商 ${args.providerId} 不存在` };
      const h = keyHealth.get(p.id);
      return { id: p.id, name: p.name, url: p.url, protocol: p.protocol, enabled: p.enabled !== false, apiKeys: (p.apiKeys || []).map((k, i) => ({ index: i, alias: k.alias || '', enabled: k.enabled !== false })), health: h || null };
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
      return { entries: requestLog.getFiltered(args) };
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
        const child = exec(args.command, { cwd: args.cwd || process.cwd(), timeout, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
          if (err) {
            resolve({ exitCode: err.code || 1, stdout: stdout || '', stderr: stderr || err.message });
          } else {
            resolve({ exitCode: 0, stdout: stdout || '', stderr: stderr || '' });
          }
        });
        // 客户端断开时终止子进程（SIGTERM → 5s 后 SIGKILL 兜底）
        if (args._abortSignal) {
          const onAbort = () => {
            try { child.kill('SIGTERM'); } catch {}
            setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 5000);
          };
          args._abortSignal.addEventListener('abort', onAbort, { once: true });
        }
      });
    },

    execute_code: async (args) => {
      const { code, language = 'python', files = [] } = args;
      if (!code) return { error: '代码不能为空' };

      // 检测运行时可用性
      let cmd, cmdArgs;
      if (language === 'javascript') {
        cmd = 'node';
        cmdArgs = [];
      } else {
        // 尝试 python → python3
        const candidates = ['python', 'python3'];
        let found = false;
        for (const c of candidates) {
          try {
            const check = await new Promise((resolve) => {
              const p = spawn(c, ['--version'], { timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'] });
              let out = '';
              p.stdout.on('data', d => { out += d.toString(); });
              p.stderr.on('data', d => { out += d.toString(); });
              p.on('error', () => resolve(null));
              p.on('close', (code) => resolve(code === 0 ? c : null));
            });
            if (check) { cmd = check; found = true; break; }
          } catch {}
        }
        if (!found) {
          return { error: '未检测到 Python 环境。请安装 Python 或指定 language: "javascript" 使用 Node.js 执行。' };
        }
        cmdArgs = ['-u'];
      }

      const tmpDir = path.join(os.tmpdir(), 'pp-code-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8));
      try {
        fs.mkdirSync(tmpDir, { recursive: true });

        // 写入显式传入的临时文件
        for (const f of files) {
          if (f.name && f.base64) {
            fs.writeFileSync(path.join(tmpDir, f.name), Buffer.from(f.base64, 'base64'));
          }
        }

        // 自动注入对话中上传的文件
        if (args._convId) {
          const convFiles = loadConvFiles(args._convId);
          for (const f of convFiles) {
            if (!fs.existsSync(path.join(tmpDir, f.name))) {
              fs.writeFileSync(path.join(tmpDir, f.name), Buffer.from(f.base64, 'base64'));
            }
          }
          if (convFiles.length > 0) logger.log(`[execute_code] 注入 ${convFiles.length} 个对话文件`);
        }

        // 写入代码文件
        const ext = language === 'javascript' ? 'js' : 'py';
        const scriptName = `__run__.${ext}`;
        fs.writeFileSync(path.join(tmpDir, scriptName), code);
        cmdArgs.push(scriptName);

        // 执行代码
        const result = await new Promise((resolve) => {
          let stdout = '', stderr = '';
          const child = spawn(cmd, cmdArgs, {
            cwd: tmpDir,
            timeout: 60000,
            env: { ...process.env, MPLBACKEND: 'Agg', MPLCONFIGDIR: tmpDir },
            stdio: ['pipe', 'pipe', 'pipe'],
          });
          // 客户端断开时终止子进程（SIGTERM → 5s 后 SIGKILL 兜底）
          if (args._abortSignal) {
            const onAbort = () => {
              try { child.kill('SIGTERM'); } catch {}
              setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 5000);
            };
            args._abortSignal.addEventListener('abort', onAbort, { once: true });
          }
          child.stdout.on('data', d => { stdout += d.toString(); });
          child.stderr.on('data', d => { stderr += d.toString(); });
          child.on('error', (err) => {
            resolve({ exitCode: 1, stdout, stderr: stderr + '\n' + err.message });
          });
          child.on('close', (exitCode) => {
            resolve({ exitCode: exitCode || 0, stdout, stderr });
          });
        });

        // 扫描生成的图片
        const images = [];
        const IMAGE_EXTS = ['.png', '.jpg', '.jpeg', '.svg'];
        try {
          const files_ = fs.readdirSync(tmpDir);
          for (const fname of files_) {
            const ext_ = path.extname(fname).toLowerCase();
            if (IMAGE_EXTS.includes(ext_)) {
              const filePath = path.join(tmpDir, fname);
              const stat = fs.statSync(filePath);
              if (stat.size > 0 && stat.size < 5 * 1024 * 1024) {
                const data = fs.readFileSync(filePath);
                images.push({ name: fname, base64_data: data.toString('base64') });
              }
            }
          }
        } catch {}

        return { ...result, images: images.length > 0 ? images : undefined };
      } catch (err) {
        return { error: err.message };
      } finally {
        // 清理临时目录
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
      }
    },

    parse_document: async (args) => {
      const { filename } = args;
      if (!filename) return { error: '请指定文件名' };

      const convFilesDir = args._convId ? getConvFilesPath(args._convId) : null;
      const filePath = convFilesDir ? path.join(convFilesDir, filename) : null;
      if (!filePath || !fs.existsSync(filePath)) {
        return { error: `文件 ${filename} 不存在，请确认文件已上传` };
      }

      const ext = path.extname(filename).toLowerCase().slice(1);
      const SUPPORTED_IMG = new Set(['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp']);
      const UNSUPPORTED_IMG = new Set(['emf', 'wmf', 'tif', 'tiff', 'svg']);
      const VIDEO_EXTS = new Set(['mp4', 'mov', 'avi', 'wmv', 'webm']);
      const AUDIO_EXTS = new Set(['mp3', 'wav', 'm4a', 'ogg', 'aac']);

      try {
        // PDF 解析
        if (ext === 'pdf') {
          const pdfjsLib = require('pdfjs-dist');
          pdfjsLib.GlobalWorkerOptions.workerSrc = '';
          const data = new Uint8Array(fs.readFileSync(filePath));
          const pdf = await pdfjsLib.getDocument({ data }).promise;
          let text = '';
          for (let i = 1; i <= pdf.numPages; i++) {
            const page = await pdf.getPage(i);
            const content = await page.getTextContent();
            text += content.items.map(item => item.str).join(' ') + '\n\n';
          }
          return { text: text.trim(), images: [], media: [], pages: pdf.numPages };
        }

        // Office 文件解析（docx/pptx/xlsx）
        if (['docx', 'pptx', 'xlsx'].includes(ext)) {
          const JSZip = require('jszip');
          const zip = await JSZip.loadAsync(fs.readFileSync(filePath));
          const config = {
            docx: { textFiles: ['word/document.xml'], mediaDir: 'word/media/' },
            pptx: { textFiles: ['ppt/slides/slide*.xml'], mediaDir: 'ppt/media/' },
            xlsx: { textFiles: ['xl/sharedStrings.xml'], mediaDir: 'xl/media/' },
          }[ext];

          let text = '';
          const images = [];
          const media = [];
          const unsupported = [];

          // 提取媒体文件
          for (const [entryPath, zipEntry] of Object.entries(zip.files)) {
            if (!entryPath.startsWith(config.mediaDir) || zipEntry.dir) continue;
            const mediaExt = path.extname(entryPath).toLowerCase().slice(1);
            const name = path.basename(entryPath);
            const data = await zipEntry.async('base64');

            if (SUPPORTED_IMG.has(mediaExt)) {
              const mimeMap = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', bmp: 'image/bmp', webp: 'image/webp' };
              images.push({ name, base64_data: data, mime: mimeMap[mediaExt] || 'image/png' });
            } else if (VIDEO_EXTS.has(mediaExt) || AUDIO_EXTS.has(mediaExt)) {
              // 保存到对话文件目录
              if (convFilesDir) {
                fs.mkdirSync(convFilesDir, { recursive: true });
                fs.writeFileSync(path.join(convFilesDir, name), Buffer.from(data, 'base64'));
              }
              media.push({ name, type: VIDEO_EXTS.has(mediaExt) ? 'video' : 'audio' });
            } else if (UNSUPPORTED_IMG.has(mediaExt)) {
              unsupported.push({ name, format: mediaExt });
              // 也保存到磁盘，供 execute_code 转换
              if (convFilesDir) {
                fs.mkdirSync(convFilesDir, { recursive: true });
                fs.writeFileSync(path.join(convFilesDir, name), Buffer.from(data, 'base64'));
              }
            }
          }

          // 提取文本
          for (const pattern of config.textFiles) {
            const regex = pattern.includes('*') ? new RegExp('^' + pattern.replace('*', '[^/]+') + '$') : null;
            for (const [entryPath, zipEntry] of Object.entries(zip.files)) {
              const match = regex ? regex.test(entryPath) : entryPath === pattern;
              if (!match) continue;
              const xml = await zipEntry.async('text');
              const clean = xml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
              text += (ext === 'pptx' ? clean + '\n\n---\n\n' : clean.replace(/<\/w:p>/g, '\n').replace(/<\/w:tr>/g, '\n') + '\n');
            }
          }

          const result = { text: text.trim(), images, media };
          if (unsupported.length > 0) {
            result.unsupported = unsupported;
            result.hint = `发现 ${unsupported.length} 张不支持的图片格式（${unsupported.map(u => u.format).join(', ')}），已保存到工作目录，可通过 execute_code 使用 Python Pillow 转换为 PNG`;
          }
          return result;
        }

        return { error: `不支持的文件格式: ${ext}。支持 PDF、DOCX、PPTX、XLSX` };
      } catch (err) {
        return { error: `解析 ${filename} 失败: ${err.message}` };
      }
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
        enabled: args.enabled !== false,
        apiKey: args.apiKey || '',
        apiKeys: Array.isArray(args.apiKeys) ? args.apiKeys.filter(k => k && k.key && k.key.trim()) : [],
        models: args.models || [],
        adapter: args.adapter || '',
        capabilities: Array.isArray(args.capabilities) ? args.capabilities : [],
        azureDeployment: args.azureDeployment || '',
        azureApiVersion: args.azureApiVersion || '',
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
      if (args.enabled !== undefined) updates.enabled = args.enabled;
      if (args.apiKey !== undefined && args.apiKey !== '') updates.apiKey = args.apiKey;
      if (args.apiKeys !== undefined) {
        updates.apiKeys = Array.isArray(args.apiKeys) ? args.apiKeys.filter(k => k && k.key && k.key.trim()) : [];
      }
      if (args.models !== undefined) updates.models = args.models;
      if (args.adapter !== undefined) updates.adapter = args.adapter;
      if (args.capabilities !== undefined) updates.capabilities = Array.isArray(args.capabilities) ? args.capabilities : [];
      if (args.azureDeployment !== undefined) updates.azureDeployment = args.azureDeployment;
      if (args.azureApiVersion !== undefined) updates.azureApiVersion = args.azureApiVersion;
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
        if (protocol === 'responses') {
          return { url: hasV1Suffix ? `${base}/models` : `${base}/v1/models`, opts: { headers: { 'Authorization': `Bearer ${key}` } } };
        }
        if (protocol === 'anthropic') {
          const _fm = provider.models?.[0]; const testModel = (typeof _fm === 'string' ? _fm : _fm?.name) || 'claude-3-haiku-20240307';
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
      if (protocol === 'openai' || protocol === 'responses') {
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
      if (args.providerPool !== undefined) updates.providerPool = normalizeProviderPoolInput(args.providerPool);
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
      const skill = skillStore.create(args.name, args.description || '', args.content, args.trigger || '');
      if (!skill) return { error: '技能已存在' };
      return { success: true, name: skill.name };
    },

    update_skill: async (args) => {
      const skill = skillStore.update(args.name, args.description || '', args.content || '', args.trigger || '');
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
      const result = configStore.restoreSnapshot(args.file, args.versionId);
      if (result.error) return { error: result.error };
      return { success: true, reconstructed: !!result.reconstructed };
    },
    reconstruct_config: async (args) => {
      if (!args.versionId) return { error: '需要指定版本ID' };
      const result = configStore.reconstructVersion(args.versionId);
      if (result.error) return { error: result.error };
      return { config: result.config, reconstructed: true };
    },
    get_config_diff: async (args) => {
      // 支持通过 versionId 比较（自动重建缺失的快照）
      if (args.fromVersionId && args.toVersionId) {
        const fromResult = configStore.reconstructVersion(args.fromVersionId);
        if (fromResult.error) return { error: fromResult.error };
        const toResult = configStore.reconstructVersion(args.toVersionId);
        if (toResult.error) return { error: toResult.error };
        return configStore.diffObjects(fromResult.config, toResult.config, '');
      }
      if (!args.from || !args.to) return { error: '需要指定 from/to 文件名或 fromVersionId/toVersionId' };
      const result = configStore.getVersionDiff(args.from, args.to);
      if (result.error) return { error: result.error };
      return result;
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

    // ==================== 记忆系统 ====================
    save_memory: async (args) => {
      const target = args.target || 'memory';
      const tier = args.tier || 2;
      if (tier === 1) {
        // Append to tier 1 markdown file
        const existing = memoryManager.store.loadTier1(target);
        const sep = existing && !existing.endsWith('\n') ? '\n' : '';
        const newContent = existing + sep + args.content.trim();
        return memoryManager.store.saveTier1(target, newContent);
      }
      return memoryManager.store.addTier2(target, args.content, args.summary);
    },

    get_memory: async () => {
      return {
        tier1: {
          memory: memoryManager.store.loadTier1('memory') || '(未设置)',
          user: memoryManager.store.loadTier1('user') || '(未设置)',
        },
        tier2: {
          memory: memoryManager.store.getTier2Entries('memory'),
          user: memoryManager.store.getTier2Entries('user'),
        },
        soul: memoryManager.store.loadSoul() || '(未设置)',
      };
    },

    read_memory: async (args) => {
      return memoryManager.readMemory(args.target, args.index);
    },

    search_memory: async (args) => {
      const keyword = (args.keyword || '').trim().toLowerCase();
      if (!keyword) return { error: '请提供搜索关键词' };
      const targets = args.target === 'all' || !args.target ? ['memory', 'user'] : [args.target];
      const results = [];
      for (const t of targets) {
        const tier1 = memoryManager.store.loadTier1(t) || '';
        if (tier1.toLowerCase().includes(keyword)) {
          results.push({ target: t, tier: 1, content: tier1.slice(0, 500) });
        }
        const entries = memoryManager.store.getTier2Entries(t) || [];
        for (let i = 0; i < entries.length; i++) {
          const e = entries[i];
          if ((e.summary && e.summary.toLowerCase().includes(keyword)) ||
              (e.content && e.content.toLowerCase().includes(keyword))) {
            results.push({ target: t, tier: 2, index: i, summary: e.summary, content: e.content });
          }
        }
      }
      return { keyword: args.keyword, matches: results.length, results };
    },

    edit_memory: async (args) => {
      if (args.action === 'replace') {
        return memoryManager.store.replaceTier2(args.target, args.old_text, args.content);
      }
      if (args.action === 'remove') {
        return memoryManager.store.removeTier2(args.target, args.old_text);
      }
      return { error: "action 必须是 'replace' 或 'remove'" };
    },

    // ==================== 多 Agent 委派 ====================
    delegate_task: async (args) => {
      if (!_chatProxy.url) {
        return { error: '无可用代理，请先发送一条消息激活代理上下文' };
      }
      try {
        const { delegateTask, registry, getAgentConfig } = require('./lib/multi-agent');
        // 构建带角色和代理信息的 goals
        const goals = args.goals.map((g, i) => {
          const role = (args.goal_roles && args.goal_roles[i]) || args.role || undefined;
          const agent = args.agent || undefined;
          return (role || agent) ? { objective: g, role, agent } : g;
        });
        const agentConfig = getAgentConfig(configStore.getSettings());
        if (args.role) agentConfig.role = args.role;
        if (args.agent) agentConfig.agent = args.agent;
        // 子代理不提供 delegate_task，防止递归委派
        const _mmSub = getMultimodalTools();
        const result = await delegateTask({
          goals,
          registry,
          proxyUrl: _chatProxy.url,
          proxyHeaders: _chatProxy.headers,
          defaultModel: args.model || _chatProxy.defaultModel,
          toolDefinitions: (() => { const s = new Set(['delegate_task']); return [...TOOL_DEFINITIONS, ..._mmSub.definitions, ...mcpClient.getToolDefinitions()].filter(d => { const n = d.function?.name || d.name; if (s.has(n)) return false; s.add(n); return true; }); })(),
          toolHandlers: Object.fromEntries(Object.entries({ ...TOOL_HANDLERS, ..._mmSub.handlers }).filter(([k]) => k !== 'delegate_task')),
          systemPrompt: promptBuilder.buildSystemPrompt({ skillStore, mcpClient, memoryManager, agentStore, multimodalToolNames: _mmSub.definitions.map(d => d.function?.name || d.name) }),
          parentTaskId: null,
          maxRounds: args.maxRounds,
          sendSSE: _chatProxy.safeSSE,
          config: agentConfig,
          agentStore,
        });
        _chatProxy.currentBatchId = result.batchId || null;
        return result;
      } catch (err) {
        logger.error('[delegate_task] 子代理委派失败:', err.message);
        return { error: `子代理委派失败: ${err.message}` };
      }
    },

    list_agents: async () => {
      const agents = agentStore.list();
      return {
        count: agents.length,
        agents: agents.map(a => ({
          slug: a.slug,
          name: a.name,
          description: a.description,
          color: a.color,
          defaultRole: a.defaultRole,
          category: a.category,
          domain: a.domain,
        })),
      };
    },

    list_tasks: async (args) => {
      const { registry } = require('./lib/multi-agent');
      const tasks = registry.list(args.status);
      return {
        count: tasks.length,
        tasks: tasks.map(t => ({
          id: t.id,
          objective: t.objective,
          status: t.status,
          summary: t.summary || null,
          createdAt: t.createdAt,
          startedAt: t.startedAt,
          endedAt: t.endedAt,
        })),
      };
    },

    get_task: async (args) => {
      const { registry } = require('./lib/multi-agent');
      const task = registry.get(args.taskId);
      if (!task) return { error: `任务 ${args.taskId} 不存在` };
      return task;
    },

    stop_task: async (args) => {
      const { registry } = require('./lib/multi-agent');
      const task = registry.stop(args.taskId);
      if (!task) return { error: `任务 ${args.taskId} 不存在或未在运行` };
      return { success: true, task };
    },

    message_task: async (args) => {
      if (!_chatProxy.url) {
        return { error: '无可用代理，请先发送一条消息激活代理上下文' };
      }
      try {
        const { continueTask, registry, getAgentConfig } = require('./lib/multi-agent');
        // 子代理不提供 delegate_task，防止递归委派
        const _mmSub = getMultimodalTools();
        return await continueTask({
          taskId: args.taskId,
          message: args.message,
          registry,
          proxyUrl: _chatProxy.url,
          proxyHeaders: _chatProxy.headers,
          defaultModel: _chatProxy.defaultModel,
          toolDefinitions: (() => { const s = new Set(['delegate_task']); return [...TOOL_DEFINITIONS, ..._mmSub.definitions, ...mcpClient.getToolDefinitions()].filter(d => { const n = d.function?.name || d.name; if (s.has(n)) return false; s.add(n); return true; }); })(),
          toolHandlers: Object.fromEntries(Object.entries({ ...TOOL_HANDLERS, ..._mmSub.handlers }).filter(([k]) => k !== 'delegate_task')),
          systemPrompt: promptBuilder.buildSystemPrompt({ skillStore, mcpClient, memoryManager, agentStore, multimodalToolNames: _mmSub.definitions.map(d => d.function?.name || d.name) }),
          maxRounds: args.maxRounds,
          config: getAgentConfig(configStore.getSettings()),
        });
      } catch (err) {
        logger.error('[message_task] 续接子任务失败:', err.message);
        return { error: `续接子任务失败: ${err.message}` };
      }
    },

    update_soul: async (args) => {
      const soulPath = path.join(os.homedir(), '.protocol-proxy', 'SOUL.md');
      const content = (args.content || '').trim();
      const maxChars = memoryManager.soulMaxChars || 2000;
      if (content.length > maxChars) {
        return { error: `SOUL 内容超出限制 (${content.length}/${maxChars} 字符)` };
      }
      try {
        fs.writeFileSync(soulPath, content, 'utf8');
        memoryManager.store._soul = content;
        return { success: true };
      } catch (err) {
        return { error: err.message };
      }
    },

    get_exec_policy: async () => {
      const { execPolicy } = require('./lib/exec-policy');
      return execPolicy.getSummary();
    },

    test_exec_policy: async (args) => {
      const { execPolicy } = require('./lib/exec-policy');
      return execPolicy.check(args.command);
    },

    list_conversations: async () => {
      return { conversations: conversationStore.list() };
    },

    delete_conversation: async (args) => {
      const conv = conversationStore.get(args.conversationId);
      if (!conv) return { error: `会话 ${args.conversationId} 不存在` };
      conversationStore.remove(args.conversationId);
      cleanupConvFiles(args.conversationId);
      return { success: true, message: `会话 ${args.conversationId} 已删除` };
    },

    clear_conversation: async (args) => {
      const conv = conversationStore.get(args.conversationId);
      if (!conv) return { error: `会话 ${args.conversationId} 不存在` };
      conv.messages = [];
      conv.compressionSummary = undefined;
      conversationStore.touch(conv);
      cleanupConvFiles(args.conversationId);
      return { success: true, message: `会话 ${args.conversationId} 已清空` };
    },

    clear_all_conversations: async () => {
      const all = conversationStore.list();
      const count = all.length;
      for (const conv of all) {
        conversationStore.remove(conv.id);
        cleanupConvFiles(conv.id);
      }
      return { success: true, message: `已清空 ${count} 个会话` };
    },

    get_autostart_status: async () => {
      const autostart = require('./lib/autostart');
      return autostart.isEnabled();
    },

    toggle_autostart: async (args) => {
      const autostart = require('./lib/autostart');
      const result = args.enabled ? autostart.enable() : autostart.disable();
      if (!result.success) return { error: result.error };
      return result;
    },

    get_exec_policy_rules: async () => {
      const { execPolicy } = require('./lib/exec-policy');
      return execPolicy.getAllRules();
    },

    add_exec_policy_rule: async (args) => {
      const { execPolicy } = require('./lib/exec-policy');
      const { category, pattern, description } = args;
      if (!['allow', 'prompt', 'forbidden'].includes(category)) {
        return { error: 'category 必须是 allow、prompt 或 forbidden' };
      }
      const added = execPolicy.addRule(category, pattern, description);
      if (!added) return { error: '规则已存在' };
      return { success: true, message: `已添加 ${category} 规则: ${pattern}` };
    },

    remove_exec_policy_rule: async (args) => {
      const { execPolicy } = require('./lib/exec-policy');
      const { category, pattern } = args;
      const removed = execPolicy.removeRule(category, pattern);
      if (!removed) return { success: false, message: `未找到匹配规则: ${category}/${pattern}` };
      return { success: true, message: `已删除 ${category} 规则: ${pattern}` };
    },

    // ==================== 客户端配置管理 ====================
    detect_client_config: async (args) => {
      const proxies = configStore.getProxies();
      return await clientConfig.detectTool(args.tool, proxies);
    },

    preview_client_config: async (args) => {
      const proxy = configStore.getProxyById(args.proxyId);
      if (!proxy) return { ok: false, message: '代理不存在' };
      if (args.tool === 'claude-code') return clientConfig.previewClaudeCode(proxy);
      if (args.tool === 'codex') return clientConfig.previewCodex(proxy);
      return { ok: false, message: '未知工具' };
    },

    write_client_config: async (args) => {
      const proxy = configStore.getProxyById(args.proxyId);
      if (!proxy) return { ok: false, message: '代理不存在' };
      if (args.tool === 'claude-code') return clientConfig.writeClaudeCode(proxy);
      if (args.tool === 'codex') return clientConfig.writeCodex(proxy);
      return { ok: false, message: '未知工具' };
    },

    test_client_connection: async (args) => {
      const proxy = configStore.getProxyById(args.proxyId);
      if (!proxy) return { ok: false, message: '代理不存在' };
      if (!proxy.running) return { ok: false, message: '代理未运行' };
      return await clientConfig.testConnection(proxy);
    },

    list_client_backups: async (args) => {
      return { ok: true, backups: clientConfig.listBackups(args.tool) };
    },

    restore_client_backup: async (args) => {
      return clientConfig.restoreBackup(args.tool, args.backupId);
    },

    // ==================== Agent 身份管理 ====================
    get_agent: async (args) => {
      const agent = agentStore.get(args.slug);
      if (!agent) return { error: `Agent ${args.slug} 不存在` };
      return agent;
    },

    create_agent: async (args) => {
      const { name, body, description, color, defaultRole } = args;
      const agent = agentStore.create(name, description || '', body, color || '#6B7280', defaultRole || 'writer');
      if (!agent) return { error: 'Agent 已存在' };
      return agent;
    },

    update_agent: async (args) => {
      const { slug, ...updates } = args;
      const agent = agentStore.update(slug, updates);
      if (!agent) return { error: `Agent ${slug} 不存在或不可编辑` };
      return agent;
    },

    delete_agent: async (args) => {
      const agent = agentStore.get(args.slug);
      if (!agent) return { error: `Agent ${args.slug} 不存在` };
      if (agent.category === 'system') return { error: '系统级 Agent 不可删除' };
      if (!agentStore.remove(args.slug)) return { error: '删除失败' };
      return { success: true };
    },

    reload_agents: async () => {
      agentStore.init();
      return { success: true, count: agentStore.list().length };
    },

    // ==================== MCP 预设 ====================
    get_mcp_presets: async () => {
      const presets = configStore.getMcpPresets();
      const existing = configStore.getMcpServers();
      return presets.map(p => ({ ...p, added: !!existing[p.name] }));
    },

    // ==================== 多模态服务管理 ====================
    list_multimodal_services: async () => {
      const services = configStore.getMultimodalServices();
      return services.map(s => ({
        id: s.id, name: s.name, serviceType: s.serviceType, brand: s.brand,
        url: s.url, models: s.models || [], enabled: s.enabled !== false,
      }));
    },

    create_multimodal_service: async (args) => {
      const { name, serviceType, brand, url, apiKey, models, enabled } = args;
      if (!name || !serviceType || !brand || !url) return { error: 'name、serviceType、brand、url 必填' };
      const modelsList = Array.isArray(models) ? models : [];
      const service = configStore.addMultimodalService({
        name, serviceType, brand, url: url || '', apiKey: apiKey || '',
        models: modelsList, enabled: enabled !== false,
      });
      return { id: service.id, name: service.name, serviceType: service.serviceType, brand: service.brand, message: '多模态服务已创建' };
    },

    update_multimodal_service: async (args) => {
      const { serviceId } = args;
      if (!serviceId) return { error: 'serviceId 必填' };
      const existing = configStore.getMultimodalServiceById(serviceId);
      if (!existing) return { error: `服务 ${serviceId} 不存在` };
      const updates = {};
      for (const k of ['name', 'serviceType', 'brand', 'url', 'apiKey', 'enabled']) {
        if (args[k] !== undefined) updates[k] = args[k];
      }
      if (args.models !== undefined) updates.models = args.models;
      configStore.updateMultimodalService(serviceId, updates);
      return { id: serviceId, message: '多模态服务已更新' };
    },

    delete_multimodal_service: async (args) => {
      const { serviceId } = args;
      if (!serviceId) return { error: 'serviceId 必填' };
      const existing = configStore.getMultimodalServiceById(serviceId);
      if (!existing) return { error: `服务 ${serviceId} 不存在` };
      configStore.removeMultimodalService(serviceId);
      return { message: '多模态服务已删除' };
    },

    // ==================== 多模态文件访问 ====================
    access_file: async (args) => {
      const { file_path, question } = args;
      if (!file_path) return { error: 'file_path 必填' };

      // 路径解析：绝对路径 → conv-files 目录 → 当前工作目录
      const convId = args._convId;
      const resolved = resolveFilePath(file_path, convId);
      if (!resolved) return { error: `文件不存在: ${file_path}` };

      const stat = fs.statSync(resolved);
      const ext = path.extname(resolved).toLowerCase();
      const IMAGE_EXTS = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg'];
      const AUDIO_EXTS = ['.mp3', '.wav', '.m4a', '.ogg', '.flac', '.aac'];
      const VIDEO_EXTS = ['.mp4', '.webm', '.mov', '.avi', '.mkv'];
      const DOC_EXTS = ['.pdf', '.docx', '.pptx', '.xlsx'];

      // 图片
      if (IMAGE_EXTS.includes(ext)) {
        if (stat.size > 20 * 1024 * 1024) return { error: `图片过大 (${(stat.size / 1024 / 1024).toFixed(1)}MB)，限制 20MB` };
        const mimeMap = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp', '.svg': 'image/svg+xml' };
        const mime = mimeMap[ext] || 'image/png';
        const b64 = fs.readFileSync(resolved).toString('base64');
        const textPart = question ? { type: 'text', text: `用户要求: ${question}` } : { type: 'text', text: `已加载图片: ${path.basename(resolved)} (${(stat.size / 1024).toFixed(0)}KB)` };
        return { _multimodal: true, content: [textPart, { type: 'image_url', image_url: { url: `data:${mime};base64,${b64}` } }] };
      }

      // 音频
      if (AUDIO_EXTS.includes(ext)) {
        if (stat.size > 25 * 1024 * 1024) return { error: `音频过大 (${(stat.size / 1024 / 1024).toFixed(1)}MB)，限制 25MB` };
        const mimeMap = { '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.ogg': 'audio/ogg', '.flac': 'audio/flac', '.aac': 'audio/aac' };
        const mime = mimeMap[ext] || 'audio/mpeg';
        const format = ext.slice(1);
        const b64 = fs.readFileSync(resolved).toString('base64');
        const textPart = question ? { type: 'text', text: `用户要求: ${question}` } : { type: 'text', text: `已加载音频: ${path.basename(resolved)} (${(stat.size / 1024).toFixed(0)}KB)` };
        return { _multimodal: true, content: [textPart, { type: 'input_audio', input_audio: { data: b64, format } }] };
      }

      // 视频
      if (VIDEO_EXTS.includes(ext)) {
        if (stat.size > 50 * 1024 * 1024) return { error: `视频过大 (${(stat.size / 1024 / 1024).toFixed(1)}MB)，限制 50MB` };
        const b64 = fs.readFileSync(resolved).toString('base64');
        const textPart = question ? { type: 'text', text: `用户要求: ${question}` } : { type: 'text', text: `已加载视频: ${path.basename(resolved)} (${(stat.size / 1024 / 1024).toFixed(1)}MB)` };
        return { _multimodal: true, content: [textPart, { type: 'video_url', video_url: { url: `data:video/mp4;base64,${b64}` } }] };
      }

      // 文档
      if (DOC_EXTS.includes(ext)) {
        const result = await TOOL_HANDLERS.parse_document({ filename: path.basename(resolved), _convId: convId });
        return result;
      }

      // 文本/代码
      if (stat.size > 10 * 1024 * 1024) return { error: `文件过大 (${(stat.size / 1024 / 1024).toFixed(1)}MB)，限制 10MB` };
      const text = fs.readFileSync(resolved, 'utf8');
      const lineCount = text.split('\n').length;
      return { text, line_count: lineCount, file: path.basename(resolved), size: stat.size };
    },

    audio_analyze: async (args) => {
      const { file_path, task } = args;
      if (!file_path) return { error: 'file_path 必填' };

      const convId = args._convId;
      const resolved = resolveFilePath(file_path, convId);
      if (!resolved) return { error: `音频文件不存在: ${file_path}` };

      const stat = fs.statSync(resolved);
      const ext = path.extname(resolved).toLowerCase();
      const AUDIO_EXTS = ['.mp3', '.wav', '.m4a', '.ogg', '.flac', '.aac'];
      if (!AUDIO_EXTS.includes(ext)) return { error: `不支持的音频格式: ${ext}，支持: ${AUDIO_EXTS.join(', ')}` };

      // analyze 模式：返回元数据
      if (task === 'analyze') {
        return {
          file: path.basename(resolved),
          format: ext.slice(1),
          size_bytes: stat.size,
          size_human: `${(stat.size / 1024 / 1024).toFixed(1)} MB`,
          modified: stat.mtime.toISOString(),
          hint: '详细音频特征分析（BPM、音高、频谱等）需要通过 execute_code 使用 librosa 库',
        };
      }

      // transcribe 模式：尝试 ASR
      // 检查是否有可用的 ASR 服务（MiniMax 语音识别或 OpenAI Whisper）
      const allServices = configStore.getMultimodalServices();
      const asrServices = allServices.filter(s => s.serviceType === 'asr' && s.enabled !== false);

      if (asrServices.length === 0) {
        return {
          file: path.basename(resolved),
          format: ext.slice(1),
          size: `${(stat.size / 1024 / 1024).toFixed(1)} MB`,
          hint: '当前未配置 ASR（语音识别）服务。可通过多模态服务管理添加 MiniMax 或 OpenAI Whisper 服务来启用音频转写。也可通过 execute_code 使用 Python 进行本地转写。',
        };
      }

      // 使用第一个可用的 ASR 服务
      const svc = asrServices[0];
      try {
        const key = svc.apiKey || (svc.apiKeys && svc.apiKeys[0]?.key) || '';
        const base = (svc.url || '').replace(/\/$/, '');
        const audioBuffer = fs.readFileSync(resolved);
        const form = new FormData();
        form.append('file', new Blob([audioBuffer], { type: `audio/${ext.slice(1)}` }), path.basename(resolved));
        form.append('model', svc.model || 'whisper-1');
        form.append('language', 'zh');

        const res = await fetch(`${base}/v1/audio/transcriptions`, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${key}` },
          body: form,
          signal: AbortSignal.timeout(60000),
        });
        if (!res.ok) return { error: `ASR 请求失败: HTTP ${res.status}` };
        const data = await res.json();
        return { text: data.text || '', file: path.basename(resolved), provider: svc.name };
      } catch (err) {
        return { error: `ASR 转写失败: ${err.message}` };
      }
    },
  };

  // 多模态工具在请求时动态获取，不在此处静态合并

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
        if (protocol === 'openai' || protocol === 'responses') {
          if (isAzure) {
            const ver = provider.azureApiVersion || '2024-02-01';
            testUrl = `${base}/openai/deployments/${provider.azureDeployment}/models?api-version=${ver}`;
            fetchOpts = { headers: { 'api-key': k.key } };
          } else {
            testUrl = hasV1Suffix ? `${base}/models` : `${base}/v1/models`;
            fetchOpts = { headers: { 'Authorization': `Bearer ${k.key}` } };
          }
        } else if (protocol === 'anthropic') {
          const _fm = provider.models?.[0]; const testModel = (typeof _fm === 'string' ? _fm : _fm?.name) || 'claude-3-haiku-20240307';
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
    const { name, url, protocol, apiKey, apiKeys, models, azureDeployment, azureApiVersion, adapter, capabilities } = req.body;
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
      adapter: adapter || '',
      capabilities: Array.isArray(capabilities) ? capabilities : [],
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
    if (req.body.adapter !== undefined) updates.adapter = req.body.adapter || '';
    if (req.body.capabilities !== undefined) updates.capabilities = Array.isArray(req.body.capabilities) ? req.body.capabilities : [];

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
      if (protocol === 'openai' || protocol === 'responses') {
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
        const _fm = provider.models?.[0]; const testModel = req.body.model || (typeof _fm === 'string' ? _fm : _fm?.name) || 'claude-3-haiku-20240307';
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

    if (protocol !== 'openai' && protocol !== 'responses' && protocol !== 'anthropic' && protocol !== 'gemini') {
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
      if (protocol === 'responses') {
        return { url: hasV1Suffix ? `${base}/models` : `${base}/v1/models`, opts: { headers: { 'Authorization': `Bearer ${key}` } } };
      }
      if (protocol === 'anthropic') {
        const _fm = Array.isArray(models) ? models[0] : null; const testModel = (typeof _fm === 'string' ? _fm : _fm?.name) || 'claude-3-haiku-20240307';
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
        const latencyMs = Date.now() - started;
        if (!fetchRes.ok) {
          const hint = fetchRes.status === 401 || fetchRes.status === 403 ? 'API Key 无效或无权限' : `HTTP ${fetchRes.status}`;
          return { ok: false, alias: k.alias || '', message: hint, latencyMs };
        }
        return { ok: true, alias: k.alias || '', latencyMs };
      } catch (err) {
        return { ok: false, alias: k.alias || '', message: err.name === 'TimeoutError' ? '连接超时' : err.message };
      }
    }));

    const passed = results.filter(r => r.ok).length;
    res.json({ ok: passed === keys.length, passed, failed: keys.length - passed, results });
  });

  // ==================== 首次使用引导 ====================

  app.post('/api/onboarding/test-chat', async (req, res) => {
    const { url, protocol, apiKey, model } = req.body || {};
    if (!url || !protocol || !apiKey || !model) {
      return res.status(400).json({ ok: false, message: '缺少必要参数' });
    }
    const base = url.replace(/\/$/, '');
    const hasV1Suffix = base.endsWith('/v1');

    try {
      let fetchUrl, fetchOpts, body;
      if (protocol === 'openai' || protocol === 'responses') {
        fetchUrl = hasV1Suffix ? `${base}/chat/completions` : `${base}/v1/chat/completions`;
        body = JSON.stringify({ model, messages: [{ role: 'user', content: '你好，请简单回复一个问候。' }], max_tokens: 20 });
        fetchOpts = {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
          body,
          signal: AbortSignal.timeout(20000),
        };
      } else if (protocol === 'anthropic') {
        fetchUrl = hasV1Suffix ? `${base}/messages` : `${base}/v1/messages`;
        body = JSON.stringify({ model, max_tokens: 20, messages: [{ role: 'user', content: '你好，请简单回复一个问候。' }] });
        fetchOpts = {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
          body,
          signal: AbortSignal.timeout(20000),
        };
      } else if (protocol === 'gemini') {
        const geminiBase = /\/v1(alpha|beta)?$/.test(base) ? base.replace(/\/v1(alpha|beta)?$/, '') : base;
        fetchUrl = `${geminiBase}/v1beta/models/${model}:generateContent?key=${apiKey}`;
        body = JSON.stringify({ contents: [{ parts: [{ text: '你好，请简单回复一个问候。' }] }], generationConfig: { maxOutputTokens: 20 } });
        fetchOpts = {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body,
          signal: AbortSignal.timeout(20000),
        };
      } else {
        return res.json({ ok: false, message: `不支持的协议: ${protocol}` });
      }

      const started = Date.now();
      const fetchRes = await fetch(fetchUrl, fetchOpts);
      const latency = Date.now() - started;

      if (!fetchRes.ok) {
        const errText = await fetchRes.text().catch(() => '');
        const hint = fetchRes.status === 401 || fetchRes.status === 403
          ? 'API Key 无效或无权限'
          : `HTTP ${fetchRes.status}: ${errText.slice(0, 300) || '未知错误'}`;
        return res.json({ ok: false, message: hint });
      }

      const data = await fetchRes.json().catch(() => null);
      let responseText = '';
      if (protocol === 'openai' || protocol === 'responses') {
        responseText = data?.choices?.[0]?.message?.content || '';
      } else if (protocol === 'anthropic') {
        responseText = data?.content?.[0]?.text || '';
      } else if (protocol === 'gemini') {
        responseText = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
      }

      res.json({ ok: true, message: '模型连接正常', latency, response: responseText.trim() });
    } catch (err) {
      const msg = err.name === 'TimeoutError' ? '连接超时 (20s)' : `连接失败: ${err.message}`;
      res.json({ ok: false, message: msg });
    }
  });

  app.post('/api/onboarding/setup', async (req, res) => {
    const { url, protocol, apiKey, model } = req.body || {};
    if (!url || !protocol || !apiKey || !model) {
      return res.status(400).json({ ok: false, message: '缺少必要参数' });
    }

    try {
      // 从 URL 推断供应商名称
      let providerName = '默认供应商';
      try {
        const u = new URL(url);
        const host = u.hostname;
        if (host.includes('openai')) providerName = 'OpenAI';
        else if (host.includes('anthropic')) providerName = 'Anthropic';
        else if (host.includes('google') || host.includes('gemini')) providerName = 'Gemini';
        else if (host.includes('deepseek')) providerName = 'DeepSeek';
        else if (host.includes('qwen') || host.includes('aliyun') || host.includes('dashscope')) providerName = '通义千问';
        else if (host.includes('kimi') || host.includes('moonshot')) providerName = 'Kimi';
        else if (host.includes('doubao') || host.includes('volces')) providerName = '豆包';
        else if (host.includes('zhipu') || host.includes('bigmodel')) providerName = '智谱';
        else if (host.includes('minimax')) providerName = 'MiniMax';
        else if (host.includes('azure')) providerName = 'Azure OpenAI';
        else providerName = host.split('.').slice(-2, -1)[0] || host;
      } catch { /* ignore */ }

      // 创建供应商
      const provider = configStore.addProvider({
        name: providerName,
        url,
        protocol,
        apiKey,
        apiKeys: [{ key: apiKey, alias: '默认' }],
        models: [model],
      });

      // 找一个可用端口
      let port = 8080;
      const existingProxies = configStore.getProxies();
      const usedPorts = new Set(existingProxies.map(p => p.port));
      while (usedPorts.has(port)) port++;

      // 创建代理
      const proxy = configStore.addProxy({
        name: '默认代理',
        port,
        requireAuth: false,
        authToken: null,
        providerId: provider.id,
        defaultModel: model,
        providerWeight: 1,
        routingStrategy: 'primary_fallback',
        providerPool: [],
      });

      // 启动代理
      try {
        await startProxyWithProvider(proxy);
      } catch (startErr) {
        // 启动失败不删除配置，让用户可以手动处理
        return res.status(500).json({ ok: false, message: `代理创建成功但启动失败: ${startErr.message}`, provider, proxy });
      }

      res.json({ ok: true, provider, proxy: { ...proxy, running: true } });
    } catch (err) {
      res.status(500).json({ ok: false, message: err.message });
    }
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
      if (protocol === 'openai' || protocol === 'responses') {
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
        models = data.data.map(m => ({
          name: m.id || m.name || '',
          contextLength: m.context_length || 0,
        })).filter(m => m.name).sort((a, b) => a.name.localeCompare(b.name));
      } else if (Array.isArray(data?.models)) {
        models = data.models.map(m => ({
          name: (m.name || m.id || '').replace('models/', ''),
          contextLength: m.inputTokenLimit || 0,
        })).filter(m => m.name).sort((a, b) => a.name.localeCompare(b.name));
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
      if (protocol === 'openai' || protocol === 'responses') {
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
        models = data.data.map(m => ({
          name: m.id || m.name || '',
          contextLength: m.context_length || 0,
        })).filter(m => m.name).sort((a, b) => a.name.localeCompare(b.name));
      } else if (Array.isArray(data?.models)) {
        // Gemini 格式
        models = data.models.map(m => ({
          name: (m.name || m.id || '').replace('models/', ''),
          contextLength: m.inputTokenLimit || 0,
        })).filter(m => m.name).sort((a, b) => a.name.localeCompare(b.name));
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

  // ==================== 记忆管理 API ====================
  app.get('/api/memory', (req, res) => {
    const memStore = memoryManager.store;
    res.json({
      soul: memStore.loadSoul() || '',
      tier1: {
        memory: memStore.loadTier1('memory') || '',
        user: memStore.loadTier1('user') || '',
      },
      tier2: {
        memory: memStore.getTier2Entries('memory'),
        user: memStore.getTier2Entries('user'),
      },
      limits: {
        tier1MemoryMaxChars: memoryManager.tier1MemoryMaxChars,
        tier1UserMaxChars: memoryManager.tier1UserMaxChars,
        tier2MemoryMaxEntries: memoryManager.tier2MemoryMaxEntries,
        tier2MemoryMaxChars: memoryManager.tier2MemoryMaxChars,
        tier2UserMaxEntries: memoryManager.tier2UserMaxEntries,
        tier2UserMaxChars: memoryManager.tier2UserMaxChars,
        soulMaxChars: memoryManager.soulMaxChars,
      },
      config: {
        enabled: memoryManager.enabled,
        soulEnabled: memoryManager.soulEnabled,
        tier1Enabled: memoryManager.tier1Enabled,
        tier2MemoryEnabled: memoryManager.tier2MemoryEnabled,
        tier2UserEnabled: memoryManager.tier2UserEnabled,
      },
    });
  });

  // SOUL
  app.put('/api/memory/soul', (req, res) => {
    const content = (req.body.content || '').trim();
    const maxChars = memoryManager.soulMaxChars || 2000;
    if (content.length > maxChars) {
      return res.status(400).json({ error: `SOUL 内容超出限制 (${content.length}/${maxChars} 字符)` });
    }
    try {
      const soulPath = path.join(os.homedir(), '.protocol-proxy', 'SOUL.md');
      fs.writeFileSync(soulPath, content, 'utf8');
      memoryManager.store._soul = content;
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Tier 1 保存（整个 markdown）
  app.put('/api/memory/tier1/:target', (req, res) => {
    const result = memoryManager.store.saveTier1(req.params.target, req.body.content);
    res.json(result);
  });

  // Tier 2 添加条目
  app.post('/api/memory/tier2/:target', (req, res) => {
    const result = memoryManager.store.addTier2(req.params.target, req.body.content, req.body.summary);
    res.json(result);
  });

  // Tier 2 更新条目
  app.put('/api/memory/tier2/:target', (req, res) => {
    const result = memoryManager.store.replaceTier2(req.params.target, req.body.old_text, req.body.content, req.body.summary);
    res.json(result);
  });

  // Tier 2 删除条目
  app.delete('/api/memory/tier2/:target', (req, res) => {
    const result = memoryManager.store.removeTier2(req.params.target, req.body.old_text);
    res.json(result);
  });

  // 设置

  // ==================== 开机自启 API ====================

  const autostart = require('./lib/autostart');

  app.get('/api/autostart', (req, res) => {
    try {
      res.json(autostart.isEnabled());
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.put('/api/autostart', (req, res) => {
    try {
      const { enabled } = req.body;
      if (typeof enabled !== 'boolean') {
        return res.status(400).json({ error: '需要 enabled (boolean)' });
      }
      const result = enabled ? autostart.enable() : autostart.disable();
      if (!result.success) return res.status(500).json(result);
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
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

  // 请求重放
  app.post('/api/request-logs/:id/replay', async (req, res) => {
    try {
      const entry = requestLog.getAll(2000).find(e => e.id === req.params.id);
      if (!entry) return res.status(404).json({ error: '日志条目不存在' });
      if (!entry.requestBody) return res.status(400).json({ error: '该请求无可用请求体' });

      const proxy = configStore.getProxyById(entry.proxyId);
      if (!proxy) return res.status(404).json({ error: '代理配置不存在' });
      if (!proxyManager.isRunning(entry.proxyId)) {
        return res.status(400).json({ error: '代理未运行，请先启动代理' });
      }

      const fetchRes = await fetch(`http://localhost:${proxy.port}${entry.path}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Replay': 'true',
          'X-Replay-From': entry.id,
        },
        body: entry.requestBody,
      });

      res.status(fetchRes.status);
      res.set('Content-Type', fetchRes.headers.get('content-type') || 'application/json');
      res.send(await fetchRes.text());
    } catch (err) {
      res.status(500).json({ error: '重放失败: ' + err.message });
    }
  });

  // ==================== 执行策略 API ====================

  app.get('/api/exec-policy', (req, res) => {
    const { execPolicy } = require('./lib/exec-policy');
    res.json(execPolicy.getAllRules());
  });

  app.post('/api/exec-policy/test', (req, res) => {
    const { execPolicy } = require('./lib/exec-policy');
    const { command } = req.body;
    if (!command) return res.status(400).json({ error: 'command is required' });
    res.json(execPolicy.check(command));
  });

  app.delete('/api/exec-policy/rule', (req, res) => {
    const { execPolicy } = require('./lib/exec-policy');
    const { category, pattern } = req.body;
    if (!category || !pattern) return res.status(400).json({ error: 'category and pattern required' });
    const removed = execPolicy.removeRule(category, pattern);
    res.json({ success: removed });
  });

  app.post('/api/exec-policy/rule', (req, res) => {
    const { execPolicy } = require('./lib/exec-policy');
    const { category, pattern, description } = req.body;
    if (!category || !pattern) return res.status(400).json({ error: 'category and pattern required' });
    if (!['allow', 'prompt', 'forbidden'].includes(category)) {
      return res.status(400).json({ error: 'category must be allow, prompt, or forbidden' });
    }
    const added = execPolicy.addRule(category, pattern, description);
    if (!added) return res.status(409).json({ error: '规则已存在' });
    res.json({ success: true });
  });

  // ==================== 多 Agent 任务 API ====================

  app.get('/api/tasks', (req, res) => {
    const { registry } = require('./lib/multi-agent');
    const status = req.query.status;
    res.json({ tasks: registry.list(status) });
  });

  app.get('/api/tasks/:id', (req, res) => {
    const { registry } = require('./lib/multi-agent');
    const task = registry.get(req.params.id);
    if (!task) return res.status(404).json({ error: 'Task not found' });
    res.json(task);
  });

  app.post('/api/tasks/:id/stop', (req, res) => {
    const { registry } = require('./lib/multi-agent');
    const task = registry.stop(req.params.id);
    if (!task) return res.status(404).json({ error: 'Task not found or not running' });
    res.json(task);
  });

  app.delete('/api/tasks/:id', (req, res) => {
    const { registry } = require('./lib/multi-agent');
    const task = registry.get(req.params.id);
    if (!task) return res.status(404).json({ error: 'Task not found' });
    if (task.status === 'running') return res.status(400).json({ error: 'Cannot delete running task, stop it first' });
    registry.clearMessages(req.params.id);
    const taskStore = require('./lib/multi-agent/task-store');
    taskStore.remove(req.params.id);
    res.json({ success: true });
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

  const agentStore = require('./lib/agent-store');
  agentStore.init();

  const { MemoryManager } = require('./lib/memory-manager');
  const memoryManager = new MemoryManager({ settings: configStore.getSettings() });
  memoryManager.initialize();

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
    cleanupConvFiles(req.params.id);
    res.json({ success: true });
  });

  // 清空所有历史会话
  app.delete('/api/assistant/conversations', (req, res) => {
    const all = conversationStore.list();
    const count = all.length;
    for (const conv of all) {
      conversationStore.remove(conv.id);
      cleanupConvFiles(conv.id);
    }
    res.json({ success: true, count });
  });

  // 获取单个会话的消息历史（用于恢复会话显示）
  app.get('/api/assistant/conversations/:id/messages', (req, res) => {
    const conv = conversationStore.get(req.params.id);
    if (!conv) return res.status(404).json({ error: '会话不存在' });
    // 兼容旧数据：给没有 id 的消息补上 id
    let needSave = false;
    for (const m of (conv.messages || [])) {
      if (!m.id) {
        m.id = generateMsgId();
        needSave = true;
      }
    }
    if (needSave) conversationStore.saveImmediate(conv);
    // 返回消息历史（过滤掉 system 消息，前端不需要显示）
    const messages = (conv.messages || []).filter(m => m.role !== 'system');
    const compressionSummary = conv.compressionSummary || null;
    res.json({ id: conv.id, proxyId: conv.proxyId, messages, compressionSummary });
  });

  // 删除会话中的某条消息（成对删除：删除 user 时连带删除后续 assistant/tool，删除 assistant 时连带删除前面 user 及后续 tool）
  app.delete('/api/assistant/conversations/:id/messages/:msgId', (req, res) => {
    const conv = conversationStore.get(req.params.id);
    if (!conv) return res.status(404).json({ error: '会话不存在' });
    const msgId = req.params.msgId;
    const idx = (conv.messages || []).findIndex(m => m.id === msgId);
    if (idx === -1) return res.status(404).json({ error: '消息不存在' });

    // 向前扫描找到该问答对的起始 user 消息
    let startIdx = idx;
    while (startIdx > 0 && conv.messages[startIdx].role !== 'user') startIdx--;
    if (conv.messages[startIdx].role !== 'user') startIdx = idx; // 兜底：如果前面没有 user，从当前位置开始

    // 向后扫描找到该问答对的结束位置（下一条 user 之前或数组末尾）
    let endIdx = startIdx;
    while (endIdx + 1 < conv.messages.length && conv.messages[endIdx + 1].role !== 'user') endIdx++;

    const removedCount = endIdx - startIdx + 1;
    // 清理被删除消息关联的文件
    for (let i = startIdx; i <= endIdx; i++) {
      if (conv.messages[i]?.id) deleteConvMsgFiles(conv.id, conv.messages[i].id);
    }
    conv.messages.splice(startIdx, removedCount);
    conversationStore.saveImmediate(conv);
    res.json({ success: true, removedCount });
  });

  // 获取代理的候选供应商及其模型列表（供前端级联选择）
  app.get('/api/assistant/proxy-providers/:proxyId', (req, res) => {
    const proxy = configStore.getProxyById(req.params.proxyId);
    if (!proxy) return res.status(404).json({ error: '代理不存在' });
    const providers = configStore.getProviders().map(p => ({
      id: p.id,
      name: p.name,
      protocol: p.protocol,
      adapter: p.adapter || '',
      models: p.models || [],
    }));
    res.json({ providers, defaultModel: proxy.defaultModel || '' });
  });

  // ==================== 多模态服务 API ====================
  app.get('/api/multimodal', (req, res) => {
    res.json(configStore.getMultimodalServices());
  });

  app.post('/api/multimodal', (req, res) => {
    const { name, serviceType, brand, url, apiKey, models, model, enabled } = req.body;
    if (!name || !serviceType || !brand || !url) return res.status(400).json({ error: 'name、serviceType、brand、url 必填' });
    const modelsList = (models && models.length > 0) ? models : (model ? [{ name: model }] : []);
    const service = configStore.addMultimodalService({ name, serviceType, brand, url: url || '', apiKey: apiKey || '', models: modelsList, enabled: enabled !== false });
    res.json(service);
  });

  app.put('/api/multimodal/:id', (req, res) => {
    const existing = configStore.getMultimodalServiceById(req.params.id);
    if (!existing) return res.status(404).json({ error: '服务不存在' });
    const updates = {};
    for (const k of ['name', 'serviceType', 'brand', 'url', 'apiKey', 'enabled']) {
      if (req.body[k] !== undefined) updates[k] = req.body[k];
    }
    if (req.body.models !== undefined) updates.models = req.body.models;
    else if (req.body.model !== undefined) updates.models = req.body.model ? [{ name: req.body.model }] : [];
    const updated = configStore.updateMultimodalService(req.params.id, updates);
    res.json(updated);
  });

  app.delete('/api/multimodal/:id', (req, res) => {
    configStore.removeMultimodalService(req.params.id);
    res.json({ success: true });
  });

  // 对话文件服务（多模态工具生成的音频/视频/图片）
  app.get('/api/conv-files/:convId/:filename', (req, res) => {
    const { convId, filename } = req.params;
    const dir = getConvFilesPath(convId);
    const filePath = path.resolve(dir, filename);
    if (!filePath.startsWith(path.resolve(dir))) {
      return res.status(400).json({ error: 'invalid path' });
    }
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: '文件不存在' });
    const ext = path.extname(filename).toLowerCase();
    const mimeMap = { '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.mp4': 'video/mp4', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };
    res.setHeader('Content-Type', mimeMap[ext] || 'application/octet-stream');
    res.sendFile(filePath);
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
    const { name, description, content, trigger } = req.body;
    if (!name || !content) return res.status(400).json({ error: '需要 name 和 content' });
    const skill = skillStore.create(name, description || '', content, trigger || '');
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
    const { description, content, trigger } = req.body;
    const skill = skillStore.update(req.params.name, description || '', content || '', trigger || '');
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

  // 热重载 Skill
  app.post('/api/skills/reload', (req, res) => {
    skillStore.init();
    res.json({ success: true, count: skillStore.list().length });
  });

  // ==================== Agent 身份管理 API ====================

  app.get('/api/agents', (req, res) => {
    res.json({ agents: agentStore.list() });
  });

  app.get('/api/agents/:slug', (req, res) => {
    const agent = agentStore.get(req.params.slug);
    if (!agent) return res.status(404).json({ error: '代理不存在' });
    res.json(agent);
  });

  app.post('/api/agents', (req, res) => {
    const { name, description, body, color, defaultRole } = req.body;
    if (!name || !body) return res.status(400).json({ error: '需要 name 和 body' });
    const agent = agentStore.create(name, description || '', body, color || '#6B7280', defaultRole || 'writer');
    if (!agent) return res.status(409).json({ error: '代理已存在' });
    res.json(agent);
  });

  app.put('/api/agents/:slug', (req, res) => {
    const { description, body, color, defaultRole } = req.body;
    const agent = agentStore.update(req.params.slug, { description, body, color, defaultRole });
    if (!agent) return res.status(404).json({ error: '代理不存在或不可编辑' });
    res.json(agent);
  });

  app.delete('/api/agents/:slug', (req, res) => {
    const agent = agentStore.get(req.params.slug);
    if (!agent) return res.status(404).json({ error: '代理不存在' });
    if (agent.category === 'system') return res.status(403).json({ error: '系统级代理不可删除' });
    if (!agentStore.remove(req.params.slug)) return res.status(500).json({ error: '删除失败' });
    res.json({ success: true });
  });

  app.post('/api/agents/reload', (req, res) => {
    agentStore.init();
    res.json({ success: true, count: agentStore.list().length });
  });

  // 批量导入代理（从指定目录复制 .md 到 preset）
  app.post('/api/agents/import', (req, res) => {
    const { sourceDir } = req.body;
    if (!sourceDir) return res.status(400).json({ error: '需要 sourceDir' });
    try {
      const absSource = path.resolve(sourceDir);
      if (!fs.existsSync(absSource)) return res.status(400).json({ error: '源目录不存在' });
      const presetDir = path.join(__dirname, 'agents', 'preset');
      fs.mkdirSync(presetDir, { recursive: true });
      const entries = fs.readdirSync(absSource).filter(f => f.endsWith('.md') && !f.startsWith('.'));
      let imported = 0;
      for (const entry of entries) {
        const src = path.join(absSource, entry);
        const dst = path.join(presetDir, entry);
        if (fs.existsSync(dst)) continue;
        fs.copyFileSync(src, dst);
        imported++;
      }
      agentStore.init();
      res.json({ success: true, imported, total: agentStore.list().length });
    } catch (err) {
      res.status(500).json({ error: `导入失败: ${err.message}` });
    }
  });


  // 上传 .md 文件导入代理（支持多文件）
  app.post('/api/agents/upload', (req, res) => {
    try {
      const { files } = req.body; // [{ name: "xxx.md", content: "base64..." }]
      if (!files || !Array.isArray(files) || files.length === 0) {
        return res.status(400).json({ error: '需要 files 数组，每项包含 name 和 content (base64)' });
      }
      const presetDir = path.join(__dirname, 'agents', 'preset');
      const userDir = path.join(os.homedir(), '.protocol-proxy', 'agents');
      fs.mkdirSync(presetDir, { recursive: true });
      fs.mkdirSync(userDir, { recursive: true });
      let imported = 0;
      const results = [];
      for (const file of files) {
        const safeName = path.basename(file.name).replace(/[^a-zA-Z0-9._-]/g, '_');
        if (!safeName.endsWith('.md')) {
          results.push({ name: safeName, status: 'skipped', reason: '非 .md 文件' });
          continue;
        }
        const dest = path.join(userDir, safeName);
        if (fs.existsSync(dest)) {
          results.push({ name: safeName, status: 'skipped', reason: '已存在' });
          continue;
        }
        fs.writeFileSync(dest, Buffer.from(file.content, 'base64'));
        imported++;
        results.push({ name: safeName, status: 'ok' });
      }
      agentStore.init();
      res.json({ success: true, imported, results, total: agentStore.list().length });
    } catch (err) {
      res.status(500).json({ error: '上传失败: ' + err.message });
    }
  });
  // ==================== MCP 服务管理 API ====================

  app.get('/api/mcp/servers', (req, res) => {
    const servers = configStore.getMcpServers();
    const status = mcpClient.getStatus();
    const statusMap = Object.fromEntries(status.map(s => [s.name, s]));
    const result = Object.entries(servers).map(([name, config]) => ({
      name,
      enabled: config.enabled !== false,
      dangerous: !!config.dangerous,
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
    const { name, command, args, env, url, headers, enabled, toolCallTimeoutMs, dangerous } = req.body;
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
    serverConfig.dangerous = !!dangerous;
    if (toolCallTimeoutMs) serverConfig.toolCallTimeoutMs = parseInt(toolCallTimeoutMs, 10) || undefined;
    configStore.addMcpServer(name, serverConfig);
    if (serverConfig.enabled) {
      mcpClient.connectServer(name, serverConfig).catch(err => {
        logger.error(`[MCP] 后台连接 ${name} 失败: ${err.message}`);
      });
    }
    res.json({ success: true, name });
  });

  app.put('/api/mcp/servers/:name', async (req, res) => {
    const { command, args, env, url, headers, enabled, toolCallTimeoutMs, dangerous } = req.body;
    const existing = configStore.getMcpServer(req.params.name);
    if (!existing) return res.status(404).json({ error: 'MCP 服务不存在' });
    const updates = {};
    if (toolCallTimeoutMs !== undefined) updates.toolCallTimeoutMs = parseInt(toolCallTimeoutMs, 10) || undefined;
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
    if (dangerous !== undefined) updates.dangerous = !!dangerous;
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

  app.get('/api/mcp/presets', (req, res) => {
    const presets = configStore.getMcpPresets();
    const existing = configStore.getMcpServers();
    const result = presets.map(p => ({
      ...p,
      added: !!existing[p.name],
    }));
    res.json(result);
  });

  app.get('/api/mcp/tools', (req, res) => {
    const status = mcpClient.getStatus();
    const allTools = status.filter(s => s.status === 'connected').flatMap(s =>
      s.tools.map(t => ({ ...t, server: s.name, transport: s.transport }))
    );
    res.json(allTools);
  });

  app.get('/api/mcp/tool-stats', (req, res) => {
    res.json(mcpToolStats.getStats());
  });

  // 所有可用工具列表（内置 + MCP），供前端子智能体配置使用
  app.get('/api/assistant/tools', (req, res) => {
    const _mmToolsLocal = getMultimodalTools();
    const _seenTools = new Set();
    const allDefs = [...TOOL_DEFINITIONS, ..._mmToolsLocal.definitions, ...mcpClient.getToolDefinitions()].filter(d => { const n = d.function?.name || d.name; if (_seenTools.has(n)) return false; _seenTools.add(n); return true; });
    const tools = allDefs.map(d => {
      const name = d.function?.name || d.name;
      const desc = d.function?.description || d.description || '';
      const perm = TOOL_PERMISSION[name] || 2;
      return { name, description: desc, permission: perm };
    });
    res.json(tools);
  });

  // 工具审批端点
  app.post('/api/assistant/approve', (req, res) => {
    const { id, approved } = req.body; // approved: true | false | 'session'
    const pending = pendingApprovals.get(id);
    if (!pending) return res.status(404).json({ error: '审批请求不存在或已超时' });
    const label = approved === 'session' ? '会话批准' : approved ? '批准' : '拒绝';
    logger.log(`[assistant] 工具审批: ${pending.name} → ${label}`);
    pending.resolve(approved === 'session' ? 'session' : !!approved);
    pendingApprovals.delete(id);
    res.json({ ok: true });
  });

  app.post('/api/assistant/chat', async (req, res) => {
    logger.log(`[assistant] chat request received: conv=${req.body.conversationId}, httpVersion=${req.httpVersion}, connection=${req.headers.connection || 'keep-alive'}`);
    const { proxyId, conversationId, message, compress, providerId, model, thinkingEffort, mode, windowSize } = req.body;
    if (!proxyId || (!compress && !message)) {
      return res.status(400).json({ error: '需要 proxyId 和 message' });
    }

    const proxy = configStore.getProxyById(proxyId);
    if (!proxy) return res.status(404).json({ error: '代理不存在' });
    if (!resolveTarget(proxy)) return res.status(500).json({ error: '代理目标未配置' });

    // 缓存多模态工具，避免每次 tool call 都重新生成
    const _mmTools = getMultimodalTools();

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
    // 保存对话模式
    if (mode && (mode === 'full' || mode === 'sliding')) conv.mode = mode;
    if (windowSize && windowSize > 0) conv.windowSize = Math.min(200, Math.max(1, parseInt(windowSize)));
    conversationStore.touch(conv);

    // 请求级 AbortController：客户端断开时 abort，用于终止工具循环和子进程
    const requestAbort = new AbortController();

    // req.on('close')：请求体消费后触发，清理待审批工具
    // activeStreams 的清理由 finally 块统一处理
    req.on('close', () => {
      for (const [id, entry] of pendingApprovals) {
        if (entry.timestamp > Date.now() - TOOL_APPROVAL_TIMEOUT_MS * 2) {
          entry.resolve(false);
          pendingApprovals.delete(id);
        }
      }
    });

    // res.on('close')：响应结束或连接断开时触发，用于 abort 工具循环和子进程
    res.on('close', () => {
      if (res.writableEnded) return; // 正常完成，不需要 abort
      requestAbort.abort();
      if (_chatProxy.currentBatchId) {
        const { registry: taskRegistry } = require('./lib/multi-agent');
        const stopped = taskRegistry.stopBatch(_chatProxy.currentBatchId);
        if (stopped > 0) logger.log(`[assistant] 客户端断开，停止 ${stopped} 个子任务`);
        _chatProxy.currentBatchId = null;
      }
    });

    // 追加用户消息到对话历史（压缩请求不追加空消息）
    // 检测 /skillname 前缀触发技能
    let activeSkill = null;
    let lastUserMsgId = null;
    if (!compress && message) {
      // 多模态消息（数组格式）直接保存，不支持技能触发前缀检测
      if (Array.isArray(message)) {
        lastUserMsgId = generateMsgId();
        conv.messages.push({ id: lastUserMsgId, role: 'user', content: message });
        // 保存文件到对话目录（供 Code Interpreter 使用）
        saveConvFiles(convId, message, lastUserMsgId);
      } else {
        const slashMatch = message.match(/^\/([a-zA-Z0-9_-]+)(?:\s+([\s\S]*))?$/);
        if (slashMatch) {
          const skillName = slashMatch[1];
          const skill = skillStore.get(skillName);
          if (skill) {
            activeSkill = skill;
            // 将用户消息中的参数部分保留，无参数时生成触发消息
            const args = slashMatch[2]?.trim();
            lastUserMsgId = generateMsgId();
            conv.messages.push({ id: lastUserMsgId, role: 'user', content: args || `请执行 ${skillName} 技能` });
          } else {
            lastUserMsgId = generateMsgId();
            conv.messages.push({ id: lastUserMsgId, role: 'user', content: message });
          }
        } else {
          lastUserMsgId = generateMsgId();
          conv.messages.push({ id: lastUserMsgId, role: 'user', content: message });
        }
      }
      conversationStore.touch(conv);
    }

    const proxyUrl = `http://localhost:${proxy.port}/v1/chat/completions`;
    const proxyHeaders = { 'Content-Type': 'application/json' };
    if (proxy.requireAuth && proxy.authToken) {
      proxyHeaders['Authorization'] = `Bearer ${proxy.authToken}`;
    }
    // 更新多 Agent 委派的共享代理上下文
    _chatProxy.url = proxyUrl;
    _chatProxy.headers = { ...proxyHeaders };
    _chatProxy.defaultModel = model || proxy.defaultModel;
    if (providerId) proxyHeaders['x-pp-provider-id'] = providerId;
    if (model) proxyHeaders['x-pp-model'] = model;
    // 手动指定了供应商时，传递完整配置供代理直接路由（不依赖池子）
    if (providerId) {
      const provider = configStore.getProviderById(providerId);
      if (provider) {
        proxyHeaders['x-pp-provider-url'] = provider.url;
        proxyHeaders['x-pp-provider-protocol'] = provider.protocol;
        if (provider.adapter) proxyHeaders['x-pp-provider-adapter'] = provider.adapter;
        if (Array.isArray(provider.capabilities)) proxyHeaders['x-pp-provider-capabilities'] = JSON.stringify(provider.capabilities);
        const enabledKeys = (provider.apiKeys || []).filter(k => k.enabled !== false);
        if (enabledKeys.length > 0) proxyHeaders['x-pp-provider-keys'] = JSON.stringify(enabledKeys.map(k => ({ key: k.key, enabled: k.enabled, alias: encodeURIComponent(k.alias || '') })));
        proxyHeaders['x-pp-provider-name'] = encodeURIComponent(provider.name);
      }
    }

    // SSE 响应头
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    function safeSSE(event, data) {
      try { sendSSE(res, event, data); } catch {}
    }
    _chatProxy.safeSSE = safeSSE;
    const effectiveModel = model || proxy.defaultModel;
    const MAX_CONTEXT = resolveModelContext(effectiveModel, proxy, settings, providerId);
    const MAX_TOOL_ROUNDS = Math.max(1, Math.min(100, parseInt(settings.maxRounds) || 10));
    const effectiveThinkingEffort = thinkingEffort || resolveThinkingEffort(effectiveModel, proxy, providerId);
    const effectiveProvider = providerId ? configStore.getProviderById(providerId) : configStore.getProviderById(proxy.providerId);
    const effectiveProtocol = effectiveProvider?.protocol || 'openai';
    // 只在用户明确指定了供应商时才传 adapter，避免自动路由时把 reasoning_effort: 0 广播给不支持的供应商
    const thinkingParams = buildThinkingParams(effectiveThinkingEffort, effectiveProtocol, providerId ? effectiveProvider?.adapter : '');

    // 音频输入协议兼容性检查
    if (Array.isArray(message) && message.some(b => b.type === 'input_audio')) {
      const targetProvider = providerId
        ? configStore.getProviderById(providerId)
        : configStore.getProviderById(proxy.providerId);
      if (targetProvider?.protocol === 'anthropic') {
        safeSSE('error', { message: `当前供应商「${targetProvider.name}」使用 Anthropic 协议，不支持音频输入。请切换到 OpenAI 协议的供应商，或改用文字输入。` });
        safeSSE('done', {});
        res.end();
        return;
      }
    }

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
        // 诊断：压缩后消息结构
        const structLog = conv.messages.map((m, i) => {
          const extra = m.tool_calls ? `+tc[${m.tool_calls.length}]` : m.tool_call_id ? '+tcid' : '';
          return `[${i}]${m.role}${extra}`;
        }).join(' ');
        logger.log(`[assistant] 压缩后消息结构: ${structLog}`);
      } else {
        safeSSE('compressed', { summary: null, removedCount: 0, tokens: estimateConversationTokens(conv.messages), maxTokens: MAX_CONTEXT, messages: conv.messages.length });
      }
      safeSSE('done', {});
      res.end();
      return;
    }

    // 发送 conversationId 给前端
    safeSSE('conversation', { id: convId, ...(lastUserMsgId && { userMessageId: lastUserMsgId }) });

    // 进度心跳：每 3s 向前端报告当前阶段，防止用户以为系统卡死
    let _progressInterval = null;
    let _progressStart = 0;
    function startProgress(stage, extra = {}) {
      stopProgress();
      _progressStart = Date.now();
      _progressInterval = setInterval(() => {
        safeSSE('progress', { stage, elapsed: Math.round((Date.now() - _progressStart) / 1000), ...extra });
      }, 3000);
      safeSSE('progress', { stage, elapsed: 0, ...extra });
    }
    function stopProgress() {
      if (_progressInterval) { clearInterval(_progressInterval); _progressInterval = null; }
    }

    try {
      // 请求级别缓存 system prompt（避免每轮重建导致 prompt cache 失效）
      const convFilesList = (() => { try { return fs.readdirSync(getConvFilesPath(convId)).filter(f => fs.statSync(path.join(getConvFilesPath(convId), f)).isFile()); } catch { return []; } })();
      const systemPrompt = promptBuilder.buildSystemPrompt({ skillStore, mcpClient, memoryManager, agentStore, convFiles: convFilesList, multimodalToolNames: _mmTools.definitions.map(d => d.function?.name || d.name) });
      const buildMessages = () => {
        // 将所有 system 内容合并为一条消息，避免某些模型（如 MiniMax）不支持多条 system 消息
        const systemParts = [systemPrompt];
        if (activeSkill) {
          let skillInfo = `[技能指令: ${activeSkill.name}]\n${activeSkill.content}`;
          if (activeSkill.dirPath) skillInfo += `\n\n技能目录: ${activeSkill.dirPath}`;
          if (activeSkill.scripts?.length > 0) skillInfo += `\n可用脚本: ${activeSkill.scripts.map(f => 'scripts/' + f).join(', ')}`;
          systemParts.push(skillInfo);
        }
        if (conv.compressionSummary) {
          systemParts.push(`[压缩摘要]\n${conv.compressionSummary}\n\n---\n以上是之前对话的压缩摘要。最近的消息保留原文。请继续对话，不要复述摘要内容。`);
        }
        if (conv.mode === 'sliding') {
          const ws = conv.windowSize || 20;
          systemParts.push(`[长对话模式] 当前为长对话模式，只提供了最近的 ${ws} 条消息。更早的历史消息未包含在上下文中，如用户需要回顾之前的内容，请提示用户查看历史会话或切换到专业模式。`);
        }
        const msgs = [{ role: 'system', content: systemParts.join('\n\n---\n\n') }];
        // 构建发给 API 的消息：assistant 消息附带图片时转为 vision content blocks
        const buildApiMessage = (m) => {
          // _multimodal 工具消息：始终发送多模态内容，由 API 判断模型是否支持
          if (m.role === 'tool' && m._multimodal && Array.isArray(m.content)) {
            return m;
          }
          if (m.role !== 'assistant' || !m._images || m._images.length === 0) return m;
          const dir = getConvFilesPath(convId);
          const parts = [];
          // 文本部分（剥离媒体标记）
          const text = (m.content || '').replace(/\[MEDIA:[^\]]+\]/g, '').trim();
          if (text) parts.push({ type: 'text', text });
          // 图片部分
          for (const fname of m._images) {
            try {
              const filePath = path.join(dir, fname);
              if (fs.existsSync(filePath)) {
                const base64 = fs.readFileSync(filePath).toString('base64');
                parts.push({ type: 'image_url', image_url: { url: `data:image/png;base64,${base64}` } });
              }
            } catch {}
          }
          return parts.length > 0 ? { role: 'assistant', content: parts } : m;
        };
        if (conv.mode === 'sliding') {
          const ws = conv.windowSize || 20;
          msgs.push(...conv.messages.slice(-ws).map(buildApiMessage));
        } else {
          msgs.push(...conv.messages.map(buildApiMessage));
        }
        return msgs;
      };

      // 请求级工具缓存：只读工具在同一请求的多轮调用间复用结果
      const toolResultCache = new Map();
      const makeCacheKey = (name, args) => name + '\0' + JSON.stringify(args, Object.keys(args).sort());
      const isCacheable = (name) => !name.startsWith('mcp__') && (TOOL_PERMISSION[name] || 2) === 1;

      let currentTokens = estimateConversationTokens(buildMessages());
      const sendContext = () => {
        const pct = Math.round(currentTokens / MAX_CONTEXT * 1000) / 10;
        safeSSE('context', { tokens: currentTokens, maxTokens: MAX_CONTEXT, percent: pct, messages: conv.messages.length, mode: conv.mode || 'full', windowSize: conv.windowSize || 20 });
      };
      sendContext();

      let loopCompleted = false;
      for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
        if (requestAbort.signal.aborted) { logger.log(`[assistant] 客户端已断开，终止工具循环`); break; }
        const messages = buildMessages();
        logger.log(`[assistant] round ${round} — ${messages.length} messages, ~${currentTokens} tokens`);

        let fetchRes;
        try {
          const cleanMessages = messages.map(m => {
            const clean = { role: m.role, content: m.content };
            if (m.tool_calls) clean.tool_calls = m.tool_calls;
            if (m.tool_call_id) clean.tool_call_id = m.tool_call_id;
            if (m.name) clean.name = m.name;
            if (m.reasoning_content !== undefined) clean.reasoning_content = m.reasoning_content;
            return clean;
          });
          // 诊断日志：请求消息结构
          if (round === 0) {
            const reqStruct = cleanMessages.map((m, i) => {
              const cType = m.content === null ? 'null' : typeof m.content === 'string' ? `str(${m.content.length})` : typeof m.content;
              const extra = m.tool_calls ? `+tc[${m.tool_calls.length}]` : m.tool_call_id ? '+tcid' : '';
              return `[${i}]${m.role}:${cType}${extra}`;
            }).join(' ');
            logger.log(`[assistant] 请求消息结构 (${cleanMessages.length}): ${reqStruct}`);
          }
          startProgress('llm', { round });
          fetchRes = await fetch(proxyUrl, {
            method: 'POST',
            headers: proxyHeaders,
            signal: AbortSignal.any([requestAbort.signal, AbortSignal.timeout(300000)]),
            body: JSON.stringify({
              model: proxy.defaultModel || 'gpt-4o',
              messages: cleanMessages,
              stream: true,
              tools: (() => {
                const seen = new Set();
                return [...TOOL_DEFINITIONS, ..._mmTools.definitions, ...mcpClient.getToolDefinitions()].filter(d => {
                  const name = d.function?.name || d.name;
                  if (seen.has(name)) return false;
                  seen.add(name);
                  return true;
                });
              })(),
              tool_choice: 'auto',
              ...thinkingParams,
            }),
          });
        } catch (fetchErr) {
          const abortReason = requestAbort.signal.aborted ? 'client_disconnect' : 'timeout_or_network';
          logger.log(`[assistant] round ${round} fetch error: ${fetchErr.message} (reason: ${abortReason}, reqClosed: ${req.destroyed})`);
          safeSSE('error', { message: `代理请求失败: ${fetchErr.message}` });
          break;
        }

        if (!fetchRes.ok) {
          const text = await fetchRes.text();
          logger.log(`[assistant] round ${round} HTTP ${fetchRes.status}: ${text.slice(0, 200)}`);

          // 上下文溢出自动压缩重试
          if (isContextWindowError(fetchRes.status, text)) {
            logger.log(`[assistant] 检测到上下文溢出，自动压缩并重试`);
            safeSSE('compressing', { reason: 'context_overflow' });
            const compResult = await compressConversation(conv, MAX_CONTEXT, proxyUrl, proxyHeaders, proxy.defaultModel);
            if (compResult) {
              conv.messages = compResult.messages;
              conv.compressionSummary = compResult.summary;
              conversationStore.touch(conv);
              currentTokens = compResult.newTokens;
              sendContext();
              safeSSE('compressed', { summary: compResult.summary, removedCount: compResult.removedCount, tokens: currentTokens, maxTokens: MAX_CONTEXT, messages: conv.messages.length, reason: 'context_overflow' });
              logger.log(`[assistant] 溢出压缩完成 — 移除 ${compResult.removedCount} 条，剩余 ${conv.messages.length} 条`);
              round--; // 重试当前轮次
              continue;
            }
          }

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
        const visionImages = []; // 工具生成的图片文件名，附到最终回复供 vision API

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

        let lastAssistantMsgId = null;
        if (toolCalls.length === 0) {
          // 最终回复，追加到对话历史（跳过空响应避免 null content 污染历史）
          if (fullContent || reasoningContent) {
            lastAssistantMsgId = generateMsgId();
            const assistantMsg = { id: lastAssistantMsgId, role: 'assistant', content: fullContent || null };
            if (reasoningContent) assistantMsg.reasoning_content = reasoningContent;
            if (visionImages.length > 0) assistantMsg._images = [...visionImages];
            conv.messages.push(assistantMsg);
          }
          currentTokens = estimateConversationTokens(buildMessages());
          sendContext();
          safeSSE('done', { reasoning_content: reasoningContent || undefined, assistantMessageId: lastAssistantMsgId });
          loopCompleted = true;
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
        lastAssistantMsgId = generateMsgId();
        const assistantMsg = {
          id: lastAssistantMsgId,
          role: 'assistant',
          content: fullContent || null,
          tool_calls: toolCalls.map(tc => ({ id: tc.id, type: 'function', function: { name: tc.name, arguments: tc.arguments } })),
        };
        if (reasoningContent) assistantMsg.reasoning_content = reasoningContent;
        conv.messages.push(assistantMsg);

        // 执行工具
        stopProgress();
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
          if (requestAbort.signal.aborted) {
            result = { error: '用户已取消操作' };
            isError = true;
          } else if (argsParseError) {
            result = { error: `工具 ${tc.name} 的参数 JSON 解析失败，原始内容: ${(tc.arguments || '').slice(0, 200)}` };
            isError = true;
          } else try {
            // 传递 abort signal 给子进程工具
            args._abortSignal = requestAbort.signal;
            // 执行策略检查（execute_command 专用）
            if (tc.name === 'execute_command') {
              const { execPolicy } = require('./lib/exec-policy');
              const policyResult = execPolicy.check(args.command || '');
              if (policyResult.decision === 'forbidden') {
                result = { error: `[FORBIDDEN] 命令被安全策略禁止: ${args.command}（${policyResult.description}）` };
                isError = true;
              } else if (policyResult.decision === 'prompt') {
                // 三级审批：本次批准 / 本次会话批准 / 拒绝
                logger.log(`[assistant] 命令需确认: ${args.command}（${policyResult.description}）`);
                safeSSE('tool_approval', {
                  id: tc.id, name: tc.name, arguments: args,
                  execPolicy: { decision: 'prompt', matchedRule: policyResult.matchedRule, description: policyResult.description },
                });
                const approved = await requestToolApproval(tc.id, tc.name, args);
                if (approved === 'session') {
                  execPolicy.approveForSession(policyResult.matchedRule || args.command.split(' ').slice(0, 2).join(' '));
                  logger.log(`[exec-policy] 会话批准: ${policyResult.matchedRule || args.command}`);
                } else if (!approved) {
                  result = { error: '用户拒绝执行此命令' };
                  isError = true;
                }
              }
              // 'allow' → 直接执行，跳过权限级别检查
            }

            if (!isError && tc.name !== 'execute_command') {
              // 权限检查（非 execute_command）
              const toolLevel = tc.name.startsWith('mcp__')
                ? (() => { const parts = tc.name.split('__'); const cfg = mcpClient.getServerConfig(parts[1]); return cfg?.dangerous ? 3 : 1; })()
                : (TOOL_PERMISSION[tc.name] || 2);
              const currentLevel = parseInt(req.body.permissionLevel) || 3;
              if (toolLevel > currentLevel) {
                result = { error: `权限不足: ${tc.name} 需要级别 ${toolLevel}，当前级别 ${currentLevel}` };
                isError = true;
              } else if (currentLevel === 3 && toolLevel === 3) {
                // 级别 3 + 危险工具 → 请求用户确认
                logger.log(`[assistant] 工具 ${tc.name} 需要用户确认`);
                safeSSE('tool_approval', { id: tc.id, name: tc.name, arguments: args });
                const approved = await requestToolApproval(tc.id, tc.name, args);
                if (!approved) {
                  result = { error: '用户拒绝执行此工具' };
                  isError = true;
                }
              }
            }
            if (!isError) {
              // 缓存命中检查（仅限只读工具）
              const cacheKey = isCacheable(tc.name) ? makeCacheKey(tc.name, args) : null;
              const cached = cacheKey ? toolResultCache.get(cacheKey) : undefined;
              if (cached !== undefined) {
                result = cached;
                logger.log(`[assistant] tool ${tc.name} cache hit`);
              } else {
                startProgress('tool', { name: tc.name, round });
                const mcpHandler = tc.name.startsWith('mcp__') ? mcpClient.getToolHandlerMap()[tc.name] : null;
                if (mcpHandler) {
                  const toolStart = Date.now();
                  result = await mcpHandler(args);
                  const latencyMs = Date.now() - toolStart;
                  const parts = tc.name.split('__');
                  mcpToolStats.record(parts[1], parts[2], latencyMs, !(result && result.error));
                } else {
                  if (['execute_code', 'parse_document', 'text_to_speech', 'generate_music', 'generate_video', 'generate_image', 'access_file', 'audio_analyze'].includes(tc.name)) args._convId = convId;
                  const mmHandler = _mmTools.handlers[tc.name];
                  const handler = TOOL_HANDLERS[tc.name] || mmHandler;
                  result = handler ? await handler(args) : { error: `未知工具: ${tc.name}` };
                }
                if (result && result.error) isError = true;
                // 缓存成功的只读结果
                if (cacheKey && !isError) toolResultCache.set(cacheKey, result);
              }
            }
          } catch (err) {
            logger.log(`[assistant] tool ${tc.name} error: ${err.message}`);
            result = { error: err.message };
            isError = true;
          }
          // 媒体提取：图片/音频/视频发给前端展示，同时保存图片到 conv-files 供 vision API 使用
          let toolImages = null;
          if (result && result.images) {
            // 保存图片到 conv-files 目录，转为文件名引用
            if (convId && result.images.length > 0) {
              const dir = getConvFilesPath(convId);
              fs.mkdirSync(dir, { recursive: true });
              for (const img of result.images) {
                const fname = `img_${Date.now()}_${Math.random().toString(36).slice(2, 6)}.png`;
                fs.writeFileSync(path.join(dir, fname), Buffer.from(img.base64_data, 'base64'));
                img._file = fname; // 记录保存的文件名
              }
            }
            toolImages = result.images;
            for (const img of result.images) {
              if (img._file) visionImages.push(img._file);
            }
            // 构造文件名列表告诉 LLM，使其能在回复中引用展示
            const fileNames = toolImages.filter(i => i._file).map(i => i._file);
            delete result.images;
            if (!result.message) result.message = `${tc.name} 成功，已生成 ${toolImages.length} 张图片`;
            if (fileNames.length > 0) result.files = fileNames;
          }
          let toolMedia = null;
          if (result) {
            const media = {};
            if (result.audio_file) { media.audio_file = result.audio_file; delete result.audio_file; }
            if (result.video_file) { media.video_file = result.video_file; delete result.video_file; }
            if (result.video_url) { media.video_url = result.video_url; delete result.video_url; }
            if (Object.keys(media).length > 0) {
              toolMedia = media;
              if (!result.message) result.message = `${tc.name} 成功`;
              // 把文件名/URL 告诉 LLM，使其能在回复中引用展示
              const files = [];
              if (media.audio_file) files.push(media.audio_file);
              if (media.video_file) files.push(media.video_file);
              if (media.video_url) files.push(media.video_url);
              if (files.length > 0) result.files = files;
            }
          }
          result = truncateOutput(result);
          const resultStr = JSON.stringify(result);
          logger.log(`[assistant] tool ${tc.name} done: ${resultStr.length} chars${isError ? ' (error)' : ''}${toolImages ? `, ${toolImages.length} images` : ''}${toolMedia ? `, media` : ''}`);
          safeSSE('tool_result', { tool_call_id: tc.id, name: tc.name, result, is_error: isError, images: toolImages, media: toolMedia });
          // _multimodal 信封：存储多模态 content 数组而非字符串
          if (result && result._multimodal && Array.isArray(result.content)) {
            conv.messages.push({ id: generateMsgId(), role: 'tool', tool_call_id: tc.id, content: result.content, _multimodal: true });
          } else {
            conv.messages.push({ id: generateMsgId(), role: 'tool', tool_call_id: tc.id, content: isError ? `[ERROR] ${resultStr}` : resultStr });
          }
        }
        stopProgress();

        // token 检查 + 压缩
        currentTokens = estimateConversationTokens(buildMessages());
        sendContext();
        if (currentTokens >= MAX_CONTEXT * 0.8) {
          logger.log(`[assistant] 上下文 ${Math.round(currentTokens / MAX_CONTEXT * 100)}%，自动压缩`);
          safeSSE('compressing', {});
          startProgress('compressing');
          const compResult = await compressConversation(conv, MAX_CONTEXT, proxyUrl, proxyHeaders, proxy.defaultModel);
          stopProgress();
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

      // 达到最大轮次 → 总结回复（仅在循环因轮次耗尽而结束时触发，正常 break 不执行）
      if (!loopCompleted) {
        logger.log(`[assistant] max rounds reached, requesting summary`);
        try {
          const summaryRes = await fetch(proxyUrl, {
            method: 'POST',
            headers: proxyHeaders,
            signal: AbortSignal.any([requestAbort.signal, AbortSignal.timeout(120000)]),
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
            const summaryMsgId = generateMsgId();
            const summaryMsg = { id: summaryMsgId, role: 'assistant', content: summaryContent || null };
            if (summaryReasoning) summaryMsg.reasoning_content = summaryReasoning;
            conv.messages.push(summaryMsg);
            safeSSE('done', { reasoning_content: summaryReasoning || undefined, assistantMessageId: summaryMsgId });
          } else {
            safeSSE('done', {});
          }
        } catch {
          safeSSE('done', {});
        }
      }
    } catch (err) {
      logger.log(`[assistant] error: ${err.message}`);
      if (!res.headersSent) {
        res.status(502).json({ error: `助手请求失败: ${err.message}` });
      } else {
        safeSSE('error', { message: err.message });
      }
    } finally {
      stopProgress();
      activeStreams.delete(convId);

      try {
        // 记忆审查：每 N 轮触发一次后台审查（fire-and-forget）
        if (memoryManager.onTurnCompleted()) {
          const { getAgentConfig: _getAgentCfg } = require('./lib/multi-agent');
          memoryManager.triggerReview({
            proxyUrl: _chatProxy.url,
            proxyHeaders: _chatProxy.headers,
            defaultModel: _chatProxy.defaultModel,
            toolHandlers: { ...TOOL_HANDLERS, ..._mmTools.handlers },
            messages: conv.messages,
            config: _getAgentCfg(configStore.getSettings()),
          }).catch(err => logger.warn('[memory] 后台审查调度失败:', err.message));
        }
        conversationStore.touch(conv);
      } catch (err) {
        logger.warn('[assistant] finally 清理异常:', err.message);
      }

      try { res.end(); } catch {}
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
          apiKeys: Array.isArray(p.apiKeys) ? p.apiKeys : [],
          models: Array.isArray(p.models) ? p.models : [],
          adapter: p.adapter || '',
          capabilities: Array.isArray(p.capabilities) ? p.capabilities : [],
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
        apiKeys: Array.isArray(p.apiKeys) ? p.apiKeys : [],
        models: Array.isArray(p.models) ? p.models : [],
        adapter: p.adapter || '',
        capabilities: Array.isArray(p.capabilities) ? p.capabilities : [],
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

  app.get('/api/config/diff', (req, res) => {
    const { from, to } = req.query;
    if (!from || !to) return res.status(400).json({ error: '需要指定 from 和 to 参数' });
    const result = configStore.getVersionDiff(from, to);
    if (result.error) return res.status(400).json({ error: result.error });
    res.json(result);
  });

  // 比较两个版本（支持已清理快照的重建比较）
  app.get('/api/config/diff-version', (req, res) => {
    const { fromVersionId, toVersionId } = req.query;
    if (!fromVersionId || !toVersionId) return res.status(400).json({ error: '需要指定 fromVersionId 和 toVersionId 参数' });
    const fromResult = configStore.reconstructVersion(fromVersionId);
    if (fromResult.error) return res.status(400).json({ error: fromResult.error });
    const toResult = configStore.reconstructVersion(toVersionId);
    if (toResult.error) return res.status(400).json({ error: toResult.error });
    res.json(configStore.diffObjects(fromResult.config, toResult.config, ''));
  });

  app.post('/api/config/rollback', async (req, res) => {
    const { file, versionId } = req.body;
    const result = configStore.restoreSnapshot(file, versionId);
    if (result.error) return res.status(400).json({ error: result.error });
    res.json({ success: true, reconstructed: !!result.reconstructed });
  });

  // ==================== 客户端一键配置 API ====================

  app.get('/api/client-config/detect/:tool', async (req, res) => {
    try {
      const proxies = configStore.getProxies();
      const result = await clientConfig.detectTool(req.params.tool, proxies);
      res.json(result);
    } catch (err) {
      res.json({ ok: false, message: err.message });
    }
  });

  app.post('/api/client-config/install/:tool', async (req, res) => {
    const { method } = req.body || {};
    // SSE for streaming install logs
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    const sendEvent = (data) => {
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    try {
      const result = await clientConfig.installTool(req.params.tool, method || 'npm', (log) => {
        sendEvent({ type: 'log', message: log });
      });
      sendEvent({ type: 'done', ...result });
    } catch (err) {
      sendEvent({ type: 'done', ok: false, message: err.message });
    }
    res.end();
  });

  app.get('/api/client-config/preview/:tool', async (req, res) => {
    try {
      const { proxyId } = req.query;
      if (!proxyId) return res.json({ ok: false, message: '缺少 proxyId' });
      const proxy = configStore.getProxyById(proxyId);
      if (!proxy) return res.json({ ok: false, message: '代理不存在' });

      if (req.params.tool === 'claude-code') {
        res.json(clientConfig.previewClaudeCode(proxy));
      } else if (req.params.tool === 'codex') {
        res.json(clientConfig.previewCodex(proxy));
      } else {
        res.json({ ok: false, message: '未知工具' });
      }
    } catch (err) {
      res.json({ ok: false, message: err.message });
    }
  });

  app.post('/api/client-config/write/:tool', async (req, res) => {
    try {
      const { proxyId } = req.body || {};
      if (!proxyId) return res.json({ ok: false, message: '缺少 proxyId' });
      const proxy = configStore.getProxyById(proxyId);
      if (!proxy) return res.json({ ok: false, message: '代理不存在' });

      if (req.params.tool === 'claude-code') {
        res.json(clientConfig.writeClaudeCode(proxy));
      } else if (req.params.tool === 'codex') {
        res.json(clientConfig.writeCodex(proxy));
      } else {
        res.json({ ok: false, message: '未知工具' });
      }
    } catch (err) {
      res.json({ ok: false, message: err.message });
    }
  });

  app.post('/api/client-config/test', async (req, res) => {
    try {
      const { proxyId } = req.body || {};
      if (!proxyId) return res.json({ ok: false, message: '缺少 proxyId' });
      const proxy = configStore.getProxyById(proxyId);
      if (!proxy) return res.json({ ok: false, message: '代理不存在' });
      if (!proxy.running) return res.json({ ok: false, message: '代理未运行' });
      const result = await clientConfig.testConnection(proxy);
      res.json(result);
    } catch (err) {
      res.json({ ok: false, message: err.message });
    }
  });

  app.get('/api/client-config/backups/:tool', (req, res) => {
    try {
      res.json({ ok: true, backups: clientConfig.listBackups(req.params.tool) });
    } catch (err) {
      res.json({ ok: false, message: err.message });
    }
  });

  app.post('/api/client-config/restore/:tool', (req, res) => {
    try {
      const { backupId } = req.body || {};
      if (!backupId) return res.json({ ok: false, message: '缺少 backupId' });
      res.json(clientConfig.restoreBackup(req.params.tool, backupId));
    } catch (err) {
      res.json({ ok: false, message: err.message });
    }
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

    // 注册多 Agent 任务事件广播
    const { registry: taskRegistry } = require('./lib/multi-agent');
    taskRegistry.on('task:created', (task) => wsServer.broadcast({ type: 'task', event: 'created', task }));
    taskRegistry.on('task:started', (task) => wsServer.broadcast({ type: 'task', event: 'started', task }));
    taskRegistry.on('task:completed', (task) => wsServer.broadcast({ type: 'task', event: 'completed', task }));
    taskRegistry.on('task:failed', (task) => wsServer.broadcast({ type: 'task', event: 'failed', task }));
    taskRegistry.on('task:stopped', (task) => wsServer.broadcast({ type: 'task', event: 'stopped', task }));
    taskRegistry.on('task:progress', (data) => wsServer.broadcast({ type: 'task', event: 'progress', ...data }));
    taskRegistry.on('batch:created', (data) => wsServer.broadcast({ type: 'batch', event: 'created', ...data }));

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
    require('./lib/mcp-tool-stats').flush();
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
    require('./lib/mcp-tool-stats').flush();
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
  case 'test': {
    const testArgs = parseArgs(process.argv);
    testProvider(testArgs._[0]).catch(err => {
      console.error('测试失败:', err.message);
      process.exit(1);
    });
    break;
  }
  case 'logs': {
    const logArgs = parseArgs(process.argv);
    showLogs(logArgs).catch(err => {
      console.error('获取日志失败:', err.message);
      process.exit(1);
    });
    break;
  }
  case 'stats': {
    const statsArgs = parseArgs(process.argv);
    showStats(statsArgs).catch(err => {
      console.error('获取统计失败:', err.message);
      process.exit(1);
    });
    break;
  }
  case '--daemon':
    init();
    break;
  case undefined:
    init();
    break;
  case 'autostart': {
    const autostart = require('./lib/autostart');
    const sub = process.argv[3];
    if (!sub || sub === 'status') {
      const info = autostart.isEnabled();
      if (!info.supported) { console.log(info.message); break; }
      console.log(info.enabled ? '开机自启: 已开启' : '开机自启: 已关闭');
      if (info.command) console.log('  注册命令: ' + info.command);
    } else if (sub === 'on') {
      const r = autostart.enable();
      console.log(r.success ? '已设置开机自启' : '设置失败: ' + r.error);
    } else if (sub === 'off') {
      const r = autostart.disable();
      console.log(r.success ? '已取消开机自启' : '取消失败: ' + r.error);
    } else {
      console.log('用法: protocol-proxy autostart [status|on|off]');
    }
    break;
  }
  default:
    console.error(`未知命令: ${cmd}`);
    showHelp();
    process.exit(1);
}
