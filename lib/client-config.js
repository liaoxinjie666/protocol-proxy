const fs = require('fs');
const path = require('path');
const os = require('os');
const { exec } = require('child_process');

// ==================== Tool Definitions ====================

const TOOLS = {
  'claude-code': {
    name: 'Claude Code',
    npmPackage: '@anthropic-ai/claude-code',
    configPath: path.join(os.homedir(), '.claude', 'settings.json'),
    detectCommand: 'claude --version',
    configDir: path.join(os.homedir(), '.claude'),
  },
  codex: {
    name: 'Codex',
    npmPackage: '@openai/codex',
    configPath: path.join(os.homedir(), '.codex', 'config.toml'),
    authPath: path.join(os.homedir(), '.codex', 'auth.json'),
    detectCommand: 'codex --version',
    configDir: path.join(os.homedir(), '.codex'),
  },
};

// ==================== Detection ====================

function detectTool(toolId, proxies) {
  const tool = TOOLS[toolId];
  if (!tool) return { ok: false, message: `未知工具: ${toolId}` };

  const configExists = fs.existsSync(tool.configPath);
  const dirExists = fs.existsSync(tool.configDir);

  // Build a set of known proxy URLs for matching
  const proxyUrls = new Set();
  if (proxies && proxies.length) {
    for (const p of proxies) {
      proxyUrls.add(`http://localhost:${p.port}`);
      proxyUrls.add(`http://localhost:${p.port}/v1`);
      proxyUrls.add(`http://127.0.0.1:${p.port}`);
    }
  }

  return new Promise((resolve) => {
    exec(tool.detectCommand, { timeout: 10000 }, (err, stdout) => {
      const installed = !err && stdout && stdout.trim().length > 0;
      const version = installed ? stdout.trim().split('\n')[0] : null;

      let configured = false;
      let configuredOurProxy = false;
      let configuredUrl = null;

      if (toolId === 'claude-code' && configExists) {
        try {
          const cfg = JSON.parse(fs.readFileSync(tool.configPath, 'utf8'));
          configuredUrl = cfg.env?.ANTHROPIC_BASE_URL || null;
          configured = !!configuredUrl;
          configuredOurProxy = configuredUrl ? proxyUrls.has(configuredUrl) : false;
        } catch {}
      }

      if (toolId === 'codex' && configExists) {
        try {
          const content = fs.readFileSync(tool.configPath, 'utf8');
          const provider = parseTomlSection(content, 'model_providers.proxy');
          configuredUrl = provider?.base_url || null;
          configured = !!configuredUrl;
          configuredOurProxy = configuredUrl ? proxyUrls.has(configuredUrl) : false;
        } catch {}
      }

      resolve({
        ok: true,
        installed,
        version,
        configExists: dirExists,
        configured,
        configuredOurProxy,
        configuredUrl,
        configPath: tool.configPath,
      });
    });
  });
}

// ==================== Installation ====================

function installTool(toolId, method, onLog) {
  const tool = TOOLS[toolId];
  if (!tool) return Promise.resolve({ ok: false, message: `未知工具: ${toolId}` });

  let cmd;
  switch (method) {
    case 'npm-mirror':
      cmd = `npm install -g ${tool.npmPackage} --registry=https://registry.npmmirror.com`;
      break;
    case 'npx':
      // npx is "no install" - just verify it runs
      cmd = `npx -y ${tool.npmPackage} --version`;
      break;
    default:
      cmd = `npm install -g ${tool.npmPackage}`;
  }

  return new Promise((resolve) => {
    const child = exec(cmd, { timeout: 300000, maxBuffer: 1024 * 1024 });
    let output = '';

    child.stdout?.on('data', (data) => {
      output += data;
      if (onLog) onLog(data.toString());
    });
    child.stderr?.on('data', (data) => {
      output += data;
      if (onLog) onLog(data.toString());
    });

    child.on('close', (code) => {
      if (code === 0) {
        resolve({ ok: true, message: '安装成功' });
      } else {
        resolve({ ok: false, message: `安装失败 (exit code ${code})`, output });
      }
    });

    child.on('error', (err) => {
      resolve({ ok: false, message: `安装出错: ${err.message}` });
    });
  });
}

// ==================== Config Read/Preview ====================

function buildProxyUrl(proxy) {
  return `http://localhost:${proxy.port}`;
}

function readClaudeCodeConfig() {
  const tool = TOOLS['claude-code'];
  try {
    if (fs.existsSync(tool.configPath)) {
      return JSON.parse(fs.readFileSync(tool.configPath, 'utf8'));
    }
  } catch {}
  return {};
}

