const fs = require('fs');
const path = require('path');
const os = require('os');

const STATS_PATH = path.join(os.homedir(), '.protocol-proxy', 'stats.json');
const FLUSH_INTERVAL = 5000;

// ==================== 内存缓冲 + 定时刷盘 ====================

let buffer = {};
let dirty = false;

function bufferKey(period, date, statsKey) {
  return `${period}:${date}:${statsKey}`;
}

function addToBuffer(period, date, statsKey, prompt, completion, estimated) {
  const bk = bufferKey(period, date, statsKey);
  if (!buffer[bk]) {
    buffer[bk] = { period, date, key: statsKey, prompt: 0, completion: 0, requests: 0, estimated: false };
  }
  buffer[bk].prompt += prompt;
  buffer[bk].completion += completion;
  buffer[bk].requests += 1;
  if (estimated) buffer[bk].estimated = true;
  dirty = true;
}

function flush() {
  const stats = readStats();
  if (!dirty) return stats;
  if (!stats.daily) stats.daily = {};
  if (!stats.monthly) stats.monthly = {};

  for (const entry of Object.values(buffer)) {
    const bucket = stats[entry.period];
    if (!bucket[entry.date]) bucket[entry.date] = {};
    if (!bucket[entry.date][entry.key]) {
      bucket[entry.date][entry.key] = { prompt: 0, completion: 0, requests: 0, estimated: false };
    }
    const target = bucket[entry.date][entry.key];
    target.prompt += entry.prompt;
    target.completion += entry.completion;
    target.requests += entry.requests;
    if (entry.estimated) target.estimated = true;
  }

  buffer = {};
  dirty = false;
  writeStats(stats);
  return stats;
}

setInterval(flush, FLUSH_INTERVAL);

// ==================== 文件读写 ====================

function readStats() {
  try {
    if (!fs.existsSync(STATS_PATH)) return {};
    return JSON.parse(fs.readFileSync(STATS_PATH, 'utf-8'));
  } catch {
    return {};
  }
}

function writeStats(data) {
  try {
    const dir = path.dirname(STATS_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const tmp = STATS_PATH + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data), 'utf-8');
    fs.renameSync(tmp, STATS_PATH);
  } catch (err) {
    console.error('[Stats] 写入失败:', err.message);
  }
}

// ==================== 日期工具 ====================

function dateKey(d) {
  return d.getFullYear() + '-' +
    String(d.getMonth() + 1).padStart(2, '0') + '-' +
    String(d.getDate()).padStart(2, '0');
}

function monthKey(d) {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
}

function yearKey(d) {
  return String(d.getFullYear());
}

// ==================== 分层合并 ====================

function mergeIfNeeded() {
  const stats = flush();
  let changed = false;

  const currentMonth = monthKey(new Date()); // "2026-05"
  const currentYear = String(new Date().getFullYear());

  // 日 → 月：非当月的日级数据合并为月级
  if (stats.daily) {
    const toMerge = {};
    for (const [dk, bucket] of Object.entries(stats.daily)) {
      const mk = dk.slice(0, 7); // "2026-05-09" → "2026-05"
      if (mk >= currentMonth) continue; // 当月的保留
      if (!toMerge[mk]) toMerge[mk] = {};
      for (const [key, val] of Object.entries(bucket)) {
        if (!toMerge[mk][key]) toMerge[mk][key] = { prompt: 0, completion: 0, requests: 0, estimated: false };
        const t = toMerge[mk][key];
        t.prompt += val.prompt;
        t.completion += val.completion;
        t.requests += val.requests;
        if (val.estimated) t.estimated = true;
      }
      delete stats.daily[dk];
      changed = true;
    }

    if (!stats.monthly) stats.monthly = {};
    for (const [mk, entries] of Object.entries(toMerge)) {
      if (!stats.monthly[mk]) stats.monthly[mk] = {};
      for (const [key, val] of Object.entries(entries)) {
        if (!stats.monthly[mk][key]) {
          stats.monthly[mk][key] = { prompt: 0, completion: 0, requests: 0, estimated: false };
        }
        const t = stats.monthly[mk][key];
        t.prompt += val.prompt;
        t.completion += val.completion;
        t.requests += val.requests;
        if (val.estimated) t.estimated = true;
      }
    }
  }

  // 月 → 年：非当年的月级数据合并为年级
  if (stats.monthly) {
    const toMerge = {};
    for (const [mk, bucket] of Object.entries(stats.monthly)) {
      const yk = mk.slice(0, 4);
      if (yk >= currentYear) continue; // 当年的保留
      if (!toMerge[yk]) toMerge[yk] = {};
      for (const [key, val] of Object.entries(bucket)) {
        if (!toMerge[yk][key]) toMerge[yk][key] = { prompt: 0, completion: 0, requests: 0, estimated: false };
        const t = toMerge[yk][key];
        t.prompt += val.prompt;
        t.completion += val.completion;
        t.requests += val.requests;
        if (val.estimated) t.estimated = true;
      }
      delete stats.monthly[mk];
      changed = true;
    }

    if (!stats.yearly) stats.yearly = {};
    for (const [yk, entries] of Object.entries(toMerge)) {
      if (!stats.yearly[yk]) stats.yearly[yk] = {};
      for (const [key, val] of Object.entries(entries)) {
        if (!stats.yearly[yk][key]) {
          stats.yearly[yk][key] = { prompt: 0, completion: 0, requests: 0, estimated: false };
        }
        const t = stats.yearly[yk][key];
        t.prompt += val.prompt;
        t.completion += val.completion;
        t.requests += val.requests;
        if (val.estimated) t.estimated = true;
      }
    }
  }

  if (changed) writeStats(stats);
}

