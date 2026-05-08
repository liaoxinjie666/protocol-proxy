const { createProxyApp } = require('./proxy-server');

class ProxyManager {
  constructor() {
    this.servers = new Map(); // id -> { app, server, config }
  }

  async startProxy(proxyConfig) {
    const id = proxyConfig.id;

    // 如果已存在，先停止
    if (this.servers.has(id)) {
      await this.stopProxy(id);
    }

    return new Promise((resolve, reject) => {
      const entry = { app: null, server: null, config: proxyConfig };
      const app = createProxyApp(() => entry.config);
      const server = app.listen(proxyConfig.port, () => {
        console.log(`[Proxy] ${proxyConfig.name} started on port ${proxyConfig.port}`);
        entry.app = app;
        entry.server = server;
        this.servers.set(id, entry);
        resolve(true);
      });

      server.on('error', (err) => {
        console.error(`[Proxy] ${proxyConfig.name} error:`, err.message);
        this.servers.delete(id);
        reject(err);
      });
    });
  }

  async stopProxy(id) {
    const entry = this.servers.get(id);
    if (!entry) return false;

    return new Promise((resolve) => {
      entry.server.close(() => {
        console.log(`[Proxy] ${entry.config.name} stopped on port ${entry.config.port}`);
        resolve(true);
      });
      this.servers.delete(id);
    });
  }

  async restartProxy(proxyConfig) {
    await this.stopProxy(proxyConfig.id);
    return this.startProxy(proxyConfig);
  }

  updateProxyConfig(proxyConfig) {
    const entry = this.servers.get(proxyConfig.id);
    if (!entry) return false;
    entry.config = proxyConfig;
    return true;
  }

  isRunning(id) {
    return this.servers.has(id);
  }

  getRunningPorts() {
    return Array.from(this.servers.values()).map(s => ({
      id: s.config.id,
      name: s.config.name,
      port: s.config.port,
    }));
  }

  async stopAll() {
    for (const [id] of this.servers) {
      await this.stopProxy(id);
    }
  }
}

module.exports = new ProxyManager();
