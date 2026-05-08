const fs = require('fs');
const path = require('path');

const BASE_DIR = process.pkg
  ? path.dirname(process.execPath)
  : path.join(__dirname, '..');
const CONFIG_PATH = path.join(BASE_DIR, 'config', 'proxies.json');

let configCache = null;

function normalizeModels(target) {
  if (!target) return target;
  const models = Array.isArray(target.models) ? target.models : [];
  const normalized = models
    .filter(model => typeof model === 'string')
    .map(model => model.trim())
    .filter(Boolean);

  if (target.defaultModel && !normalized.includes(target.defaultModel)) {
    normalized.unshift(target.defaultModel);
  }

  return {
    ...target,
    models: Array.from(new Set(normalized)),
  };
}

function normalizeProxy(proxy) {
  if (!proxy) return proxy;
  return {
    ...proxy,
    target: normalizeModels(proxy.target),
  };
}

function normalizeConfig(config) {
  const proxies = Array.isArray(config?.proxies) ? config.proxies : [];
  return {
    ...config,
    proxies: proxies.map(normalizeProxy),
  };
}

function loadConfig() {
  try {
    if (!fs.existsSync(CONFIG_PATH)) {
      configCache = { proxies: [] };
      return configCache;
    }
    const raw = fs.readFileSync(CONFIG_PATH, 'utf-8');
    configCache = normalizeConfig(JSON.parse(raw));
    return configCache;
  } catch (err) {
    console.error('加载配置失败:', err.message);
    return configCache || { proxies: [] };
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
  getProxies,
  getProxyById,
  addProxy,
  updateProxy,
  removeProxy,
};
