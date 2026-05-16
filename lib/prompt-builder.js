const fs = require('fs');
const path = require('path');
const os = require('os');

const INSTRUCTIONS_PATH = path.join(os.homedir(), '.protocol-proxy', 'instructions.md');
const MAX_INSTRUCTIONS_CHARS = 4000;

// 工具分组定义：组名 → 工具名列表
// 不在此表中的工具会归入"其他"组
const TOOL_GROUPS = [
  {
    name: '系统查询',
    tools: [
      'get_system_status', 'get_providers', 'get_provider', 'get_proxies', 'get_proxy',
      'get_usage_stats', 'get_recent_requests', 'get_system_logs', 'get_key_health',
      'get_settings', 'get_config_history', 'check_health', 'trigger_key_health_check',
      'get_mcp_servers', 'get_mcp_tools', 'get_skills',
    ],
  },
  {
    name: '供应商管理',
    tools: ['create_provider', 'update_provider', 'delete_provider', 'test_provider_keys', 'get_provider_models'],
  },
  {
    name: '代理管理',
    tools: ['create_proxy', 'update_proxy', 'delete_proxy', 'start_proxy', 'stop_proxy', 'start_all_proxies', 'stop_all_proxies'],
  },
  {
    name: 'MCP 服务器管理',
    tools: ['add_mcp_server', 'update_mcp_server', 'delete_mcp_server', 'connect_mcp_server', 'disconnect_mcp_server'],
  },
  {
    name: '技能管理',
    tools: ['create_skill', 'update_skill', 'delete_skill'],
  },
  {
    name: '配置管理',
    tools: ['export_config', 'import_config', 'rollback_config', 'update_settings'],
  },
  {
    name: '文件与命令',
    tools: ['read_file', 'write_file', 'edit_file', 'list_directory', 'search_files', 'grep_search', 'execute_command'],
  },
];

// 构建反向映射：toolName → groupName
const toolGroupMap = new Map();
for (const group of TOOL_GROUPS) {
  for (const tool of group.tools) {
    toolGroupMap.set(tool, group.name);
  }
}

/**
 * 从 TOOL_DEFINITIONS 数组自动生成工具目录文本
 * 按预定义分组排列，未分组的工具归入"其他"
 */
function buildToolCatalog(toolDefinitions) {
  // 收集所有工具名和描述
  const toolMap = new Map();
  for (const def of toolDefinitions) {
    const fn = def.function;
    if (!fn) continue;
    toolMap.set(fn.name, fn.description || fn.name);
  }

  // invoke_skill 不列入目录（在技能段落单独处理）
  toolMap.delete('invoke_skill');

  // 按组输出
  const grouped = new Set();
  const lines = [];

  for (const group of TOOL_GROUPS) {
    const entries = [];
    for (const name of group.tools) {
      if (!toolMap.has(name)) continue;
      entries.push(`- ${name}: ${toolMap.get(name)}`);
      grouped.add(name);
    }
    if (entries.length > 0) {
      lines.push(`${group.name}：`);
      lines.push(...entries);
      lines.push('');
    }
  }

  // 未分组的工具
  const ungrouped = [];
  for (const [name, desc] of toolMap) {
    if (!grouped.has(name)) {
      ungrouped.push(`- ${name}: ${desc}`);
    }
  }
  if (ungrouped.length > 0) {
    lines.push('其他：');
    lines.push(...ungrouped);
    lines.push('');
  }

  return lines.join('\n').trimEnd();
}

/**
 * 读取用户自定义指令文件
 * 不存在时返回空字符串
 */
function loadUserInstructions() {
  try {
    if (!fs.existsSync(INSTRUCTIONS_PATH)) return '';
    const content = fs.readFileSync(INSTRUCTIONS_PATH, 'utf8').trim();
    if (!content) return '';
    const truncated = content.length > MAX_INSTRUCTIONS_CHARS
      ? content.slice(0, MAX_INSTRUCTIONS_CHARS) + '\n...(已截断)'
      : content;
    return `用户自定义指令：\n${truncated}`;
  } catch {
    return '';
  }
}

/**
 * 构建技能段落
 */
function buildSkillsSection(skillStore) {
  const skills = skillStore.getAvailableForChat();
  const skillList = skills.length
    ? skills.map(s => `- /${s.name}: ${s.description}`).join('\n')
    : '（暂无可用技能）';
  return `可用技能（当用户输入 /技能名 时，调用 invoke_skill 获取指令并遵循执行）：\n${skillList}`;
}

/**
 * 构建 MCP 工具段落
 */
function buildMcpSection(mcpClient) {
  const mcpStatus = mcpClient.getStatus();
  const connected = mcpStatus.filter(s => s.status === 'connected' && s.tools.length);
  const degraded = mcpStatus.filter(s => s.status !== 'connected');

  let out = connected.length
    ? connected.map(s => `- [${s.name}] ${s.tools.map(t => t.name + (t.description ? ': ' + t.description : '')).join(', ')}`).join('\n')
    : '（暂无已连接的 MCP 服务）';

  if (degraded.length) {
    out += '\n\n⚠️ 以下 MCP 服务当前不可用，相关工具无法使用：\n'
      + degraded.map(s => `- ${s.name}（${s.status}${s.lastError ? ': ' + s.lastError : ''}）`).join('\n');
  }

  return `MCP 外部工具（通过 MCP 协议接入的第三方工具，名称以 mcp__ 开头）：\n${out}`;
}

/**
 * 组装完整系统提示词
 * @param {Object} opts
 * @param {Array} opts.toolDefinitions - TOOL_DEFINITIONS 数组
 * @param {Object} opts.skillStore - skillStore 模块
 * @param {Object} opts.mcpClient - mcpClient 模块
 */
function buildSystemPrompt({ toolDefinitions, skillStore, mcpClient }) {
  const now = new Date().toLocaleString('zh-CN', { hour12: false });

  const sections = [
    // 角色声明
    `你是 Protocol Proxy 的智能助手，帮助管理员管理和运维代理系统。当前时间：${now}`,

    // 工具目录（自动生成）
    `你有以下工具可以调用：\n\n${buildToolCatalog(toolDefinitions)}`,

    // 行为规则
    `规则：\n- 当用户询问系统状态、代理、供应商、日志、用量等运维相关问题时，调用工具获取实时数据后再回答\n- 当用户需要创建、修改、删除供应商或代理时，使用对应的管理工具直接操作\n- 当用户需要查看或修改文件、执行命令时，使用对应的文件和命令工具\n- 当用户只是打招呼、闲聊、或询问与系统无关的问题时，直接回答，不要调用工具\n- 不要凭空猜测系统状态，需要数据时必须调用工具\n- 执行写操作或危险命令前，先告知用户将要做什么并确认`,

    // 职责
    `你的职责：\n1. 回答关于代理配置和运行状态的问题\n2. 分析日志，指出异常和可能原因\n3. 根据数据给出优化建议（负载均衡、模型选择、故障切换策略）\n4. 帮助用户管理供应商、代理、MCP 服务器和技能\n5. 用自然语言解释技术问题\n6. 如果发现问题，给出具体的修复步骤`,

    // 用户自定义指令（可选）
    loadUserInstructions(),

    // 技能列表
    buildSkillsSection(skillStore),

    // MCP 工具列表
    buildMcpSection(mcpClient),

    // 结束语
    '请用中文回答，保持专业且易懂。',
  ];

  // 过滤空段落，用双换行拼接
  return sections.filter(Boolean).join('\n\n');
}

module.exports = { buildSystemPrompt };
