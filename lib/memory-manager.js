const logger = require('./logger');
const { MemoryStore } = require('./memory-store');

const DEFAULTS = {
  enabled: true,
  nudgeInterval: 10,
  soulEnabled: true,
  soulMaxChars: 2000,
  tier1Enabled: true,
  tier1MemoryMaxChars: 1500,
  tier1UserMaxChars: 1000,
  tier2MemoryEnabled: true,
  tier2MemoryMaxEntries: 20,
  tier2MemoryMaxChars: 3000,
  tier2UserEnabled: false,
  tier2UserMaxEntries: 10,
  tier2UserMaxChars: 2000,
};

const REVIEW_PROMPT = `回顾以上对话，判断是否有值得保存到记忆的信息。

操作步骤（必须按顺序执行）：
1. 先调用 get_memory 查看当前已有的所有记忆
2. 对比对话内容，识别出已有记忆中**没有覆盖**的新信息
3. 只保存新信息，不要用不同的措辞重复已有记忆

重点关注：
1. 用户是否透露了自己的偏好、习惯、角色、技术背景等个人信息？
2. 用户是否对你应该如何工作、沟通风格、行为期望表达了要求？
3. 是否发现了关于环境、工具使用、项目惯例的稳定事实？

保存规则：
- target='user'：用户画像信息（姓名、角色、偏好、沟通风格等）
- target='memory'：经验笔记（环境事实、工具惯例、项目约定等）
- 默认使用 tier=2（按需加载），仅在信息极其关键时使用 tier=1
- 用陈述事实的方式写记忆，简短精炼，一条一个事实

不要保存：任务进度、临时 TODO、会话结果、会很快过时的信息。
如果已有记忆已覆盖对话中的所有重要信息，直接说"无需保存"即可。`;

