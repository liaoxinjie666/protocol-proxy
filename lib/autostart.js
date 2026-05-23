const { execSync } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');

const REG_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const VALUE_NAME = 'ProtocolProxy';
const PID_FILE = path.join(os.tmpdir(), 'protocol-proxy.pid');

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
    const output = execSync(`reg query "${REG_KEY}" /v "${VALUE_NAME}"`, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
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
    execSync(`reg add "${REG_KEY}" /v "${VALUE_NAME}" /t REG_SZ /d "${cmd}" /f`, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
    return { success: true, enabled: true, command: cmd };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

function disable() {
  if (process.platform !== 'win32') return { success: false, error: '仅支持 Windows 系统' };
  try {
    execSync(`reg delete "${REG_KEY}" /v "${VALUE_NAME}" /f`, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
    return { success: true, enabled: false };
  } catch (err) {
    // Key not found is not an error
    if (err.message && err.message.includes('找不到')) return { success: true, enabled: false };
    return { success: false, error: err.message };
  }
}

module.exports = { isEnabled, enable, disable };