// ==================== 记录用量 ====================

function recordUsage(proxyId, provider, model, usage, estimated = false) {
  if (!proxyId || !usage) return;
  const prompt = usage.prompt_tokens || usage.input_tokens || 0;
  const completion = usage.completion_tokens || usage.output_tokens || 0;
  if (!prompt && !completion) return;

  const now = new Date();
  const dk = dateKey(now);
  const mk = monthKey(now);

  const prov = provider || 'unknown';
  const mdl = model || 'unknown';
  const keys = [
    `p:${proxyId}`,
    `p:${proxyId}:${prov}`,
    `p:${proxyId}:${prov}:${mdl}`,
  ];

  for (const period of ['daily', 'monthly']) {
    const bucket = period === 'daily' ? dk : mk;
    for (const key of keys) {
      addToBuffer(period, bucket, key, prompt, completion, estimated);
    }
  }
}

// ==================== 查询统计 ====================

function getStats(opts = {}) {
  mergeIfNeeded();
  const { range = 'daily', startDate, endDate, proxyId } = opts;
  const stats = readStats();
  const src = stats[range] || {};

  const dates = Object.keys(src).filter(d => {
    if (startDate && d < startDate) return false;
    if (endDate && d > endDate) return false;
    return true;
  }).sort();

  const summary = { prompt: 0, completion: 0, requests: 0, estimatedCount: 0 };
  const byProvider = {};
  const byModel = {};

  for (const date of dates) {
    const bucket = src[date];
    for (const [key, val] of Object.entries(bucket)) {
      if (!matchPrefix(key, proxyId)) continue;

      const parts = key.split(':');
      // 只从 model 层（parts.length >= 4）聚合，避免三层重复计数
      if (parts.length >= 4) {
        const prov = parts[2];
        const mdl = parts.slice(3).join(':');

        summary.prompt += val.prompt;
        summary.completion += val.completion;
        summary.requests += val.requests;
        if (val.estimated) summary.estimatedCount += val.requests;

        if (!byProvider[prov]) byProvider[prov] = { prompt: 0, completion: 0, requests: 0, estimatedCount: 0 };
        byProvider[prov].prompt += val.prompt;
        byProvider[prov].completion += val.completion;
        byProvider[prov].requests += val.requests;
        if (val.estimated) byProvider[prov].estimatedCount += val.requests;

        const mk = prov + '/' + mdl;
        if (!byModel[mk]) byModel[mk] = { provider: prov, model: mdl, prompt: 0, completion: 0, requests: 0, estimatedCount: 0 };
        byModel[mk].prompt += val.prompt;
        byModel[mk].completion += val.completion;
        byModel[mk].requests += val.requests;
        if (val.estimated) byModel[mk].estimatedCount += val.requests;
      }
    }
  }

  return {
    range,
    dates,
    summary: {
      ...summary,
      total: summary.prompt + summary.completion,
      hasEstimated: summary.estimatedCount > 0,
    },
    byProvider: Object.entries(byProvider)
      .map(([name, v]) => ({ name, ...v, total: v.prompt + v.completion, hasEstimated: v.estimatedCount > 0 }))
      .sort((a, b) => b.total - a.total),
    byModel: Object.values(byModel)
      .map(v => ({ ...v, total: v.prompt + v.completion, hasEstimated: v.estimatedCount > 0 }))
      .sort((a, b) => b.total - a.total),
  };
}

function matchPrefix(key, proxyId) {
  if (!proxyId) return true;
  const prefix = 'p:' + proxyId;
  if (key.length < prefix.length) return false;
  for (let i = 0; i < prefix.length; i++) {
    if (key[i] !== prefix[i]) return false;
  }
  return key.length === prefix.length || key[prefix.length] === ':';
}

// 进程退出时刷盘（信号处理统一由 server.js 管理）
process.on('exit', flush);

module.exports = { recordUsage, getStats, flush };
