const { execFileSync } = require('child_process');
const path = require('path');

const REG_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const VALUE_NAME = 'ProtocolProxy';

function getRunCommand() {
  // Use node + server.js for source installs, or the exe path for pkg builds
  if (process.pkg) {
    return `"${process.execPath}" --daemon`;
  }
  return `"${process.execPath}" "${path.resolve(__dirname, '..', 'server.js')}" --daemon`;
}

function isEnabled() {
  if (process.platform !== 'win32') {
    return { supported: false, enabled: false, message: '仅支持 Windows 系统' };
  }
  try {
    const output = execFileSync('reg', ['query', REG_KEY, '/v', VALUE_NAME], { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
    const match = output.match(/REG_SZ\s+(.+)/);
    return { supported: true, enabled: !!match, command: match ? match[1].trim() : null };
  } catch {
    return { supported: true, enabled: false, command: null };
  }
}

function enable() {
  if (process.platform !== 'win32') return { success: false, error: '仅支持 Windows 系统' };
  try {
    const cmd = getRunCommand();
    execFileSync('reg', ['add', REG_KEY, '/v', VALUE_NAME, '/t', 'REG_SZ', '/d', cmd, '/f'], { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
    return { success: true, enabled: true, command: cmd };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

function disable() {
  if (process.platform !== 'win32') return { success: false, error: '仅支持 Windows 系统' };
  try {
    execFileSync('reg', ['delete', REG_KEY, '/v', VALUE_NAME, '/f'], { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
    return { success: true, enabled: false };
  } catch (err) {
    // Exit code 1 means key/value not found — treat as success
    if (err.status === 1) return { success: true, enabled: false };
    return { success: false, error: err.message };
  }
}

module.exports = { isEnabled, enable, disable };
