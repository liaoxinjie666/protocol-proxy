const { Client } = require('@modelcontextprotocol/sdk/client');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
const { SSEClientTransport } = require('@modelcontextprotocol/sdk/client/sse.js');
const crypto = require('crypto');
const configStore = require('./config-store');

const CALL_TIMEOUT = 30000;
const INITIALIZE_TIMEOUT = 60000;  // 首次连接需要下载依赖，延长超时
const LIST_TOOLS_TIMEOUT = 30000;
const MAX_RECONNECT_ATTEMPTS = 10;
const BASE_RECONNECT_DELAY = 5000;
const MAX_RECONNECT_DELAY = 60000;

// Map<name, { client, transport, config, status, tools, lastError, reconnectTimer, reconnectAttempts }>
const servers = new Map();
let onUpdateCallback = null;
let _defsCache = null;
let _handlerCache = null;

function sanitizeName(name) {
  return name.replace(/[^a-zA-Z0-9_-]/g, '_').replace(/-/g, '_');
}

function notifyUpdate(name) {
  _defsCache = null;
  _handlerCache = null;
  const entry = servers.get(name);
  if (onUpdateCallback && entry) {
    onUpdateCallback(name, {
      status: entry.status,
      toolCount: entry.tools.length,
      lastError: entry.lastError,
    });
  }
}

function createTransport(name, config) {
  if (config.url) {
    const url = new URL(config.url);
    const opts = {};
    if (config.headers && Object.keys(config.headers).length) {
      opts.requestInit = { headers: config.headers };
    }
    // 检测 SSE 端点（高德等使用 /sse 路径的服务）
    if (config.url.includes('/sse')) {
      console.log(`[mcp] ${name} 使用 SSE 传输模式`);
      return new SSEClientTransport(url, opts);
    }
    return new StreamableHTTPClientTransport(url, opts);
  }
  if (config.command) {
    return new StdioClientTransport({
      command: config.command,
      args: config.args || [],
      env: config.env ? { ...process.env, ...config.env } : undefined,
      cwd: config.cwd || undefined,
    });
  }
  throw new Error('MCP 服务器配置需要 command（本地进程）或 url（远程 HTTP）');
}

async function connectServer(name, config) {
  let entry = servers.get(name);
  if (entry) {
    // 清理旧连接
    if (entry.reconnectTimer) {
      clearTimeout(entry.reconnectTimer);
      entry.reconnectTimer = null;
    }
    try {
      if (entry.client) await entry.client.close().catch(() => {});
    } catch (closeErr) { console.warn(`[mcp] 关闭旧连接 ${name} 失败: ${closeErr.message}`); }
  }

  entry = {
    client: null,
    transport: null,
    config,
    status: 'connecting',
    tools: [],
    lastError: null,
    lastConnected: null,
    reconnectTimer: null,
    reconnectAttempts: 0,
    configHash: null,
  };
  servers.set(name, entry);
  notifyUpdate(name);

  const connectWithRetry = async (transport, client, retries = 1) => {
    const errors = [];
    for (let i = 0; i <= retries; i++) {
      try {
        if (i > 0) console.log(`[mcp] ${name} 正在重连（第 ${i} 次）...`);
        await Promise.race([
          client.connect(transport),
          new Promise((_, rej) => setTimeout(() => rej(new Error(`握手超时（${INITIALIZE_TIMEOUT / 1000}s）`)), INITIALIZE_TIMEOUT))
        ]);
        return true;
      } catch (err) {
        errors.push(err.message);
        // 如果是 stdio 模式且首次超时，可能是正在下载依赖，给一次重试机会
        if (config.command && i < retries && err.message.includes('超时')) {
          console.log(`[mcp] ${name} 首次连接超时，可能是正在下载依赖，将重试...`);
          continue;
        }
        throw err;
      }
    }
    throw new Error(errors.join('; '));
  };

  try {
    const transport = createTransport(name, config);
    const client = new Client(
      { name: 'protocol-proxy', version: '1.0.0' },
      { capabilities: {} }
    );

    await connectWithRetry(transport, client, 1);

    // 列出工具
    let allTools = [];
    let cursor;
    do {
      try {
        const result = await Promise.race([
          client.listTools(cursor ? { cursor } : undefined),
          new Promise((_, rej) => setTimeout(() => rej(new Error(`列出工具超时（${LIST_TOOLS_TIMEOUT / 1000}s）`)), LIST_TOOLS_TIMEOUT))
        ]);
        allTools = allTools.concat(result.tools || []);
        cursor = result.nextCursor;
      } catch (err) {
        throw new Error(`列出工具失败: ${err.message}`);
      }
    } while (cursor);

    entry.client = client;
    entry.transport = transport;
    entry.tools = allTools;
    entry.status = 'connected';
    entry.lastConnected = new Date();
    entry.lastError = null;
    entry.reconnectAttempts = 0;
    entry.configHash = configHashFn(config);

    console.log(`[mcp] 已连接 ${name}: ${allTools.length} 个工具`);
    notifyUpdate(name);
    return allTools;
  } catch (err) {
    entry.status = 'error';
    entry.lastError = err.message;
    console.error(`[mcp] 连接 ${name} 失败: ${err.message}`);
    notifyUpdate(name);
    throw err;
  }
}

