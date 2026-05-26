const fs = require('fs');
const path = require('path');
const os = require('os');

const LOG_DIR = path.join(os.homedir(), '.protocol-proxy');
const LOG_FILE = path.join(LOG_DIR, 'server.log');
const MAX_SIZE = 10 * 1024 * 1024; // 10MB

let stream = null;

function init() {
  try {
    if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
    stream = fs.createWriteStream(LOG_FILE, { flags: 'w' });
  } catch (err) {
    console.error('[Logger] 初始化失败:', err.message);
    stream = null;
  }
}

function checkSize() {
  if (!stream) return;
  try {
    const stat = fs.statSync(LOG_FILE);
    if (stat.size > MAX_SIZE) {
      // 截断：保留后半部分
      const content = fs.readFileSync(LOG_FILE, 'utf8');
      const half = content.slice(Math.floor(content.length / 2));
      stream.end();
      fs.writeFileSync(LOG_FILE, half);
      stream = fs.createWriteStream(LOG_FILE, { flags: 'a' });
    }
  } catch {}
}

function timestamp() {
  return new Date().toLocaleString('zh-CN', { hour12: false });
}

function log(...args) {
  const line = `[${timestamp()}] ${args.join(' ')}`;
  console.log(line);
  if (stream) {
    stream.write(line + '\n');
    checkSize();
  }
}

function error(...args) {
  const line = `[${timestamp()}] ${args.join(' ')}`;
  console.error(line);
  if (stream) {
    stream.write(line + '\n');
    checkSize();
  }
}

function warn(...args) {
  const line = `[${timestamp()}] [WARN] ${args.join(' ')}`;
  console.error(line);
  if (stream) {
    stream.write(line + '\n');
    checkSize();
  }
}

module.exports = { init, log, error, warn, LOG_FILE };
