const fs = require('fs');
const path = require('path');
const os = require('os');

const DATA_DIR = path.join(os.homedir(), '.protocol-proxy', 'conversations');

// 内存缓存：conversationId → { id, proxyId, messages, createdAt, lastActivity }
let conversations = {};

// debounce 写入：500ms 内同一 conv 只写一次
const pendingWrites = new Map(); // convId → timer

function scheduleSave(conv) {
  if (pendingWrites.has(conv.id)) clearTimeout(pendingWrites.get(conv.id));
  pendingWrites.set(conv.id, setTimeout(() => {
    pendingWrites.delete(conv.id);
    fs.writeFile(path.join(DATA_DIR, conv.id + '.json'), JSON.stringify(conv), 'utf8', () => {});
  }, 500));
}

function saveImmediate(conv) {
  if (pendingWrites.has(conv.id)) {
    clearTimeout(pendingWrites.get(conv.id));
    pendingWrites.delete(conv.id);
  }
  try {
    fs.writeFileSync(path.join(DATA_DIR, conv.id + '.json'), JSON.stringify(conv), 'utf8');
  } catch (err) {
    console.error('[conversation-store] saveImmediate failed:', err.message);
  }
}

function flushAll() {
  for (const [id, timer] of pendingWrites) {
    clearTimeout(timer);
    const conv = conversations[id];
    if (conv) {
      try { fs.writeFileSync(path.join(DATA_DIR, id + '.json'), JSON.stringify(conv), 'utf8'); } catch {}
    }
  }
  pendingWrites.clear();
}

function init() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  try {
    const files = fs.readdirSync(DATA_DIR).filter(f => f.endsWith('.json'));
    for (const file of files) {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(DATA_DIR, file), 'utf8'));
        if (data.id) conversations[data.id] = data;
      } catch {}
    }
  } catch {}
}

function get(id) {
  return conversations[id] || null;
}

function create(proxyId, maxConversations) {
  // 超过最大会话数时删除最早的
  if (maxConversations > 0) {
    const all = list();
    while (all.length >= maxConversations) {
      const oldest = all.shift(); // list() 已按 lastActivity 升序
      remove(oldest.id);
    }
  }
  const id = 'conv-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
  const conv = { id, proxyId, messages: [], mode: 'full', windowSize: 20, createdAt: Date.now(), lastActivity: Date.now() };
  conversations[id] = conv;
  saveImmediate(conv); // 新建立即写入
  return conv;
}

function touch(conv) {
  conv.lastActivity = Date.now();
  scheduleSave(conv); // debounce 异步写入
}

function remove(id) {
  delete conversations[id];
  if (pendingWrites.has(id)) { clearTimeout(pendingWrites.get(id)); pendingWrites.delete(id); }
  fs.unlink(path.join(DATA_DIR, id + '.json'), () => {});
}

// 返回会话列表（按 lastActivity 升序，不含 messages），用于前端展示
function list() {
  return Object.values(conversations)
    .map(c => ({
      id: c.id,
      proxyId: c.proxyId,
      mode: c.mode || 'full',
      windowSize: c.windowSize || 20,
      createdAt: c.createdAt,
      lastActivity: c.lastActivity,
      messageCount: (c.messages || []).length,
      // 取第一条 user 消息作为标题预览（支持多模态数组格式）
      preview: (() => {
        const firstUser = (c.messages || []).find(m => m.role === 'user');
        if (!firstUser) return '';
        const content = firstUser.content;
        if (typeof content === 'string') return content.slice(0, 60);
        if (Array.isArray(content)) {
          const textPart = content.find(p => p.type === 'text');
          return (textPart?.text || '[多模态消息]').slice(0, 60);
        }
        return String(content).slice(0, 60);
      })(),
    }))
    .sort((a, b) => a.lastActivity - b.lastActivity);
}

// 进程退出时确保所有 debounce 中的数据落盘
process.on('exit', flushAll);
process.on('SIGINT', () => { flushAll(); process.exit(0); });
process.on('SIGTERM', () => { flushAll(); process.exit(0); });

module.exports = { init, get, create, touch, remove, list, flushAll, saveImmediate };
