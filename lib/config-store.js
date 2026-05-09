const fs = require('fs');
const path = require('path');
const os = require('os');

const CONFIG_PATH = path.join(os.homedir(), '.protocol-proxy', 'proxies.json');

// 迁移旧配置（从包目录到用户主目录）
const OLD_CONFIG_PATH = process.pkg
  ? path.join(path.dirname(process.execPath), 'config', 'proxies.json')
  : path.join(__dirname, '..', 'config', 'proxies.json');

function migrateOldConfig() {
  if (fs.existsSync(CONFIG_PATH) || !fs.existsSync(OLD_CONFIG_PATH)) return;
  try {
    const dir = path.dirname(CONFIG_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(OLD_CONFIG_PATH, CONFIG_PATH);
  } catch {}
}
migrateOldConfig();

let configCache = null;

function normalizeModels(models) {
  if (!Array.isArray(models)) return [];
  return Array.from(new Set(
    models.filter(m => typeof m === 'string').map(m => m.trim()).filter(Boolean)
  ));
}

function normalizeProvider(provider) {
  if (!provider) return provider;
  return {
    ...provider,
    models: normalizeModels(provider.models),
  };
}

function normalizeProxy(proxy) {
  if (!proxy) return proxy;
  return proxy;
}

function normalizeConfig(config) {
  const providers = Array.isArray(config?.providers) ? config.providers : [];
  const proxies = Array.isArray(config?.proxies) ? config.proxies : [];
  return {
    ...config,
    providers: providers.map(normalizeProvider),
    proxies: proxies.map(normalizeProxy),
  };
}

function loadConfig() {
  try {
    if (!fs.existsSync(CONFIG_PATH)) {
      configCache = { providers: [], proxies: [] };
      return configCache;
    }
    const raw = fs.readFileSync(CONFIG_PATH, 'utf-8');
    configCache = normalizeConfig(JSON.parse(raw));
    return configCache;
  } catch (err) {
    console.error('加载配置失败:', err.message);
    return configCache || { providers: [], proxies: [] };
  }
}

function saveConfig(config) {
  try {
    const normalizedConfig = normalizeConfig(config);
    const dir = path.dirname(CONFIG_PATH);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(normalizedConfig, null, 2), 'utf-8');
    configCache = normalizedConfig;
    return true;
  } catch (err) {
    console.error('保存配置失败:', err.message);
    return false;
  }
}

// ==================== 供应商 CRUD ====================

function getProviders() {
  return loadConfig().providers || [];
}

function getProviderById(id) {
  return getProviders().find(p => p.id === id);
}

function addProvider(provider) {
  const config = loadConfig();
  config.providers = config.providers || [];
  provider.id = provider.id || 'provider-' + Date.now();
  provider.models = normalizeModels(provider.models);
  config.providers.push(provider);
  saveConfig(config);
  return provider;
}

function updateProvider(id, updates) {
  const config = loadConfig();
  const idx = (config.providers || []).findIndex(p => p.id === id);
  if (idx === -1) return null;
  if (updates.models !== undefined) {
    updates.models = normalizeModels(updates.models);
  }
  config.providers[idx] = { ...config.providers[idx], ...updates, id };
  saveConfig(config);
  return config.providers[idx];
}

function removeProvider(id) {
  const config = loadConfig();
  const idx = (config.providers || []).findIndex(p => p.id === id);
  if (idx === -1) return null;
  const removed = config.providers.splice(idx, 1)[0];
  saveConfig(config);
  return removed;
}

// ==================== 代理 CRUD ====================

function getProxies() {
  return loadConfig().proxies || [];
}

function getProxyById(id) {
  return getProxies().find(p => p.id === id);
}

function addProxy(proxy) {
  const config = loadConfig();
  config.proxies = config.proxies || [];
  proxy.id = proxy.id || 'proxy-' + Date.now();
  config.proxies.push(proxy);
  saveConfig(config);
  return proxy;
}

function updateProxy(id, updates) {
  const config = loadConfig();
  const idx = (config.proxies || []).findIndex(p => p.id === id);
  if (idx === -1) return null;
  config.proxies[idx] = { ...config.proxies[idx], ...updates, id };
  saveConfig(config);
  return config.proxies[idx];
}

function removeProxy(id) {
  const config = loadConfig();
  const idx = (config.proxies || []).findIndex(p => p.id === id);
  if (idx === -1) return null;
  const removed = config.proxies.splice(idx, 1)[0];
  saveConfig(config);
  return removed;
}

module.exports = {
  loadConfig,
  saveConfig,
  getProviders,
  getProviderById,
  addProvider,
  updateProvider,
  removeProvider,
  getProxies,
  getProxyById,
  addProxy,
  updateProxy,
  removeProxy,
};
