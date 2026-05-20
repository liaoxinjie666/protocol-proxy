const fs = require('fs');
const path = require('path');
const os = require('os');

const SYSTEM_DIR = path.join(__dirname, '..', 'agents', 'system');
const PRESET_DIR = path.join(__dirname, '..', 'agents', 'preset');
const USER_DIR = path.join(os.homedir(), '.protocol-proxy', 'agents');
const DELETED_FILE = path.join(USER_DIR, '.preset-deleted.json');

let agents = {}; // slug -> { slug, name, description, color, defaultRole, body, category, filePath }

function parseAgentFrontmatter(text) {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!match) return { name: '', description: '', color: '#6B7280', defaultRole: 'writer', body: text };
  const meta = match[1];
  const body = match[2];
  let name = '', description = '', color = '#6B7280', defaultRole = 'writer', domain = '';
  for (const line of meta.split('\n')) {
    const trimmed = line.trim();
    const nm = trimmed.match(/^name:\s*['"]?(.+?)['"]?\s*$/);
    if (nm) name = nm[1];
    const dm = trimmed.match(/^description:\s*['"]?(.+?)['"]?\s*$/);
    if (dm) description = dm[1];
    const cm = trimmed.match(/^color:\s*['"]?(#[0-9a-fA-F]{6})['"]?\s*$/);
    if (cm) color = cm[1];
    const rm = trimmed.match(/^defaultRole:\s*['"]?(readonly|writer|full)['"]?\s*$/);
    if (rm) defaultRole = rm[1];
    const dom = trimmed.match(/^domain:\s*['"]?(.+?)['"]?\s*$/);
    if (dom) domain = dom[1];
  }
  return { name, description, color, defaultRole, domain, body };
}

// 领域分类：基于 slug 关键词匹配
const DOMAIN_KEYWORDS = {
  '开发工程': ['backend', 'frontend', 'code-reviewer', 'software-architect', 'senior-developer', 'devops', 'database', 'ai-engineer', 'security-engineer', 'sre', 'mcp-builder', 'api-tester', 'git-workflow', 'blockchain', 'solidity', 'embedded', 'cms', 'lsp-index', 'terminal-integration', 'mobile-app', 'blender', 'feishu', 'salesforce', 'zk-steward', 'autonomous-optimization', 'infrastructure', 'model-qa', 'wechat-mini-program', 'developer-advocate'],
  '游戏开发': ['game-', 'unity-', 'unreal-', 'godot-', 'roblox-', 'level-designer', 'narrative-designer', 'narratologist', 'studio-', 'technical-artist'],
  '设计创意': ['ui-designer', 'ux-', 'brand-guardian', 'visual-storyteller', 'image-prompt', 'whimsy', 'rapid-prototyper', 'inclusive-visuals', 'document-generator', 'technical-writer', 'book-co-author'],
  '市场营销': ['seo', 'social-media', 'content-creator', 'growth-hacker', 'tiktok', 'instagram', 'xiaohongshu', 'douyin', 'bilibili', 'weibo', 'zhihu', 'kuaishou', 'twitter', 'reddit', 'linkedin', 'ad-creative', 'carousel', 'podcast', 'short-video', 'video-optimization', 'app-store-optimizer', 'baidu-seo', 'ppc-', 'paid-social', 'paid-media', 'programmatic', 'tracking-measurement', 'search-query', 'ai-citation', 'trend-researcher'],
  '电商运营': ['e-commerce', 'china-e-commerce', 'livestream-commerce', 'private-domain', 'china-market'],
  '销售商务': ['sales-coach', 'sales-engineer', 'sales-data', 'account-strategist', 'deal-strategist', 'pipeline-analyst', 'outbound', 'proposal-strategist'],
  '产品管理': ['product-manager', 'project-shepherd', 'sprint-prioritizer', 'workflow-', 'experiment-tracker', 'feedback-synthesizer', 'senior-project', 'jira-workflow'],
  '数据分析': ['analytics-reporter', 'data-consolidation', 'data-engineer', 'executive-summary', 'report-distribution', 'test-results', 'performance-benchmarker'],
  '安全合规': ['compliance', 'legal-compliance', 'healthcare-marketing-compliance', 'threat-detection', 'incident-response', 'automation-governance', 'evidence-collector', 'reality-checker'],
  'XR/空间': ['xr-', 'visionos', 'macos-spatial', 'filament-optimization'],
  '人文研究': ['anthrop', 'psycholog', 'historian', 'geographer', 'cultural-intelligence', 'discovery-coach', 'accessibility-auditor', 'behavioral-nudge', 'identity-graph'],
};

function classifyAgent(slug, name, description) {
  const text = `${slug} ${(name || '').toLowerCase()} ${(description || '').toLowerCase()}`;
  for (const [domain, keywords] of Object.entries(DOMAIN_KEYWORDS)) {
    for (const kw of keywords) {
      if (text.includes(kw)) return domain;
    }
  }
  return '运营支持';
}

function loadDeletedSet() {
  try {
    if (!fs.existsSync(DELETED_FILE)) return new Set();
    const data = JSON.parse(fs.readFileSync(DELETED_FILE, 'utf8'));
    return new Set(Array.isArray(data) ? data : []);
  } catch {
    return new Set();
  }
}

function saveDeletedSet(names) {
  try {
    fs.mkdirSync(path.dirname(DELETED_FILE), { recursive: true });
    fs.writeFileSync(DELETED_FILE, JSON.stringify(names, null, 2), 'utf8');
  } catch (err) {
    console.error('[agent-store] 保存 .preset-deleted.json 失败:', err.message);
  }
}

function loadFromDir(dir, category) {
  if (!fs.existsSync(dir)) return;
  try {
    const deletedSet = category === 'preset' ? loadDeletedSet() : new Set();
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.md') || entry.name.startsWith('.')) continue;
      const slug = path.basename(entry.name, '.md');
      if (deletedSet.has(slug)) continue;
      try {
        const raw = fs.readFileSync(path.join(dir, entry.name), 'utf8');
        const { name, description, color, defaultRole, domain: fmDomain, body } = parseAgentFrontmatter(raw);
        agents[slug] = {
          slug,
          name: name || slug,
          description,
          color: color || '#6B7280',
          defaultRole: defaultRole || 'writer',
          body: body.trim(),
          category,
          domain: category === 'user' ? '用户' : (fmDomain || classifyAgent(slug, name, description)),
          filePath: path.join(dir, entry.name),
        };
      } catch (err) {
        console.error(`[agent-store] 加载 ${entry.name} 失败:`, err.message);
      }
    }
  } catch (err) {
    console.error(`[agent-store] 扫描 ${dir} 失败:`, err.message);
  }
}

function init() {
  agents = {};
  loadFromDir(SYSTEM_DIR, 'system');
  loadFromDir(PRESET_DIR, 'preset');
  loadFromDir(USER_DIR, 'user');
}

function list() {
  return Object.values(agents);
}

function get(slugOrName) {
  if (agents[slugOrName]) return agents[slugOrName];
  // fallback: match by display name (case-insensitive)
  const lower = slugOrName.toLowerCase();
  return Object.values(agents).find(a => a.name.toLowerCase() === lower) || null;
}

function create(slug, description, body, color = '#6B7280', defaultRole = 'writer', domain = '用户') {
  if (agents[slug]) return null;
  fs.mkdirSync(USER_DIR, { recursive: true });
  const frontmatter = `---\nname: ${slug}\ndescription: ${description}\nmode: subagent\ncolor: ${color}\ndefaultRole: ${defaultRole}\ndomain: ${domain}\n---\n\n${body}`;
  fs.writeFileSync(path.join(USER_DIR, `${slug}.md`), frontmatter, 'utf8');
  agents[slug] = { slug, name: slug, description, color, defaultRole, body, category: 'user', domain, filePath: path.join(USER_DIR, `${slug}.md`) };
  return agents[slug];
}

function update(slug, fields) {
  const agent = agents[slug];
  if (!agent || agent.category !== 'user') return null;
  const updated = {
    name: fields.name || agent.name,
    description: fields.description !== undefined ? fields.description : agent.description,
    color: fields.color || agent.color,
    defaultRole: fields.defaultRole || agent.defaultRole,
    body: fields.body !== undefined ? fields.body : agent.body,
  };
  const frontmatter = `---\nname: ${updated.name}\ndescription: ${updated.description}\nmode: subagent\ncolor: ${updated.color}\ndefaultRole: ${updated.defaultRole}\n---\n\n${updated.body}`;
  fs.writeFileSync(path.join(USER_DIR, `${slug}.md`), frontmatter, 'utf8');
  Object.assign(agent, updated);
  return agent;
}

function remove(slug) {
  const agent = agents[slug];
  if (!agent || agent.category === 'system') return false;
  if (agent.category === 'user') {
    try {
      if (fs.existsSync(agent.filePath)) fs.unlinkSync(agent.filePath);
    } catch (err) {
      console.error(`[agent-store] 删除用户代理文件失败:`, err.message);
      return false;
    }
  }
  if (agent.category === 'preset') {
    const deleted = loadDeletedSet();
    deleted.add(slug);
    saveDeletedSet([...deleted]);
  }
  delete agents[slug];
  return true;
}

function getAvailableForSystemPrompt() {
  return Object.values(agents).map(a => ({
    slug: a.slug,
    name: a.name,
    description: a.description,
    defaultRole: a.defaultRole,
  }));
}

module.exports = { init, list, get, create, update, remove, getAvailableForSystemPrompt };