// 审查子智能体可用的工具定义
const REVIEW_TOOL_DEFINITIONS = [
  {
    type: 'function',
    function: {
      name: 'save_memory',
      description: '保存一条持久记忆。记忆会跨会话保留并注入到未来的对话中。tier=1 始终注入，tier=2 按需加载。',
      parameters: {
        type: 'object',
        properties: {
          target: {
            type: 'string',
            enum: ['memory', 'user'],
            description: "记忆类型：'user' 存用户画像，'memory' 存经验笔记",
          },
          content: {
            type: 'string',
            description: '记忆内容，应为简短的事实性陈述',
          },
          summary: {
            type: 'string',
            description: '摘要，不超过50个字符，概括这条记忆的核心要点',
          },
          tier: {
            type: 'number',
            enum: [1, 2],
            description: '记忆级别：1=始终注入(默认)，2=按需加载',
          },
        },
        required: ['target', 'content', 'summary'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_memory',
      description: '查看当前已保存的记忆内容',
      parameters: { type: 'object', properties: {} },
    },
  },
];

class MemoryManager {
  constructor(opts = {}) {
    const settings = opts.settings || {};
    this.enabled = this._getBool(settings, 'memory.enabled', DEFAULTS.enabled);
    this.nudgeInterval = this._getInt(settings, 'memory.nudgeInterval', DEFAULTS.nudgeInterval);
    this.soulEnabled = this._getBool(settings, 'memory.soul.enabled', DEFAULTS.soulEnabled);
    this.soulMaxChars = this._getInt(settings, 'memory.soul.maxChars', DEFAULTS.soulMaxChars);
    this.tier1Enabled = this._getBool(settings, 'memory.tier1.enabled', DEFAULTS.tier1Enabled);
    this.tier1MemoryMaxChars = this._getInt(settings, 'memory.tier1.memoryMaxChars', DEFAULTS.tier1MemoryMaxChars);
    this.tier1UserMaxChars = this._getInt(settings, 'memory.tier1.userMaxChars', DEFAULTS.tier1UserMaxChars);
    this.tier2MemoryEnabled = this._getBool(settings, 'memory.tier2.memoryEnabled', DEFAULTS.tier2MemoryEnabled);
    this.tier2MemoryMaxEntries = this._getInt(settings, 'memory.tier2.memoryMaxEntries', DEFAULTS.tier2MemoryMaxEntries);
    this.tier2MemoryMaxChars = this._getInt(settings, 'memory.tier2.memoryMaxChars', DEFAULTS.tier2MemoryMaxChars);
    this.tier2UserEnabled = this._getBool(settings, 'memory.tier2.userEnabled', DEFAULTS.tier2UserEnabled);
    this.tier2UserMaxEntries = this._getInt(settings, 'memory.tier2.userMaxEntries', DEFAULTS.tier2UserMaxEntries);
    this.tier2UserMaxChars = this._getInt(settings, 'memory.tier2.userMaxChars', DEFAULTS.tier2UserMaxChars);

    this.store = new MemoryStore({
      memoryCharLimit: this.tier1MemoryMaxChars,
      userCharLimit: this.tier1UserMaxChars,
    });

    this._turnCounter = 0;
    this._soul = '';
  }

  initialize() {
    if (!this.enabled) {
      logger.log('[memory] 记忆系统已禁用');
      return;
    }
    this.store.loadFromDisk();
    this._soul = this.store.loadSoul();
    const memT1 = this.store.loadTier1('memory') ? '✓' : '—';
    const memT2 = this.store.getTier2Count('memory');
    const userT1 = this.store.loadTier1('user') ? '✓' : '—';
    const userT2 = this.store.getTier2Count('user');
    const mode = this._getModeLabel();
    logger.log(`[memory] 已加载: 经验T1=${memT1} T2=${memT2}条, 画像T1=${userT1} T2=${userT2}条${this._soul ? ', SOUL=✓' : ''} (${mode})`);
  }

  _getModeLabel() {
    const hasTier2 = this.tier2MemoryEnabled || this.tier2UserEnabled;
    if (this.tier1Enabled && hasTier2) return '混合模式';
    if (this.tier1Enabled) return 'Hermes 模式';
    if (hasTier2) return 'Claude Code 模式';
    return '记忆注入已关闭';
  }

  /**
   * 获取用于注入 system prompt 的记忆段落
   */
  getPromptBlocks() {
    if (!this.enabled) return { soul: '', tier1: { memory: '', user: '' }, tier2: { memory: '', user: '' } };

    const soul = this.soulEnabled ? (this._soul || '') : '';

    let tier1 = { memory: '', user: '' };
    let tier2 = { memory: '', user: '' };

    if (this.tier1Enabled) {
      tier1.memory = this.store.renderTier1Block('memory');
      tier1.user = this.store.renderTier1Block('user');
    }

    if (this.tier2MemoryEnabled) tier2.memory = this.store.renderTier2Index('memory');
    if (this.tier2UserEnabled) tier2.user = this.store.renderTier2Index('user');

    return { soul, tier1, tier2 };
  }

  /**
   * 读取指定条目详情（供 read_memory 工具使用）
   */
  readMemory(target, idx) {
    const entry = this.store.getEntryByIndex(target, idx);
    if (!entry) return { error: '未找到该记忆条目' };
    return {
      idx: entry.idx,
      content: entry.content,
      target,
    };
  }

  /**
   * 每轮对话结束后调用，递增计数器
   * @returns {boolean} 是否应该触发后台审查
   */
  onTurnCompleted() {
    if (!this.enabled || this.nudgeInterval <= 0) return false;
    this._turnCounter++;
    return this._turnCounter > 0 && this._turnCounter % this.nudgeInterval === 0;
  }

  /**
   * 发起后台记忆审查（通过子智能体）
   */
  async triggerReview({
    proxyUrl,
    proxyHeaders,
    defaultModel,
    toolHandlers,
    messages,
    sendSSE,
    config,
  }) {
    if (!proxyUrl) {
      logger.warn('[memory] 无法发起审查：无可用代理');
      return;
    }

    try {
      const { delegateTask, registry } = require('./multi-agent');

      const reviewHandlers = {
        save_memory: toolHandlers.save_memory,
        get_memory: toolHandlers.get_memory,
      };

      const conversationText = (messages || [])
        .filter(m => m.role === 'user' || m.role === 'assistant')
        .map(m => {
          const role = m.role === 'user' ? '用户' : '助手';
          const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content || '');
          return `[${role}]: ${content.slice(0, 500)}`;
        })
        .join('\n');

      const goal = `${REVIEW_PROMPT}\n\n---\n以下是最近的对话记录：\n${conversationText.slice(0, 8000)}`;

      logger.log('[memory] 触发后台记忆审查');

      await delegateTask({
        goals: [goal],
        registry,
        proxyUrl,
        proxyHeaders,
        defaultModel,
        toolDefinitions: REVIEW_TOOL_DEFINITIONS,
        toolHandlers: reviewHandlers,
        systemPrompt: '你是一个记忆审查助手。你的唯一任务是回顾对话，提取值得记住的信息并保存。不要执行任何其他操作。',
        parentTaskId: null,
        maxRounds: 2,
        sendSSE: undefined,
        config: { ...config, blockedTools: [], autoDenyTools: [], maxConcurrent: 1 },
        silent: true,
      });

      logger.log('[memory] 后台记忆审查完成');
    } catch (err) {
      logger.warn('[memory] 后台审查失败:', err.message);
    }
  }

  // ── Settings helpers ──

  _getBool(obj, key, def) {
    const v = obj[key];
    if (v === undefined || v === null) return def;
    if (typeof v === 'boolean') return v;
    if (typeof v === 'string') return v === 'true' || v === '1';
    return !!v;
  }

  _getInt(obj, key, def) {
    const v = obj[key];
    if (v === undefined || v === null) return def;
    const n = parseInt(v, 10);
    return isNaN(n) ? def : n;
  }
}

module.exports = { MemoryManager, REVIEW_PROMPT };