async function disconnectServer(name) {
  const entry = servers.get(name);
  if (!entry) return;

  if (entry.reconnectTimer) {
    clearTimeout(entry.reconnectTimer);
    entry.reconnectTimer = null;
  }

  try {
    if (entry.client) await entry.client.close().catch(() => {});
  } catch (closeErr) { console.warn(`[mcp] 断开 ${name} 时关闭连接失败: ${closeErr.message}`); }

  entry.status = 'disconnected';
  entry.client = null;
  entry.transport = null;
  entry.tools = [];
  console.log(`[mcp] 已断开 ${name}`);
  notifyUpdate(name);
}

async function reconnectServer(name) {
  const entry = servers.get(name);
  if (!entry) return;
  const config = entry.config;
  entry.reconnectAttempts = 0;
  await disconnectServer(name);
  await connectServer(name, config);
}

function scheduleReconnect(name) {
  const entry = servers.get(name);
  if (!entry || entry.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) return;

  if (entry.reconnectTimer) {
    clearTimeout(entry.reconnectTimer);
    entry.reconnectTimer = null;
  }

  const delay = Math.min(BASE_RECONNECT_DELAY * Math.pow(2, entry.reconnectAttempts), MAX_RECONNECT_DELAY);
  entry.reconnectTimer = setTimeout(async () => {
    entry.reconnectAttempts++;
    try {
      await connectServer(name, entry.config);
    } catch {
      scheduleReconnect(name);
    }
  }, delay);
  console.log(`[mcp] ${name} 将在 ${Math.round(delay / 1000)}s 后重连 (第 ${entry.reconnectAttempts + 1} 次)`);
}

