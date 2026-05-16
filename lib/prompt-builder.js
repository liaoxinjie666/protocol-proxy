const fs = require('fs');
const path = require('path');
const os = require('os');

const INSTRUCTIONS_PATH = path.join(os.homedir(), '.protocol-proxy', 'instructions.md');
const MAX_INSTRUCTIONS_CHARS = 4000;

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
 * 工具信息由 TOOL_DEFINITIONS 通过 API tools 参数单独传递，不在提示词中重复
 * @param {Object} opts
 * @param {Object} opts.skillStore - skillStore 模块
 * @param {Object} opts.mcpClient - mcpClient 模块
 */
function buildSystemPrompt({ skillStore, mcpClient }) {
  const now = new Date().toLocaleString('zh-CN', { hour12: false });

  const sections = [
    // 角色声明
    `你是 Protocol Proxy 的智能助手，帮助管理员管理和运维代理系统。当前时间：${now}`,

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
