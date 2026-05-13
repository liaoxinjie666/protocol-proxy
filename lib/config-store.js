const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

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
  } catch (err) { console.error('[Config] 迁移旧配置失败:', err.message); }
}
migrateOldConfig();

let configCache = null;

// 迁移旧格式：target → providerId
function migrateTargetToProvider(config) {
  if (!Array.isArray(config.proxies)) return config;
  let changed = false;

  for (const proxy of config.proxies) {
    if (!proxy.target) continue;

    // 有 target 但没有 providerId → 从 target 创建供应商
    if (!proxy.providerId) {
      const t = proxy.target;
      const provider = {
        id: crypto.randomUUID(),
        name: t.providerName || t.providerUrl,
        url: t.providerUrl,
        protocol: t.protocol || 'openai',
        apiKey: t.apiKey || '',
        apiKeys: t.apiKey ? [{ key: t.apiKey, alias: '' }] : [],
        models: Array.isArray(t.models) ? t.models : [],
      };
      config.providers = config.providers || [];
      config.providers.push(provider);
      proxy.providerId = provider.id;
      proxy.defaultModel = t.defaultModel || '';
      delete proxy.target;
      changed = true;
    } else {
      // 有 target 也有 providerId → 迁移 apiKey 到供应商，删除 target
      const provider = (config.providers || []).find(p => p.id === proxy.providerId);
      if (provider && proxy.target.apiKey && !provider.apiKey) {
        provider.apiKey = proxy.target.apiKey;
        changed = true;
      }
      delete proxy.target;
      changed = true;
    }
  }

  if (changed) {
    configCache = config;
    saveConfig(config);
  }
  return config;
}

function normalizeModels(models) {
  if (!Array.isArray(models)) return [];
  return Array.from(new Set(
    models.filter(m => typeof m === 'string').map(m => m.trim()).filter(Boolean)
  ));
}

function normalizeRoutingStrategy(strategy) {
  return ['primary_fallback', 'round_robin', 'weighted', 'fastest'].includes(strategy)
    ? strategy
    : 'primary_fallback';
}

function normalizeProviderPool(pool) {
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

function normalizeApiKeys(provider) {
  // apiKeys 数组优先，apiKey 作为 fallback
  // 统一输出为 { key, alias } 格式
  if (Array.isArray(provider.apiKeys) && provider.apiKeys.length > 0) {
    return provider.apiKeys
      .map(k => {
        if (typeof k === 'string' && k.trim()) return { key: k.trim(), alias: '' };
        if (k && typeof k === 'object' && typeof k.key === 'string' && k.key.trim()) {
          return { key: k.key.trim(), alias: typeof k.alias === 'string' ? k.alias.trim() : '', enabled: k.enabled !== false };
        }
        return null;
      })
      .filter(Boolean);
  }
  if (provider.apiKey && typeof provider.apiKey === 'string' && provider.apiKey.trim()) {
    return [{ key: provider.apiKey.trim(), alias: '' }];
  }
  return [];
}

function normalizeProvider(provider) {
  if (!provider) return provider;
  return {
    ...provider,
    models: normalizeModels(provider.models),
    apiKeys: normalizeApiKeys(provider),
  };
}

function normalizeProxy(proxy) {
  if (!proxy) return proxy;
  return {
    ...proxy,
    routingStrategy: normalizeRoutingStrategy(proxy.routingStrategy),
    providerPool: normalizeProviderPool(proxy.providerPool),
  };
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
      configCache = { providers: [], proxies: [], settings: {} };
      return configCache;
    }
    const raw = fs.readFileSync(CONFIG_PATH, 'utf-8');
    let config = normalizeConfig(JSON.parse(raw));
    config = migrateTargetToProvider(config);
    if (!config.settings) config.settings = {};
    configCache = config;
    return configCache;
  } catch (err) {
    console.error('加载配置失败:', err.message);
    return configCache || { providers: [], proxies: [], settings: {} };
  }
}

function getSettings() {
  return loadConfig().settings || {};
}