function writeClaudeCodeConfig(config) {
  const tool = TOOLS['claude-code'];
  const dir = path.dirname(tool.configPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(tool.configPath, JSON.stringify(config, null, 2), 'utf8');
}

function previewClaudeCode(proxy) {
  const current = readClaudeCodeConfig();
  const url = buildProxyUrl(proxy);
  const hasToken = proxy.requireAuth && proxy.authToken;
  const currentUrl = current?.env?.ANTHROPIC_BASE_URL || null;
  const currentToken = current?.env?.ANTHROPIC_AUTH_TOKEN || null;

  const changes = [];
  if (currentUrl !== url) {
    changes.push({ field: 'env.ANTHROPIC_BASE_URL', old: currentUrl || '(未设置)', new: url });
  }
  if (hasToken && currentToken !== proxy.authToken) {
    changes.push({ field: 'env.ANTHROPIC_AUTH_TOKEN', old: currentToken ? maskKey(currentToken) : '(未设置)', new: maskKey(proxy.authToken) });
  } else if (hasToken) {
    changes.push({ field: 'env.ANTHROPIC_AUTH_TOKEN', old: maskKey(currentToken), new: maskKey(proxy.authToken), note: '未变化' });
  }

  return {
    ok: true,
    tool: 'claude-code',
    configPath: TOOLS['claude-code'].configPath,
    fileExists: fs.existsSync(TOOLS['claude-code'].configPath),
    changes,
    willCreate: !fs.existsSync(TOOLS['claude-code'].configPath),
  };
}

function writeClaudeCode(proxy) {
  const config = readClaudeCodeConfig();
  if (!config.env) config.env = {};
  config.env.ANTHROPIC_BASE_URL = buildProxyUrl(proxy);
  if (proxy.requireAuth && proxy.authToken) {
    config.env.ANTHROPIC_AUTH_TOKEN = proxy.authToken;
  }
  writeClaudeCodeConfig(config);
  return { ok: true, message: 'Claude Code 配置已写入' };
}

// ==================== Codex TOML handling ====================

function readCodexConfig() {
  const tool = TOOLS.codex;
  try {
    if (fs.existsSync(tool.configPath)) {
      return fs.readFileSync(tool.configPath, 'utf8');
    }
  } catch {}
  return null;
}

function readCodexAuth() {
  const tool = TOOLS.codex;
  try {
    if (fs.existsSync(tool.authPath)) {
      return JSON.parse(fs.readFileSync(tool.authPath, 'utf8'));
    }
  } catch {}
  return {};
}

function writeCodexAuth(auth) {
  const tool = TOOLS.codex;
  fs.writeFileSync(tool.authPath, JSON.stringify(auth, null, 2), 'utf8');
}

// TOML section header matcher: [section_name] or [parent.'child']
function matchSectionHeader(line, sectionName) {
  const trimmed = line.trim();
  // Normalize: remove outer brackets
  if (!trimmed.startsWith('[') || !trimmed.endsWith(']')) return false;
  const inner = trimmed.slice(1, -1).trim();
  // Handle quoted sections like [projects.'c:\path']
  return inner === sectionName;
}

// Extract key-value pairs from a TOML section by line-by-line parsing
function parseTomlSection(content, sectionName) {
  const lines = content.split('\n');
  let inSection = false;
  const result = {};

  for (const line of lines) {
    if (matchSectionHeader(line, sectionName)) {
      inSection = true;
      continue;
    }
    if (inSection && line.trim().startsWith('[')) {
      break; // Reached next section
    }
    if (inSection) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      let value = trimmed.slice(eqIdx + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      if (value === 'true') value = true;
      else if (value === 'false') value = false;
      else if (/^\d+$/.test(value)) value = parseInt(value, 10);
      result[key] = value;
    }
  }
  return inSection ? result : null;
}

// Update/add keys in a TOML section (line-by-line, no regex)
function updateTomlSection(content, sectionName, updates) {
  const lines = content.split('\n');
  let inSection = false;
  let sectionStartLine = -1;
  let sectionEndLine = -1;

  // Find section boundaries
  for (let i = 0; i < lines.length; i++) {
    if (matchSectionHeader(lines[i], sectionName)) {
      inSection = true;
      sectionStartLine = i;
      continue;
    }
    if (inSection && lines[i].trim().startsWith('[')) {
      sectionEndLine = i;
      break;
    }
  }
  if (inSection && sectionEndLine === -1) sectionEndLine = lines.length;

  if (sectionStartLine === -1) {
    // Section doesn't exist - append
    let result = content.trimEnd() + `\n\n[${sectionName}]\n`;
    for (const [key, value] of Object.entries(updates)) {
      result += `${key} = ${formatTomlValue(value)}\n`;
    }
    return result;
  }

  // Section exists - process line by line
  const before = lines.slice(0, sectionStartLine + 1);
  const body = lines.slice(sectionStartLine + 1, sectionEndLine);
  const after = lines.slice(sectionEndLine);

  // Update/add keys in body
  const updatedKeys = new Set();
  const newBody = [];
  for (const line of body) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      newBody.push(line);
      continue;
    }
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) {
      newBody.push(line);
      continue;
    }
    const key = trimmed.slice(0, eqIdx).trim();
    if (key in updates) {
      newBody.push(`${key} = ${formatTomlValue(updates[key])}`);
      updatedKeys.add(key);
    } else {
      newBody.push(line);
    }
  }

  // Add keys that weren't found
  for (const [key, value] of Object.entries(updates)) {
    if (!updatedKeys.has(key)) {
      newBody.push(`${key} = ${formatTomlValue(value)}`);
    }
  }

  return [...before, ...newBody, ...after].join('\n');
}

