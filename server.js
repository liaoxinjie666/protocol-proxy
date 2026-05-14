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
  app.use(express.json());

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
        const testModel = req.body.model || 'claude-3-haiku-20240307';
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
