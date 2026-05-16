const fs = require('fs');
const path = require('path');
const os = require('os');

const SYSTEM_DIR = path.join(__dirname, '..', 'skills', 'system');
const PRESET_DIR = path.join(__dirname, '..', 'skills', 'preset');
const USER_DIR = path.join(os.homedir(), '.protocol-proxy', 'skills');

let skills = {}; // name → { name, description, content, category }

function parseFrontmatter(text) {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!match) return { name: '', description: '', body: text };
  const meta = match[1];
  const body = match[2];
  let name = '', description = '', trigger = '', mcpServers = [];
  for (const line of meta.split('\n')) {
    const trimmed = line.trim();
    const nm = trimmed.match(/^name:\s*['"]?(.+?)['"]?\s*$/);
    if (nm) name = nm[1];
    const dm = trimmed.match(/^description:\s*['"]?(.+?)['"]?\s*$/);
    if (dm) description = dm[1];
    const tm = trimmed.match(/^trigger:\s*['"]?(.+?)['"]?\s*$/);
    if (tm) trigger = tm[1];
    const mm = trimmed.match(/^mcp:\s*\[([^\]]*)\]/);
    if (mm) mcpServers = mm[1].split(',').map(s => s.trim()).filter(Boolean);
  }
  return { name, description, trigger, mcpServers, body };
}

function listDir(dirPath) {
  if (!fs.existsSync(dirPath)) return [];
  const result = [];
  function walk(dir, prefix) {
    try {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name.startsWith('.')) continue;
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) walk(path.join(dir, entry.name), rel);
        else result.push(rel);
      }
    } catch (err) { console.error(`[skill-store] 读取目录失败:`, err.message); }
  }
  walk(dirPath, '');
  return result;
}

function loadFromDir(dir, category) {
  if (!fs.existsSync(dir)) return;
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const skillDir = path.join(dir, entry.name);
      if (category === 'preset' && fs.existsSync(path.join(skillDir, '.deleted'))) continue;
      const skillFile = path.join(skillDir, 'SKILL.md');
      if (!fs.existsSync(skillFile)) continue;
      try {
        const raw = fs.readFileSync(skillFile, 'utf8');
        const { name, description, trigger, mcpServers, body } = parseFrontmatter(raw);
        const skillName = name || entry.name;
        const scripts = listDir(path.join(skillDir, 'scripts'));
        const references = listDir(path.join(skillDir, 'reference'));
        skills[skillName] = { name: skillName, description, trigger, mcpServers, content: body.trim(), category, dirPath: skillDir, scripts, references };
      } catch (err) { console.error(`[skill-store] 加载 ${entry.name} 失败:`, err.message); }
    }
  } catch (err) { console.error(`[skill-store] 扫描 ${dir} 失败:`, err.message); }
}

function list() {
  return Object.values(skills);
}

function get(name) {
  return skills[name] || null;
}

function create(name, description, content, trigger = '') {
  if (skills[name]) return null; // 已存在
  const dir = path.join(USER_DIR, name);
  fs.mkdirSync(dir, { recursive: true });
  let frontmatter = `---\nname: ${name}\ndescription: ${description}`;
  if (trigger) frontmatter += `\ntrigger: ${trigger}`;
  frontmatter += `\n---\n\n${content}`;
  fs.writeFileSync(path.join(dir, 'SKILL.md'), frontmatter, 'utf8');
  skills[name] = { name, description, trigger, content, category: 'user' };
  return skills[name];
}

function createFromUpload(files) {
  const skillMd = files.find(f => f.path === 'SKILL.md');
  if (!skillMd) return null;
  const raw = Buffer.from(skillMd.content, 'base64').toString('utf8');
  const { name: parsedName, description, trigger, mcpServers, body } = parseFrontmatter(raw);
  if (!parsedName) return null;
  if (skills[parsedName]) return null;
  const dir = path.join(USER_DIR, parsedName);
  fs.mkdirSync(dir, { recursive: true });
  for (const f of files) {
    const safePath = f.path.replace(/\\/g, '/');
    if (safePath.includes('..')) continue;
    const target = path.join(dir, safePath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, Buffer.from(f.content, 'base64'));
  }
  const scripts = listDir(path.join(dir, 'scripts'));
  const references = listDir(path.join(dir, 'reference'));
  skills[parsedName] = { name: parsedName, description, trigger, mcpServers, content: body.trim(), category: 'user', dirPath: dir, scripts, references };
  return skills[parsedName];
}

function update(name, description, content, trigger = '') {
  const skill = skills[name];
  if (!skill || skill.category !== 'user') return null;
  const dir = path.join(USER_DIR, name);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  let frontmatter = `---\nname: ${name}\ndescription: ${description}`;
  if (trigger) frontmatter += `\ntrigger: ${trigger}`;
  frontmatter += `\n---\n\n${content}`;
  fs.writeFileSync(path.join(dir, 'SKILL.md'), frontmatter, 'utf8');
  skill.description = description;
  skill.trigger = trigger;
  skill.content = content;
  return skill;
}

function remove(name) {
  const skill = skills[name];
  if (!skill || skill.category === 'system') return false;
  if (skill.category === 'user') {
    const userPath = path.join(USER_DIR, name);
    if (fs.existsSync(userPath)) {
      fs.rmSync(userPath, { recursive: true, force: true });
      if (fs.existsSync(userPath)) return false; // 删除失败
    }
  }
  if (skill.category === 'preset') {
    const presetPath = path.join(PRESET_DIR, name, '.deleted');
    try { fs.writeFileSync(presetPath, '', 'utf8'); } catch (err) { console.error(`[skill-store] 写入 .deleted 失败:`, err.message); }
    if (!fs.existsSync(presetPath)) return false; // 写入失败（目录只读等）
  }
  delete skills[name];
  return true;
}

function init() {
  skills = {};
  loadFromDir(SYSTEM_DIR, 'system');
  loadFromDir(PRESET_DIR, 'preset');
  loadFromDir(USER_DIR, 'user');
}

function getAvailableForChat() {
  return Object.values(skills).map(s => {
    const item = { name: s.name, description: s.description };
    if (s.trigger) item.trigger = s.trigger;
    return item;
  });
}

module.exports = { init, list, get, create, createFromUpload, update, remove, getAvailableForChat };