function formatTomlValue(value) {
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return String(value);
  return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function previewCodex(proxy) {
  const currentToml = readCodexConfig();
  const currentAuth = readCodexAuth();
  const url = buildProxyUrl(proxy);
  const hasToken = proxy.requireAuth && proxy.authToken;

  const changes = [];

  if (currentToml) {
    const provider = parseTomlSection(currentToml, 'model_providers.proxy');
    const currentUrl = provider?.base_url || null;
    if (currentUrl !== url) {
      changes.push({ field: 'model_providers.proxy.base_url', old: currentUrl || '(未设置)', new: url });
    }
    const envKey = provider?.env_key || null;
    if (envKey !== 'OPENAI_API_KEY') {
      changes.push({ field: 'model_providers.proxy.env_key', old: envKey || '(未设置)', new: 'OPENAI_API_KEY' });
    }
  } else {
    changes.push({ field: 'model_providers.proxy.base_url', old: '(配置文件不存在)', new: url });
    changes.push({ field: 'model_providers.proxy.env_key', old: '(配置文件不存在)', new: 'OPENAI_API_KEY' });
    changes.push({ field: 'model_providers.proxy.wire_api', old: '(配置文件不存在)', new: 'responses' });
  }

  if (hasToken) {
    const currentKey = currentAuth.OPENAI_API_KEY || null;
    if (currentKey !== proxy.authToken) {
      changes.push({ field: 'auth.json → OPENAI_API_KEY', old: currentKey ? maskKey(currentKey) : '(未设置)', new: maskKey(proxy.authToken) });
    }
  }

  return {
    ok: true,
    tool: 'codex',
    configPath: TOOLS.codex.configPath,
    authPath: TOOLS.codex.authPath,
    fileExists: !!currentToml,
    changes,
    willCreate: !currentToml,
  };
}

function writeCodex(proxy) {
  const url = buildProxyUrl(proxy);
  let toml = readCodexConfig();

  if (toml) {
    // Update existing config - only modify model_providers.proxy section
    toml = updateTomlSection(toml, 'model_providers.proxy', {
      base_url: url,
      env_key: 'OPENAI_API_KEY',
      wire_api: 'responses',
    });
  } else {
    // Create minimal config
    toml = `model_provider = "proxy"
model = "codex-mini-latest"
network_access = "enabled"

[model_providers.proxy]
name = "Protocol Proxy"
base_url = "${url}"
env_key = "OPENAI_API_KEY"
wire_api = "responses"
`;
  }

  const tool = TOOLS.codex;
  const dir = path.dirname(tool.configPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(tool.configPath, toml, 'utf8');

  if (proxy.requireAuth && proxy.authToken) {
    const auth = readCodexAuth();
    auth.OPENAI_API_KEY = proxy.authToken;
    writeCodexAuth(auth);
  }

  return { ok: true, message: 'Codex 配置已写入' };
}

// ==================== Helpers ====================

function maskKey(key) {
  if (!key || key.length < 12) return '***';
  return key.slice(0, 6) + '****' + key.slice(-4);
}

// ==================== Public API ====================

module.exports = { TOOLS, detectTool, installTool, previewClaudeCode, writeClaudeCode, previewCodex, writeCodex, maskKey };