function setSetting(key, value) {
  const config = loadConfig();
  if (!config.settings) config.settings = {};
  config.settings[key] = value;
  saveConfig(config);
}

const SNAPSHOT_DIR = path.join(os.homedir(), '.protocol-proxy', 'snapshots');
const MAX_SNAPSHOTS = 30;

function saveConfig(config) {
  try {
    const normalizedConfig = normalizeConfig(config);
    const dir = path.dirname(CONFIG_PATH);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const tmpPath = CONFIG_PATH + '.tmp';
    fs.writeFileSync(tmpPath, JSON.stringify(normalizedConfig, null, 2), 'utf-8');
    fs.renameSync(tmpPath, CONFIG_PATH);
    configCache = normalizedConfig;
    return true;
  } catch (err) {
    console.error('保存配置失败:', err.message);
    return false;
  }
}

function saveSnapshot(reason) {
  try {
    if (!fs.existsSync(CONFIG_PATH)) return;
    if (!fs.existsSync(SNAPSHOT_DIR)) fs.mkdirSync(SNAPSHOT_DIR, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const name = `${ts}_${reason || 'save'}.json`;
    fs.copyFileSync(CONFIG_PATH, path.join(SNAPSHOT_DIR, name));
    // 清理旧快照
    const files = fs.readdirSync(SNAPSHOT_DIR)
      .filter(f => f.endsWith('.json'))
      .sort();
    while (files.length > MAX_SNAPSHOTS) {
      const oldest = files.shift();
      fs.unlinkSync(path.join(SNAPSHOT_DIR, oldest));
    }
  } catch (err) {
    console.error('[Snapshot] 保存快照失败:', err.message);
  }
}

function getSnapshots() {
  try {
    if (!fs.existsSync(SNAPSHOT_DIR)) return [];
    return fs.readdirSync(SNAPSHOT_DIR)
      .filter(f => f.endsWith('.json'))
      .sort().reverse()
      .map(f => {
        const fullPath = path.join(SNAPSHOT_DIR, f);
        const stat = fs.statSync(fullPath);
        const name = f.replace('.json', '');
        const [ts, ...reasonParts] = name.split('_');
        return {
          file: f,
          timestamp: stat.mtime.toISOString(),
          reason: reasonParts.join('_') || 'save',
          size: stat.size,
        };
      });
  } catch (err) {
    console.error('[Snapshot] 读取快照列表失败:', err.message);
    return [];
  }
}

function restoreSnapshot(file) {
  try {
    if (!/^[\w\-]+\.json$/.test(file)) return { error: '非法文件名' };
    const snapshotPath = path.join(SNAPSHOT_DIR, file);
    if (!fs.existsSync(snapshotPath)) return { error: '快照不存在' };
    const content = fs.readFileSync(snapshotPath, 'utf-8');
    const config = JSON.parse(content);
    // 先对当前配置做快照，以便回滚本次操作
    saveSnapshot('before-rollback');
    saveConfig(config);
    return { success: true };
  } catch (err) {
    console.error('[Snapshot] 恢复快照失败:', err.message);
    return { error: err.message };
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
  provider.id = provider.id || crypto.randomUUID();
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
  if (updates.apiKeys !== undefined) {
    updates.apiKeys = Array.isArray(updates.apiKeys)
      ? updates.apiKeys
          .map(k => {
            if (typeof k === 'string' && k.trim()) return { key: k.trim(), alias: '' };
            if (k && typeof k === 'object' && typeof k.key === 'string' && k.key.trim()) {
              return { key: k.key.trim(), alias: typeof k.alias === 'string' ? k.alias.trim() : '', enabled: k.enabled !== false };
            }
            return null;
          })
          .filter(Boolean)
      : [];
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
  proxy.id = proxy.id || crypto.randomUUID();
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
  saveSnapshot,
  getSnapshots,
  restoreSnapshot,
  getSettings,
  setSetting,
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
  normalizeRoutingStrategy,
  normalizeProviderPool,
};
