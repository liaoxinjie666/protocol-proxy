#!/usr/bin/env node
const path = require('path');
const { exec, spawn } = require('child_process');
const os = require('os');
const fs = require('fs');

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
      if (err) console.error('[Browser] 打开浏览器失败:', err.message);
    });
  }

  app.use(cors());
  app.use(express.json());

  // 访问日志
  app.use((req, res, next) => {
    const start = Date.now();
    res.on('finish', () => {
      const duration = Date.now() - start;
      console.log(`[HTTP] ${req.method} ${req.path} - ${res.statusCode} (${duration}ms)`);
    });
    next();
  });

  app.use(express.static(path.join(__dirname, 'public')));

  // ==================== 辅助函数 ====================

  function resolveTarget(proxy) {
    const provider = configStore.getProviderById(proxy.providerId);
    if (!provider) return null;
    return {
      providerUrl: provider.url,
      providerName: provider.name,
      protocol: provider.protocol,
      apiKey: provider.apiKey,
      defaultModel: proxy.defaultModel,
      models: provider.models,
    };
  }

  async function startProxyWithProvider(proxy) {
    const target = resolveTarget(proxy);
    if (!target) throw new Error(`供应商 ${proxy.providerId} 不存在`);
    const proxyConfig = { ...proxy, target };
    return proxyManager.startProxy(proxyConfig);
  }

  // ==================== 供应商 API ====================

  app.get('/api/providers', (req, res) => {
    const providers = configStore.getProviders().map(p => ({
      ...p,
      apiKey: p.apiKey ? '***' : '',
    }));
    res.json(providers);
  });

  app.get('/api/providers/:id', (req, res) => {
    const provider = configStore.getProviderById(req.params.id);
    if (!provider) return res.status(404).json({ error: 'Provider not found' });
    res.json({ ...provider, apiKey: provider.apiKey ? '***' : '' });
  });

  app.post('/api/providers', (req, res) => {
    const { name, url, protocol, apiKey, models } = req.body;
    if (!name || !url) {
      return res.status(400).json({ error: 'name and url are required' });
    }
    const provider = configStore.addProvider({
      name, url,
      protocol: protocol || (/anthropic/i.test(url) ? 'anthropic' : 'openai'),
      apiKey: apiKey || '',
      models: models || [],
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
    if (req.body.models !== undefined) updates.models = req.body.models;

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
        hasApiKey: !!provider?.apiKey,
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
      hasApiKey: !!provider?.apiKey,
    });
  });

  // 创建代理
  app.post('/api/proxies', async (req, res) => {
    const { name, port, requireAuth, authToken, providerId, defaultModel } = req.body;

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

  // 前端首页
  app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
  });

  // 启动
  writePid();

  // 启动所有已配置的代理
  const proxies = configStore.getProxies();
  await Promise.all(proxies.map(async (proxy) => {
    try {
      await startProxyWithProvider(proxy);
    } catch (err) {
      console.error(`[Init] Failed to start proxy ${proxy.name}:`, err.message);
    }
  }));

  app.listen(PORT, () => {
    const adminUrl = `http://localhost:${PORT}`;
    console.log(`[Admin] Management server running on ${adminUrl}`);
    console.log(`[Admin] ${proxies.length} proxy config(s) loaded`);
    openBrowser(adminUrl);
  });
}

// 优雅关闭
process.on('SIGINT', async () => {
  console.log('\nShutting down...');
  removePid();
  try {
    const proxyManager = require('./lib/proxy-manager');
    await proxyManager.stopAll();
  } catch (err) {
    console.error('[Shutdown] stopAll error:', err.message);
  }
  process.exit(0);
});

process.on('SIGTERM', async () => {
  removePid();
  try {
    const proxyManager = require('./lib/proxy-manager');
    await proxyManager.stopAll();
  } catch (err) {
    console.error('[Shutdown] stopAll error:', err.message);
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
