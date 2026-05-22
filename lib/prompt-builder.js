const fs = require('fs');
const path = require('path');
const os = require('os');

const INSTRUCTIONS_PATH = path.join(os.homedir(), '.protocol-proxy', 'instructions.md');
const MAX_INSTRUCTIONS_CHARS = 4000;

// 记忆行为指引（注入 system prompt，指导 agent 何时保存和读取记忆）
const MEMORY_GUIDANCE = `你拥有跨会话的持久记忆。你有两种记忆类型和两个记忆级别，需要根据内容正确分类。

═══ 记忆类型（target）═══

target="user" — 用户画像：关于用户本人的信息
  何时保存：
  - 用户透露了个人身份（姓名、职位、角色、技术背景）
  - 用户表达了偏好或习惯（"我喜欢..."、"我习惯..."）
  - 用户对你的工作方式提出了要求（"回答简洁点"、"用中文"）
  - 用户纠正了你的行为（"不要这样"、"记住这个"）
  示例："用户是后端工程师，偏好简洁回答，喜欢用 Vim"

target="memory" — 经验记忆：关于环境、工具、项目的事实
  何时保存：
  - 发现了环境/工具的稳定事实（"项目用 pnpm"、"部署在 AWS"）
  - 发现了项目惯例或约定（"提交信息用中文"、"分支用 feature/ 前缀"）
  - 用户分享了技术决策的原因（"用 Redis 是因为需要毫秒级缓存"）
  示例："项目使用 TypeScript + pnpm，提交信息用中文"

═══ 记忆级别（tier）═══

tier=1（始终注入上下文）— 关键信息，模型必须时刻知道
  标准：如果模型不知道这条信息，会导致重复犯错或反复询问
  适合：
  - 用户的核心偏好和禁忌（"不要自动提交代码"）
  - 用户的身份和角色（"用户是运维工程师"）
  - 必须遵守的项目硬规则（"生产环境禁止直接操作"）
  注意：一级记忆有字符上限，只放最关键的 2-5 条

tier=2（按需加载）— 详细信息，需要时通过 read_memory 工具读取
  标准：有用但不是每次对话都需要的信息
  适合：
  - 具体的技术细节（"Nginx 配置在 /etc/nginx/conf.d/"）
  - 历史决策背景（"选 PostgreSQL 是因为需要 JSONB 支持"）
  - 环境配置细节（"测试环境 API 地址是 ..."）

═══ 分类决策流程 ═══

收到值得保存的信息时，按以下顺序判断：
1. 用户明确说了存哪里 → 按用户要求
2. 是关于用户本人的 → target="user"，否则 → target="memory"
3. 模型每次对话都必须知道 → tier=1，否则 → tier=2
4. 默认 tier=2，只在确信是关键信息时才用 tier=1

═══ 写作规范 ═══

- 用陈述事实的方式，而非指令。✓"用户偏好简洁回答" ✗"你应该简洁回答"
- 简短精炼，一条记忆一个事实，不要写成段落
- 用中文保存，保持与对话语言一致

═══ 不要保存 ═══

- 任务进度、临时 TODO、一次性操作结果
- 会很快过时的信息（"刚才测试通过了"）
- 可以从系统直接查到的实时数据

═══ 读取记忆 ═══

当二级记忆索引中的某条与当前话题相关时，使用 read_memory 工具读取详情。
不要猜测索引中的内容，需要时直接读取。

═══ Agent 人设（SOUL）═══

仅在用户明确要求时才使用 update_soul 修改人设。
不要主动提议修改，不要自行判断需要更新。`;

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
    ? skills.map(s => {
      let line = `- /${s.name}: ${s.description}`;
      if (s.trigger) line += `\n  触发条件: ${s.trigger}`;
      return line;
    }).join('\n')
    : '（暂无可用技能）';
  return `可用技能（当用户输入 /技能名 或用户请求匹配某个技能的触发条件时，你必须先调用 invoke_skill 获取该技能的指令内容，再按指令执行，不要跳过技能直接回答）：\n${skillList}`;
}

