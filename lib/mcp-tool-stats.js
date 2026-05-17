const fs = require('fs');
const path = require('path');
const os = require('os');

const STATS_PATH = path.join(os.homedir(), '.protocol-proxy', 'mcp-tool-stats.json');
const FLUSH_INTERVAL = 5000;
const MAX_ENTRIES = 10000;

let entries = [];
let dirty = false;

function load() {
  try {
    if (!fs.existsSync(STATS_PATH)) return;
    const data = JSON.parse(fs.readFileSync(STATS_PATH, 'utf-8'));
    if (Array.isArray(data.entries)) entries = data.entries;
  } catch { /* ignore */ }
}

function flush() {
  if (!dirty) return;
  try {
    const dir = path.dirname(STATS_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const tmp = STATS_PATH + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ entries }), 'utf-8');
    fs.renameSync(tmp, STATS_PATH);
    dirty = false;
  } catch (err) {
    console.error('[MCP-Stats] 写入失败:', err.message);
  }
}

setInterval(flush, FLUSH_INTERVAL);

function record(server, tool, latencyMs, success) {
  entries.push({ server, tool, latencyMs, success: !!success, timestamp: Date.now() });
  if (entries.length > MAX_ENTRIES) entries.splice(0, entries.length - MAX_ENTRIES);
  dirty = true;
}

function getStats() {
  const now = Date.now();
  const h24 = now - 24 * 60 * 60 * 1000;

  // 按服务器聚合
  const byServer = {};
  // 按工具聚合
  const byTool = {};

  for (const e of entries) {
    // 按服务器
    if (!byServer[e.server]) {
      byServer[e.server] = { server: e.server, calls: 0, success: 0, fail: 0, totalLatency: 0, recentCalls: 0 };
    }
    const s = byServer[e.server];
    s.calls++;
    if (e.success) s.success++; else s.fail++;
    s.totalLatency += e.latencyMs || 0;
    if (e.timestamp >= h24) s.recentCalls++;

    // 按工具
    const toolKey = `${e.server}::${e.tool}`;
    if (!byTool[toolKey]) {
      byTool[toolKey] = { server: e.server, tool: e.tool, calls: 0, success: 0, fail: 0, totalLatency: 0, recentCalls: 0 };
    }
    const t = byTool[toolKey];
    t.calls++;
    if (e.success) t.success++; else t.fail++;
    t.totalLatency += e.latencyMs || 0;
    if (e.timestamp >= h24) t.recentCalls++;
  }

  const serverStats = Object.values(byServer).map(s => ({
    server: s.server,
    calls: s.calls,
    success: s.success,
    fail: s.fail,
    successRate: s.calls ? Math.round((s.success / s.calls) * 100) : 0,
    avgLatency: s.calls ? Math.round(s.totalLatency / s.calls) : 0,
    recentCalls: s.recentCalls,
  })).sort((a, b) => b.calls - a.calls);

  const toolStats = Object.values(byTool).map(t => ({
    server: t.server,
    tool: t.tool,
    calls: t.calls,
    success: t.success,
    fail: t.fail,
    successRate: t.calls ? Math.round((t.success / t.calls) * 100) : 0,
    avgLatency: t.calls ? Math.round(t.totalLatency / t.calls) : 0,
    recentCalls: t.recentCalls,
  })).sort((a, b) => b.calls - a.calls);

  const totalCalls = entries.length;
  const totalSuccess = entries.filter(e => e.success).length;

  return {
    total: {
      calls: totalCalls,
      success: totalSuccess,
      fail: totalCalls - totalSuccess,
      successRate: totalCalls ? Math.round((totalSuccess / totalCalls) * 100) : 0,
      avgLatency: totalCalls ? Math.round(entries.reduce((sum, e) => sum + (e.latencyMs || 0), 0) / totalCalls) : 0,
    },
    byServer: serverStats,
    byTool: toolStats,
  };
}

module.exports = { record, getStats, flush, load };
