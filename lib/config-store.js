const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const CONFIG_PATH = path.join(os.homedir(), '.protocol-proxy', 'proxies.json');
const PRESETS_PATH = path.join(__dirname, '..', 'config', 'mcp-presets.json');

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
    adapter: typeof provider.adapter === 'string' ? provider.adapter.trim() : '',
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
    mcpServers: config?.mcpServers && typeof config.mcpServers === 'object' ? config.mcpServers : {},
  };
}

function loadConfig() {
  try {
    if (!fs.existsSync(CONFIG_PATH)) {
      configCache = { providers: [], proxies: [], settings: {}, mcpServers: {} };
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
    return configCache || { providers: [], proxies: [], settings: {}, mcpServers: {} };
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
const DIFFS_DIR = path.join(os.homedir(), '.protocol-proxy', 'diffs');
const META_PATH = path.join(SNAPSHOT_DIR, 'meta.json');
const MAX_SNAPSHOTS = 50;

// ==================== 版本链管理 ====================

function loadMeta() {
  try {
    if (!fs.existsSync(META_PATH)) return { versions: [] };
    return JSON.parse(fs.readFileSync(META_PATH, 'utf-8'));
  } catch {
    return { versions: [] };
  }
}

function saveMeta(meta) {
  try {
    if (!fs.existsSync(SNAPSHOT_DIR)) fs.mkdirSync(SNAPSHOT_DIR, { recursive: true });
    const tmpPath = META_PATH + '.tmp';
    fs.writeFileSync(tmpPath, JSON.stringify(meta, null, 2), 'utf-8');
    fs.renameSync(tmpPath, META_PATH);
  } catch (err) {
    console.error('[Version] 保存版本元数据失败:', err.message);
  }
}

// 从已有快照文件自动构建版本链（向后兼容）
function initVersionChain() {
  if (!fs.existsSync(SNAPSHOT_DIR)) return;
  const meta = loadMeta();

  // 已有链，检查是否需要补充新字段（向后兼容）
  if (meta.versions && meta.versions.length > 0) {
    let needsSave = false;
    for (const v of meta.versions) {
      if (v.hasSnapshot === undefined) { v.hasSnapshot = true; needsSave = true; }
      if (v.diffFile === undefined) { v.diffFile = null; needsSave = true; }
    }
    if (needsSave) saveMeta(meta);
    return;
  }

  const files = fs.readdirSync(SNAPSHOT_DIR)
    .filter(f => f.endsWith('.json') && f !== 'meta.json')
    .sort(); // 按时间正序

  meta.versions = [];
  let prevId = null;
  for (const f of files) {
    const name = f.replace('.json', '');
    const [ts, ...reasonParts] = name.split('_');
    const reason = reasonParts.join('_') || 'save';
    const entry = {
      id: name,
      file: f,
      reason,
      timestamp: ts,
      parentId: prevId,
      summary: '',
      diffFile: null,     // 旧版本无差异记录
      hasSnapshot: true,  // 文件存在
    };
    // 尝试生成摘要
    try {
      const content = JSON.parse(fs.readFileSync(path.join(SNAPSHOT_DIR, f), 'utf-8'));
      entry.summary = generateSummary(content, null, reason);
    } catch { /* ignore */ }
    meta.versions.push(entry);
    prevId = name;
  }
  if (meta.versions.length > 0) saveMeta(meta);
}

// 生成变更摘要
function generateSummary(newConfig, oldConfig, reason) {
  const parts = [];
  const reasonMap = {
    'create-proxy': '创建代理',
    'update-proxy': '更新代理',
    'delete-proxy': '删除代理',
    'import-overwrite': '导入覆盖',
    'import-merge': '导入合并',
    'before-rollback': '回滚前保存',
    'save': '手动保存',
  };
  parts.push(reasonMap[reason] || reason);

  if (oldConfig) {
    const provDiff = (newConfig.providers || []).length - (oldConfig.providers || []).length;
    const proxyDiff = (newConfig.proxies || []).length - (oldConfig.proxies || []).length;
    if (provDiff > 0) parts.push(`+${provDiff}供应商`);
    if (provDiff < 0) parts.push(`${provDiff}供应商`);
    if (proxyDiff > 0) parts.push(`+${proxyDiff}代理`);
    if (proxyDiff < 0) parts.push(`${proxyDiff}代理`);

    // 检测具体变更
    for (const newProxy of (newConfig.proxies || [])) {
      const oldProxy = (oldConfig.proxies || []).find(p => p.id === newProxy.id);
      if (!oldProxy) {
        parts.push(`新增代理:${newProxy.name || newProxy.id}`);
      }
    }
    for (const oldProxy of (oldConfig.proxies || [])) {
      if (!(newConfig.proxies || []).find(p => p.id === oldProxy.id)) {
        parts.push(`删除代理:${oldProxy.name || oldProxy.id}`);
      }
    }
  } else {
    parts.push(`${(newConfig.providers || []).length}供应商, ${(newConfig.proxies || []).length}代理`);
  }
  return parts.join(', ');
}

// 深度对比两个对象，生成结构化 diff
// 对含 id 字段的数组按 id 匹配，其余按索引对比
function diffObjects(oldObj, newObj, prefix) {
  const result = { added: [], removed: [], changed: [] };
  const allKeys = new Set([...Object.keys(oldObj || {}), ...Object.keys(newObj || {})]);
  for (const key of allKeys) {
    const fieldPath = prefix ? `${prefix}.${key}` : key;
    const inOld = oldObj && key in oldObj;
    const inNew = newObj && key in newObj;
    if (!inOld && inNew) {
      result.added.push({ path: fieldPath, value: newObj[key] });
    } else if (inOld && !inNew) {
      result.removed.push({ path: fieldPath, oldValue: oldObj[key] });
    } else {
      const oldVal = oldObj[key];
      const newVal = newObj[key];
      if (Array.isArray(oldVal) || Array.isArray(newVal)) {
        const oArr = Array.isArray(oldVal) ? oldVal : [];
        const nArr = Array.isArray(newVal) ? newVal : [];
        const hasId = oArr.concat(nArr).some(item => item && typeof item === 'object' && 'id' in item);
        if (hasId) {
          // 按 id 匹配：检测新增、删除、修改
          const oldById = new Map(oArr.filter(i => i && typeof i === 'object' && 'id' in i).map(i => [i.id, i]));
          const newById = new Map(nArr.filter(i => i && typeof i === 'object' && 'id' in i).map(i => [i.id, i]));
          for (const [id, nItem] of newById) {
            if (!oldById.has(id)) {
              result.added.push({ path: `${fieldPath}[id:${id}]`, value: nItem });
            } else {
              const subDiff = diffObjects(oldById.get(id), nItem, `${fieldPath}[id:${id}]`);
              result.added.push(...subDiff.added);
              result.removed.push(...subDiff.removed);
              result.changed.push(...subDiff.changed);
            }
          }
          for (const [id] of oldById) {
            if (!newById.has(id)) {
              result.removed.push({ path: `${fieldPath}[id:${id}]`, oldValue: oldById.get(id) });
            }
          }
        } else {
          // 无 id 字段，按索引对比
          const maxLen = Math.max(oArr.length, nArr.length);
          for (let i = 0; i < maxLen; i++) {
            const itemPath = `${fieldPath}[${i}]`;
            if (i >= oArr.length) {
              result.added.push({ path: itemPath, value: nArr[i] });
            } else if (i >= nArr.length) {
              result.removed.push({ path: itemPath, oldValue: oArr[i] });
            } else if (typeof oArr[i] === 'object' && oArr[i] !== null && typeof nArr[i] === 'object' && nArr[i] !== null) {
              const subDiff = diffObjects(oArr[i], nArr[i], itemPath);
              result.added.push(...subDiff.added);
              result.removed.push(...subDiff.removed);
              result.changed.push(...subDiff.changed);
            } else if (JSON.stringify(oArr[i]) !== JSON.stringify(nArr[i])) {
              result.changed.push({ path: itemPath, oldValue: oArr[i], newValue: nArr[i] });
            }
          }
        }
      } else if (typeof oldVal === 'object' && oldVal !== null && typeof newVal === 'object' && newVal !== null) {
        const subDiff = diffObjects(oldVal, newVal, fieldPath);
        result.added.push(...subDiff.added);
        result.removed.push(...subDiff.removed);
        result.changed.push(...subDiff.changed);
      } else if (JSON.stringify(oldVal) !== JSON.stringify(newVal)) {
        result.changed.push({ path: fieldPath, oldValue: oldVal, newValue: newVal });
      }
    }
  }
  return result;
}

function getVersionDiff(fromFile, toFile) {
  try {
    if (!/^[\w\-]+\.json$/.test(fromFile) || !/^[\w\-]+\.json$/.test(toFile)) {
      return { error: '非法文件名' };
    }
    const fromPath = path.join(SNAPSHOT_DIR, fromFile);
    const toPath = path.join(SNAPSHOT_DIR, toFile);
    if (!fs.existsSync(fromPath)) return { error: '起始版本不存在' };
    if (!fs.existsSync(toPath)) return { error: '目标版本不存在' };
    const oldConfig = JSON.parse(fs.readFileSync(fromPath, 'utf-8'));
    const newConfig = JSON.parse(fs.readFileSync(toPath, 'utf-8'));
    return diffObjects(oldConfig, newConfig, '');
  } catch (err) {
    console.error('[Version] 对比版本失败:', err.message);
    return { error: err.message };
  }
}

// ==================== 增量差异存储与应用（用于快照清理后的版本重建）====================

// 解析路径字符串如 "proxies[0].port" -> ["proxies", 0, "port"]
function parsePath(pathStr) {
  if (!pathStr) return [];
  const keys = [];
  const parts = pathStr.split('.');
  for (const part of parts) {
    const match = part.match(/^(\w+)\[(\d+)\]$/);
    if (match) {
      keys.push(match[1], parseInt(match[2], 10));
    } else {
      keys.push(part);
    }
  }
  return keys;
}

// 按路径设置值（自动创建中间容器）
function setPath(obj, pathStr, value) {
  const keys = parsePath(pathStr);
  if (keys.length === 0) return obj;
  let current = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    const k = keys[i];
    if (current[k] === undefined) {
      current[k] = typeof keys[i + 1] === 'number' ? [] : {};
    }
    current = current[k];
  }
  current[keys[keys.length - 1]] = JSON.parse(JSON.stringify(value));
  return obj;
}

// 按路径删除值（数组用 splice，普通对象用 delete）
function deletePath(obj, pathStr) {
  const keys = parsePath(pathStr);
  if (keys.length === 0) return obj;
  let current = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    if (current[keys[i]] === undefined) return obj;
    current = current[keys[i]];
  }
  const lastKey = keys[keys.length - 1];
  if (Array.isArray(current)) {
    current.splice(lastKey, 1);
  } else {
    delete current[lastKey];
  }
  return obj;
}

// 包装 diffObjects，生成标准格式的差异
function computeDiff(oldConfig, newConfig) {
  return diffObjects(oldConfig, newConfig, '');
}

// 保存差异文件到 diffs/ 目录（原子写入）
function saveDiff(versionId, diff) {
  try {
    if (!fs.existsSync(DIFFS_DIR)) fs.mkdirSync(DIFFS_DIR, { recursive: true });
    const diffFile = versionId + '.diff.json';
    const diffPath = path.join(DIFFS_DIR, diffFile);
    const tmpPath = diffPath + '.tmp';
    fs.writeFileSync(tmpPath, JSON.stringify(diff, null, 2), 'utf-8');
    fs.renameSync(tmpPath, diffPath);
    return diffFile;
  } catch (err) {
    console.error('[Version] 保存差异文件失败:', err.message);
    return null;
  }
}

// 加载差异文件
function loadDiff(diffFile) {
  try {
    if (!/^[\w\-]+\.diff\.json$/.test(diffFile)) return null;
    const diffPath = path.join(DIFFS_DIR, diffFile);
    if (!fs.existsSync(diffPath)) return null;
    return JSON.parse(fs.readFileSync(diffPath, 'utf-8'));
  } catch (err) {
    console.error('[Version] 加载差异文件失败:', err.message);
    return null;
  }
}

// 应用前向差异（parent -> child），返回子版本配置
function applyForwardDiff(config, diff) {
  let result = JSON.parse(JSON.stringify(config));
  // 顺序：先 added（新增字段），再 changed（修改字段），最后 removed（删除字段）
  for (const a of (diff.added || [])) {
    result = setPath(result, a.path, a.value);
  }
  for (const c of (diff.changed || [])) {
    result = setPath(result, c.path, c.newValue);
  }
  for (const r of (diff.removed || [])) {
    result = deletePath(result, r.path);
  }
  return result;
}

// 重建指定版本：如果快照存在直接读，否则沿 parentId 链反向找到最近快照再前向应用 diff
function reconstructVersion(versionId) {
  try {
    initVersionChain();
    const meta = loadMeta();
    const versionMap = new Map(meta.versions.map(v => [v.id, v]));

    const target = versionMap.get(versionId);
    if (!target) return { error: '版本不存在' };

    // 快速路径：快照文件存在
    if (target.hasSnapshot !== false) {
      const snapPath = path.join(SNAPSHOT_DIR, target.file);
      if (fs.existsSync(snapPath)) {
        return { config: JSON.parse(fs.readFileSync(snapPath, 'utf-8')) };
      }
    }

    // 慢速路径：沿 parentId 链反向查找最近可用快照
    const chain = []; // 从目标到基准的版本列表（需前向应用）
    let current = target;
    let iterations = 0;
    const maxIterations = 1000;

    while (current) {
      if (++iterations > maxIterations) {
        return { error: '版本链过深，可能存在循环引用' };
      }
      const snapPath = path.join(SNAPSHOT_DIR, current.file);
      if (fs.existsSync(snapPath)) {
        // 找到基准快照，停止
        break;
      }
      // 没有快照，需要 diff 才能重建
      if (!current.diffFile) {
        return { error: '版本链中断: ' + current.id + ' 既无快照也无差异记录' };
      }
      chain.unshift(current); // 头部插入，最终按从旧到新顺序应用
      current = current.parentId ? versionMap.get(current.parentId) : null;
    }

    if (!current) {
      return { error: '未找到可用的快照作为基准点，无法重建版本' };
    }

    // 从基准快照开始，逐个应用 diff
    let config = JSON.parse(fs.readFileSync(path.join(SNAPSHOT_DIR, current.file), 'utf-8'));
    for (const version of chain) {
      const diff = loadDiff(version.diffFile);
      if (!diff) {
        return { error: '差异文件缺失: ' + version.diffFile };
      }
      config = applyForwardDiff(config, diff);
    }

    return { config };
  } catch (err) {
    console.error('[Version] 重建版本失败:', err.message);
    return { error: err.message };
  }
}

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
    // 确保版本链已初始化
    initVersionChain();
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const name = `${ts}_${reason || 'save'}.json`;
    const id = name.replace('.json', '');
    fs.copyFileSync(CONFIG_PATH, path.join(SNAPSHOT_DIR, name));
    // 读取当前配置和上一个版本，生成摘要
    const newConfig = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
    const meta = loadMeta();
    const parentId = meta.versions.length > 0 ? meta.versions[0].id : null;
    let oldConfig = null;
    if (parentId) {
      try {
        oldConfig = JSON.parse(fs.readFileSync(path.join(SNAPSHOT_DIR, meta.versions[0].file), 'utf-8'));
      } catch { /* ignore */ }
    }
    const summary = generateSummary(newConfig, oldConfig, reason || 'save');

    // 计算并保存增量差异（用于快照清理后的版本重建）
    let diffFile = null;
    if (oldConfig) {
      const diff = computeDiff(oldConfig, newConfig);
      diffFile = saveDiff(id, diff);
    }

    // 在链头插入新版本
    meta.versions.unshift({
      id,
      file: name,
      reason: reason || 'save',
      timestamp: new Date().toISOString(),
      parentId,
      summary,
      diffFile,          // 前向差异文件名（parent -> 此版本）
      hasSnapshot: true, // 快照文件存在
    });
    saveMeta(meta);
    // 清理超量快照：标记 hasSnapshot:false 而非删除 meta 条目，diff 文件不删除
    const files = fs.readdirSync(SNAPSHOT_DIR)
      .filter(f => f.endsWith('.json') && f !== 'meta.json')
      .sort();
    while (files.length > MAX_SNAPSHOTS) {
      const oldest = files.shift();
      fs.unlinkSync(path.join(SNAPSHOT_DIR, oldest));
      // 标记对应的 meta 条目为快照已清理，而非删除
      const oldestId = oldest.replace('.json', '');
      const entry = meta.versions.find(v => v.id === oldestId);
      if (entry) {
        entry.hasSnapshot = false;
      }
    }
    saveMeta(meta);
  } catch (err) {
    console.error('[Snapshot] 保存快照失败:', err.message);
  }
}