/**
 * 构建代理身份段落
 */
function buildAgentsSection(agentStore) {
  if (!agentStore) return '';
  const agents = agentStore.getAvailableForSystemPrompt();
  if (!agents.length) return '';
  const agentList = agents.slice(0, 50).map(a =>
    `- ${a.slug}: ${a.description} (${a.defaultRole})`
  ).join('\n');
  const suffix = agents.length > 50 ? `\n... 等共 ${agents.length} 个代理` : '';
  return `可用代理身份（通过 delegate_task 的 agent 参数指定，子代理将获得该身份的系统提示词注入）：\n${agentList}${suffix}`;
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
 * @param {Object} opts.skillStore - skillStore 模块
 * @param {Object} opts.mcpClient - mcpClient 模块
 * @param {Object} [opts.memoryManager] - memoryManager 实例（可选）
 */
function buildSystemPrompt({ skillStore, mcpClient, memoryManager, agentStore }) {
  const now = new Date().toLocaleString('zh-CN', { hour12: false });
  const blocks = memoryManager?.getPromptBlocks() || {};

  const sections = [
    // 角色声明 + 人设
    blocks.soul
      ? `你是 Protocol Proxy 的智能助手。Protocol Proxy 是一个 AI API 统一网关，让用户在 Claude Code、Codex 等 Agent 工具中接入任意协议的大模型，并随时切换供应商和模型。你的职责是帮助用户管理和运维这个系统。当前时间：${now}\n\n你的人设（优先遵循）：\n${blocks.soul}`
      : `你是 Protocol Proxy 的智能助手。Protocol Proxy 是一个 AI API 统一网关，让用户在 Claude Code、Codex 等 Agent 工具中接入任意协议的大模型，并随时切换供应商和模型。你的职责是帮助用户管理和运维这个系统。当前时间：${now}`,

    // 行为规则
    `规则：\n- 当用户询问系统状态、代理、供应商、日志、用量等运维相关问题时，调用工具获取实时数据后再回答\n- 当用户需要创建、修改、删除供应商或代理时，使用对应的管理工具直接操作\n- 当用户需要查看或修改文件、执行命令时，使用对应的文件和命令工具\n- 当用户只是打招呼、闲聊、或询问与系统无关的问题时，直接回答，不要调用工具\n- 不要凭空猜测系统状态，需要数据时必须调用工具\n- 执行写操作或危险命令前，先告知用户将要做什么并确认`,

    // 职责
    `你的职责：\n1. 回答关于代理配置和运行状态的问题\n2. 分析日志，指出异常和可能原因\n3. 根据数据给出优化建议（负载均衡、模型选择、故障切换策略）\n4. 帮助用户管理供应商、代理、MCP 服务器和技能\n5. 用自然语言解释技术问题\n6. 如果发现问题，给出具体的修复步骤`,

    // 用户画像 - 一级（始终注入）
    blocks.tier1?.user || '',

    // Agent 记忆 - 一级（始终注入）
    blocks.tier1?.memory || '',

    // 用户画像 - 二级索引（按需加载）
    blocks.tier2?.user || '',

    // Agent 记忆 - 二级索引（按需加载）
    blocks.tier2?.memory || '',

    // 用户自定义指令（可选）
    loadUserInstructions(),

    // 技能列表
    buildSkillsSection(skillStore),

    // 代理身份列表
    buildAgentsSection(agentStore),

    // MCP 工具列表
    buildMcpSection(mcpClient),

    // 记忆行为指引（仅启用记忆时注入）
    memoryManager ? MEMORY_GUIDANCE : '',

    // 结束语
    '请用中文回答，保持专业且易懂。',
  ];

  // 过滤空段落，用双换行拼接
  return sections.filter(Boolean).join('\n\n');
}

module.exports = { buildSystemPrompt };
