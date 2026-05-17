const fs = require('fs');
const path = require('path');
const os = require('os');

const DATA_DIR = path.join(os.homedir(), '.protocol-proxy', 'tasks');
const MAX_TASKS = 200;

let cache = new Map();

function init() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  cache.clear();
  try {
    const files = fs.readdirSync(DATA_DIR).filter(f => f.endsWith('.json'));
    for (const file of files) {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(DATA_DIR, file), 'utf8'));
        if (data.id) cache.set(data.id, data);
      } catch (err) {
        console.error(`[TaskStore] 加载任务文件 ${file} 失败:`, err.message);
      }
    }
  } catch (err) {
    console.error('[TaskStore] 读取任务目录失败:', err.message);
  }
  cleanup();
}

function save(task) {
  cache.set(task.id, task);
  try {
    fs.writeFileSync(path.join(DATA_DIR, task.id + '.json'), JSON.stringify(task), 'utf8');
  } catch (err) {
    console.error(`[TaskStore] 保存任务 ${task.id} 失败:`, err.message);
  }
}

function get(taskId) {
  return cache.get(taskId) || null;
}

function listAll() {
  return Array.from(cache.values()).sort((a, b) => b.createdAt - a.createdAt);
}

function remove(taskId) {
  cache.delete(taskId);
  try { fs.unlinkSync(path.join(DATA_DIR, taskId + '.json')); }
  catch (err) { console.error(`[TaskStore] 删除任务文件 ${taskId} 失败:`, err.message); }
}

function cleanup() {
  const all = listAll();
  const removable = all
    .filter(t => t.status !== 'created' && t.status !== 'running')
    .slice(MAX_TASKS);
  for (const task of removable) remove(task.id);
}

module.exports = { init, save, get, listAll, remove, cleanup };