async function callTool(serverName, toolName, args) {
  const entry = servers.get(serverName);
  if (!entry || entry.status !== 'connected' || !entry.client) {
    return { error: `MCP 服务 "${serverName}" 未连接` };
  }

  try {
    const controller = new AbortController();
    const callTimeout = entry.config.toolCallTimeoutMs || CALL_TIMEOUT;
    const timer = setTimeout(() => controller.abort(), callTimeout);

    let result;
    try {
      result = await entry.client.callTool({ name: toolName, arguments: args }, undefined, { signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }

    if (result.isError) {
      const text = (result.content || []).map(c => c.text || JSON.stringify(c)).join('\n');
      return { error: text || 'MCP 工具执行失败' };
    }

    const text = (result.content || []).map(c => {
      if (c.type === 'text') return c.text;
      return JSON.stringify(c);
    }).join('\n');

    try { return JSON.parse(text); } catch { return { result: text }; }
  } catch (err) {
    if (err.name === 'AbortError') {
      const timeout = entry.config.toolCallTimeoutMs || CALL_TIMEOUT;
      return { error: `MCP 工具调用超时 (${timeout / 1000}s)` };
    }
    // 连接断开时尝试重连
    if (entry.status === 'connected') {
      entry.status = 'error';
      entry.lastError = err.message;
      notifyUpdate(serverName);
      scheduleReconnect(serverName);
    }
    return { error: `MCP 工具调用失败: ${err.message}` };
  }
}

function fixSchemaType(schema) {
  if (!schema || typeof schema !== 'object') return schema;
  // 修复非法的类型值
  if (schema.type === 'bool') schema.type = 'boolean';
  // 修复 properties 中每个属性的 type
  if (schema.properties && typeof schema.properties === 'object') {
    for (const key of Object.keys(schema.properties)) {
      const prop = schema.properties[key];
      if (prop && prop.type === 'bool') prop.type = 'boolean';
      // 递归修复嵌套属性
      if (prop && prop.properties) fixSchemaType(prop);
      // 修复 items
      if (prop && prop.items && prop.items.type === 'bool') prop.items.type = 'boolean';
    }
  }
  return schema;
}

function getToolDefinitions() {
  if (_defsCache) return _defsCache;
  const defs = [];
  for (const [serverName, entry] of servers) {
    if (entry.status !== 'connected') continue;
    const prefix = `mcp__${sanitizeName(serverName)}__`;
    for (const tool of entry.tools) {
      const rawSchema = tool.inputSchema || {};
      const schema = fixSchemaType(JSON.parse(JSON.stringify(rawSchema)));  // 深拷贝避免修改原对象
      defs.push({
        type: 'function',
        function: {
          name: `${prefix}${tool.name}`,
          description: `[MCP:${serverName}] ${tool.description || tool.name}`,
          parameters: {
            type: schema.type || 'object',
            properties: schema.properties || {},
            required: schema.required || [],
          },
        },
      });
    }
  }
  _defsCache = defs;
  return defs;
}

function getToolHandlerMap() {
  if (_handlerCache) return _handlerCache;
  const map = {};
  for (const [serverName, entry] of servers) {
    if (entry.status !== 'connected') continue;
    const prefix = `mcp__${sanitizeName(serverName)}__`;
    for (const tool of entry.tools) {
      const fullName = `${prefix}${tool.name}`;
      const sn = serverName;
      const tn = tool.name;
      map[fullName] = (args) => callTool(sn, tn, args);
    }
  }
  _handlerCache = map;
  return map;
}

function getStatus() {
  return Array.from(servers.entries()).map(([name, entry]) => ({
    name,
    status: entry.status,
    tools: entry.tools.map(t => ({ name: t.name, description: t.description || '' })),
    lastError: entry.lastError,
    lastConnected: entry.lastConnected,
    transport: entry.config?.url ? 'http' : 'stdio',
  }));
}

function getServerStatus(name) {
  const entry = servers.get(name);
  return entry ? entry.status : null;
}

function refreshTools() {
  _defsCache = null;
  _handlerCache = null;
  return {
    definitions: getToolDefinitions(),
    handlers: getToolHandlerMap(),
  };
}

function configHashFn(config) {
  return crypto.createHash('md5').update(JSON.stringify(config)).digest('hex');
}

async function reconnectIfChanged(name, newConfig) {
  const entry = servers.get(name);
  if (!entry) {
    await connectServer(name, newConfig);
    return { changed: true };
  }
  const newHash = configHashFn(newConfig);
  if (entry.configHash && entry.configHash === newHash) {
    console.log(`[mcp] ${name} 配置未变更，跳过重连`);
    return { changed: false };
  }
  await reconnectServer(name);
  return { changed: true };
}

async function init({ onUpdate } = {}) {
  onUpdateCallback = onUpdate || null;

  const mcpServers = configStore.getMcpServers();
  const names = Object.keys(mcpServers);

  if (names.length === 0) {
    console.log('[mcp] 未配置 MCP 服务器');
    return;
  }

  console.log(`[mcp] 正在连接 ${names.length} 个 MCP 服务器...`);

  const results = await Promise.allSettled(
    names.map(name => {
      const config = mcpServers[name];
      if (config.enabled === false) {
        servers.set(name, {
          client: null, transport: null, config, status: 'disconnected',
          tools: [], lastError: null, lastConnected: null,
          reconnectTimer: null, reconnectAttempts: 0, configHash: null,
        });
        return Promise.resolve();
      }
      return connectServer(name, config).catch(() => {});
    })
  );

  const connected = results.filter(r => r.status === 'fulfilled' && r.value).length;
  console.log(`[mcp] 初始化完成: ${connected}/${names.length} 已连接`);
}

async function shutdown() {
  for (const [name, entry] of servers) {
    if (entry.reconnectTimer) {
      clearTimeout(entry.reconnectTimer);
      entry.reconnectTimer = null;
    }
    try {
      if (entry.client) await entry.client.close().catch(() => {});
    } catch (closeErr) { console.warn(`[mcp] 关闭 ${name} 失败: ${closeErr.message}`); }
  }
  servers.clear();
  _defsCache = null;
  _handlerCache = null;
  console.log('[mcp] 已关闭所有 MCP 连接');
}

module.exports = {
  init,
  connectServer,
  disconnectServer,
  reconnectServer,
  reconnectIfChanged,
  callTool,
  getToolDefinitions,
  getToolHandlerMap,
  getStatus,
  getServerStatus,
  refreshTools,
  shutdown,
};