function getSnapshots() {
  try {
    initVersionChain();
    const meta = loadMeta();
    return meta.versions.map(v => {
      const snapPath = path.join(SNAPSHOT_DIR, v.file);
      const hasSnap = v.hasSnapshot !== false && fs.existsSync(snapPath);
      const stat = fs.existsSync(snapPath) ? fs.statSync(snapPath) : null;
      return {
        file: v.file,
        id: v.id,
        timestamp: v.timestamp || v.id.split('_')[0],
        reason: v.reason || 'save',
        parentId: v.parentId || null,
        summary: v.summary || '',
        size: stat ? stat.size : 0,
        hasSnapshot: hasSnap,
        diffFile: v.diffFile || null,
        reconstructable: hasSnap || (v.diffFile ? true : false),
      };
    });
  } catch (err) {
    console.error('[Snapshot] 读取快照列表失败:', err.message);
    return [];
  }
}

function restoreSnapshot(file, versionId) {
  try {
    let config;
    let reconstructed = false;

    if (versionId) {
      // 通过版本 ID 回滚（支持重建已清理的快照）
      const result = reconstructVersion(versionId);
      if (result.error) return result;
      config = result.config;
      reconstructed = true;
    } else if (file) {
      if (!/^[\w\-]+\.json$/.test(file)) return { error: '非法文件名' };
      const snapshotPath = path.join(SNAPSHOT_DIR, file);
      if (fs.existsSync(snapshotPath)) {
        config = JSON.parse(fs.readFileSync(snapshotPath, 'utf-8'));
      } else {
        // 快照已清理，尝试通过 diff 重建
        const vId = file.replace('.json', '');
        const result = reconstructVersion(vId);
        if (result.error) return result;
        config = result.config;
        reconstructed = true;
      }
    } else {
      return { error: '需要指定快照文件或版本ID' };
    }

    // 先对当前配置做快照，以便回滚本次操作
    saveSnapshot('before-rollback');
    saveConfig(config);
    return { success: true, reconstructed };
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

// --- MCP Server CRUD ---

function getMcpPresets() {
  try {
    if (!fs.existsSync(PRESETS_PATH)) return [];
    return JSON.parse(fs.readFileSync(PRESETS_PATH, 'utf-8'));
  } catch {
    return [];
  }
}

function getMcpServers() {
  const config = loadConfig();
  return config.mcpServers || {};
}

function getMcpServer(name) {
  const servers = getMcpServers();
  return servers[name] || null;
}

function addMcpServer(name, serverConfig) {
  const config = loadConfig();
  if (!config.mcpServers) config.mcpServers = {};
  if (config.mcpServers[name]) return null;
  config.mcpServers[name] = serverConfig;
  saveConfig(config);
  return serverConfig;
}

function updateMcpServer(name, updates) {
  const config = loadConfig();
  if (!config.mcpServers || !config.mcpServers[name]) return null;
  config.mcpServers[name] = { ...config.mcpServers[name], ...updates };
  saveConfig(config);
  return config.mcpServers[name];
}

function removeMcpServer(name) {
  const config = loadConfig();
  if (!config.mcpServers || !config.mcpServers[name]) return false;
  delete config.mcpServers[name];
  saveConfig(config);
  return true;
}

module.exports = {
  loadConfig,
  saveConfig,
  saveSnapshot,
  getSnapshots,
  restoreSnapshot,
  getVersionDiff,
  reconstructVersion,
  computeDiff,
  applyForwardDiff,
  diffObjects,
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
  getMcpServers,
  getMcpServer,
  getMcpPresets,
  addMcpServer,
  updateMcpServer,
  removeMcpServer,
};
