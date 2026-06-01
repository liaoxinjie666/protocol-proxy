// ================================================
// Protocol Proxy — App Logic
// ================================================

// ---------- State ----------
let proxies = [];
let providers = [];
let keyHealth = {};
let requestLogs = [];
let ws = null;
let statsRange = 'daily';
let statsProxyId = '';
let importData = null;
let editingProxyId = null;
let editingProviderId = null;
let currentPage = 'dashboard';
let providerPoolItems = [];
let providerModelTags = [];
let providerKeys = [];
const assistantConvMessages = new Map();   // convId → [{id, role, content, backendMsgId}]
const assistantConvControllers = new Map(); // convId → AbortController
const assistantConvContext = new Map();     // convId → {tokens, maxTokens, percent, messages}
const assistantPendingApprovals = new Map(); // convId → [{data, resolve}]
const assistantConvCompleted = new Set();   // 后台会话已完成任务的 convId 集合
const assistantStreamingConvs = new Set();  // 正在流式输出的会话 realId 集合
let assistantDisplayedConvId = '';          // 当前显示在 DOM 中的会话 ID
let loadConvoGeneration = 0;               // loadConversations 防过期计数器
const delegateCards = new Map(); // createdId → { msgId, tasks: Map<taskId, {objective, status}> }
let assistantAttachments = []; // 待上传的多模态附件 [{type, data, mimeType, name}]
let assistantProxyId = '';
let assistantProviderId = ''; // 用于级联选择的模型列表
let assistantModel = ''; // 当前选中的模型名
let proxyProviders = []; // 当前代理的候选供应商列表
let savedAssistantProxyId = ''; // 从设置恢复的上次选择
let savedAssistantProviderId = '';
let savedAssistantModel = '';
let assistantConversationId = '';
let pureConversationId = ''; // 纯净模式独立会话 ID
let assistantChatMode = 'full';
let assistantWindowSize = 20;
let assistantPureMode = false; // true = 纯净模式
let contextTokens = 0;
let contextMaxTokens = 200000;
let contextPercent = 0;
let contextMessages = 0;

// Per-conversation message accessors
function getCurrentConvMessages() {
  if (!assistantDisplayedConvId) return [];
  return getConvMessages(assistantDisplayedConvId);
}
function getConvMessages(convId) {
  let msgs = assistantConvMessages.get(convId);
  if (!msgs) { msgs = []; assistantConvMessages.set(convId, msgs); }
  return msgs;
}
let assistantMaxRounds = 10;
let skillAcIndex = -1; // 自动补全高亮索引

// ---------- Slash Commands ----------
const SLASH_COMMANDS = [
  { name: 'help', description: '显示帮助信息' },
  { name: 'clear', description: '清空当前对话' },
  { name: 'new', description: '开启新会话' },
  { name: 'compact', description: '压缩对话历史' },
  { name: 'model', description: '切换模型' },
];

// ---------- Theme ----------
const THEMES = [
  { id: 'dark', icon: '\u263E', label: '\u6df1\u8272' },
  { id: 'light', icon: '\u2600', label: '\u6d45\u8272' },
  { id: 'midnight', icon: '\u2726', label: '\u5348\u591c\u7d2b' },
  { id: 'forest', icon: '\u2638', label: '\u68ee\u6797\u7eff' },
  { id: 'sunset', icon: '\u2605', label: '\u65e5\u843d\u6a59' },
  { id: 'ocean', icon: '\u265B', label: '\u6d77\u6d0b\u9752' },
  { id: 'sakura', icon: '\u273F', label: '\u6a31\u82b1\u7c89' },
];

function applyTheme(themeId) {
  const t = THEMES.find(t => t.id === themeId) || THEMES[0];
  document.documentElement.setAttribute('data-theme', t.id);
  const icon = document.getElementById('theme-icon');
  const label = document.getElementById('theme-label');
  const select = document.getElementById('settings-theme');
  if (icon) icon.textContent = t.icon;
  if (label) label.textContent = t.label;
  if (select) select.value = t.id;
  localStorage.setItem('theme', t.id);
}

function cycleTheme() {
  const current = document.documentElement.getAttribute('data-theme') || 'dark';
  const idx = THEMES.findIndex(t => t.id === current);
  const next = THEMES[(idx + 1) % THEMES.length];
  applyTheme(next.id);
  fetch('/api/settings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ theme: next.id }),
  }).catch(() => {});
}

(async () => {
  try {
    const res = await fetch('/api/settings');
    const settings = await res.json();
    applyTheme(settings.theme || localStorage.getItem('theme') || 'dark');
    if (settings.maxContext) contextMaxTokens = parseInt(settings.maxContext) || 200000;
    if (settings.maxRounds) assistantMaxRounds = Math.max(1, Math.min(100, parseInt(settings.maxRounds) || 10));
    // 更新设置页输入框（此时 DOM 已加载）
    const mcInput = document.getElementById('settings-max-conversations');
    if (mcInput && settings.maxConversations !== undefined) mcInput.value = settings.maxConversations;
    const mcxInput = document.getElementById('settings-max-context');
    if (mcxInput) mcxInput.value = contextMaxTokens;
    const mrInput = document.getElementById('settings-max-rounds');
    if (mrInput) mrInput.value = assistantMaxRounds;
    // 子智能体设置
    const agentDefaults = { 'agent.maxConcurrent': 3, 'agent.maxRounds': 5, 'agent.timeout': 300 };
    const agentNumFields = { 'agent.maxConcurrent': 'settings-agent-max-concurrent', 'agent.maxRounds': 'settings-agent-max-rounds', 'agent.timeout': 'settings-agent-timeout', 'agent.maxRetries': 'settings-agent-maxRetries' };
    for (const [key, elId] of Object.entries(agentNumFields)) {
      const el = document.getElementById(elId);
      if (el) el.value = settings[key] !== undefined ? settings[key] : agentDefaults[key];
    }
    // 加载工具列表用于权限配置
    loadAgentToolsConfig(settings);
    // 记忆系统设置
    const memFields = {
      'memory.enabled': { id: 'settings-memory-enabled', type: 'bool', def: true },
      'memory.soul.enabled': { id: 'settings-soul-enabled', type: 'bool', def: true },
      'memory.soul.maxChars': { id: 'settings-soul-max-chars', type: 'num', def: 2000 },
      'memory.tier1.enabled': { id: 'settings-tier1-enabled', type: 'bool', def: true },
      'memory.tier1.memoryMaxChars': { id: 'settings-tier1-memory-max-chars', type: 'num', def: 1500 },
      'memory.tier1.userMaxChars': { id: 'settings-tier1-user-max-chars', type: 'num', def: 1000 },
      'memory.tier2.memoryEnabled': { id: 'settings-tier2-memory-enabled', type: 'bool', def: true },
      'memory.tier2.memoryMaxEntries': { id: 'settings-tier2-memory-max-entries', type: 'num', def: 20 },
      'memory.tier2.memoryMaxChars': { id: 'settings-tier2-memory-max-chars', type: 'num', def: 3000 },
      'memory.tier2.userEnabled': { id: 'settings-tier2-user-enabled', type: 'bool', def: false },
      'memory.tier2.userMaxEntries': { id: 'settings-tier2-user-max-entries', type: 'num', def: 10 },
      'memory.tier2.userMaxChars': { id: 'settings-tier2-user-max-chars', type: 'num', def: 2000 },
    };
    for (const [key, spec] of Object.entries(memFields)) {
      const el = document.getElementById(spec.id);
      if (!el) continue;
      const val = settings[key] !== undefined ? settings[key] : spec.def;
      if (spec.type === 'bool') el.checked = !!val;
      else el.value = val;
    }
    // 恢复助手选择
    if (settings.assistantProxyId) savedAssistantProxyId = settings.assistantProxyId;
    if (settings.assistantProviderId) savedAssistantProviderId = settings.assistantProviderId;
    if (settings.assistantModel) savedAssistantModel = settings.assistantModel;
    if (settings.assistantPermissionLevel) {
      const permSel = document.getElementById('assistant-permission-select');
      if (permSel) permSel.value = settings.assistantPermissionLevel;
    }
    if (settings.assistantThinkingEffort) {
      const thinkSel = document.getElementById('assistant-thinking-select');
      if (thinkSel) thinkSel.value = settings.assistantThinkingEffort;
    }
    if (settings.assistantConversationId) {
      assistantConversationId = settings.assistantConversationId;
    }
    if (settings.pureConversationId) {
      pureConversationId = settings.pureConversationId;
    }
    if (settings.assistantChatMode) {
      assistantChatMode = settings.assistantChatMode;
      const modeSel = document.getElementById('assistant-mode-select');
      if (modeSel) modeSel.value = assistantChatMode;
    }
    if (settings.assistantWindowSize) {
      assistantWindowSize = settings.assistantWindowSize;
      const wsInput = document.getElementById('settings-window-size');
      if (wsInput) wsInput.value = assistantWindowSize;
    }
    if (settings.assistantPureMode) {
      assistantPureMode = true;
      const toggle = document.getElementById('assistant-mode-toggle');
      if (toggle) toggle.classList.add('pure');
      updateWelcomeMessage();
    }
    // 恢复快捷助手配置
    if (typeof initFloatingConfigFromSettings === 'function') initFloatingConfigFromSettings(settings);
    // 加载开机自启状态
    try {
      const asRes = await fetch('/api/autostart');
      const asInfo = await asRes.json();
      const asCb = document.getElementById('settings-autostart');
      if (asCb && asInfo.supported !== false) asCb.checked = !!asInfo.enabled;
    } catch {}
  } catch {
    applyTheme(localStorage.getItem('theme') || 'dark');
  }
})();

// ---------- Navigation ----------
function navigateTo(page) {
  currentPage = page;
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  const target = document.getElementById('page-' + page);
  if (target) target.classList.add('active');
  const nav = document.querySelector('.nav-item[data-page="' + page + '"]');
  if (nav) nav.classList.add('active');

  const titles = {
    dashboard: '\u603b\u89c8',
    proxies: '\u4ee3\u7406\u7ba1\u7406',
    providers: '\u4f9b\u5e94\u5546\u7ba1\u7406',
    multimodal: '\u591a\u6a21\u6001\u670d\u52a1',
    stats: '\u7528\u91cf\u7edf\u8ba1',
    'request-logs': '\u8bf7\u6c42\u65e5\u5fd7',
    'system-logs': '\u7cfb\u7edf\u65e5\u5fd7',
    assistant: '\u667a\u63a7\u52a9\u624b',
    skills: '\u6280\u80fd\u7ba1\u7406',
    agents: '\u8eab\u4efd\u7ba1\u7406',
    'mcp-servers': 'MCP \u670d\u52a1',
    memory: '\u8bb0\u5fc6\u7ba1\u7406',
    tasks: '\u4efb\u52a1\u7ba1\u7406',
    settings: '\u8bbe\u7f6e',
  };
  document.getElementById('page-title').textContent = titles[page] || page;

  // Refresh data for specific pages
  if (page === 'dashboard') refreshDashboard();
  if (page === 'proxies') renderProxies();
  if (page === 'providers') renderProviders();
  if (page === 'stats') loadStats();
  if (page === 'system-logs') loadLogs();
  if (page === 'request-logs') renderRequestLogs();
  if (page === 'assistant') {
    populateAssistantProxySelect();
    loadConversations();
    loadAssistantSkills();
    // 恢复上次会话（仅当需要切换显示目标时）
    if (assistantConversationId && assistantConversationId !== assistantDisplayedConvId) {
      setTimeout(() => switchConversation(assistantConversationId), 300);
    } else if (assistantConversationId) {
      // 已在显示中，更新 send button 状态
      setSendBtnState(assistantConvControllers.has(assistantDisplayedConvId));
    }
  }
  if (page === 'skills') loadSkills();
  if (page === 'agents') loadAgents();
  if (page === 'settings') { populateFloatingProxySelect(); }
  if (page === 'mcp-servers') loadMcpServers();
  if (page === 'memory') loadMemoryPage();
  if (page === 'tasks') loadTasks();
  if (page === 'settings') loadExecPolicy();
}

document.querySelectorAll('.nav-item[data-page]').forEach(item => {
  item.addEventListener('click', (e) => {
    e.preventDefault();
    navigateTo(item.dataset.page);
  });
});

// ---------- Data Loading ----------
async function loadProxies() {
  try {
    const res = await fetch('/api/proxies');
    proxies = await res.json();
    document.getElementById('nav-proxy-count').textContent = proxies.length;
    toggleOnboardingBanner();
    if (currentPage === 'proxies') renderProxies();
    if (currentPage === 'dashboard') renderDashProxies();
    updateDashStats();
    populateProxyFilterOptions();
  } catch (err) {
    console.error('loadProxies error:', err);
  }
}

function toggleOnboardingBanner() {
  const banner = document.getElementById('onboarding-banner');
  if (banner) banner.style.display = proxies.length === 0 ? '' : 'none';
}

async function loadProviders() {
  try {
    const res = await fetch('/api/providers');
    providers = await res.json();
    document.getElementById('nav-provider-count').textContent = providers.length;
    if (currentPage === 'providers') renderProviders();
    if (currentPage === 'dashboard') renderDashProviderHealth();
    updateDashStats();
    populateProxyProviderSelect();
  } catch (err) {
    console.error('loadProviders error:', err);
  }
}

async function loadKeyHealth() {
  try {
    const res = await fetch('/api/key-health');
    keyHealth = await res.json();
    renderDashProviderHealth();
    updateTopbarHealth();
  } catch (err) {
    console.error('loadKeyHealth error:', err);
  }
}

async function loadStats() {
  try {
    const params = new URLSearchParams({ range: statsRange });
    if (statsProxyId) params.set('proxyId', statsProxyId);
    const start = document.getElementById('stats-start')?.value;
    const end = document.getElementById('stats-end')?.value;
    if (start) params.set('startDate', start);
    if (end) params.set('endDate', end);
    const res = await fetch('/api/stats?' + params);
    const data = await res.json();
    renderStats(data);
    updateDashStats(data);
  } catch (err) {
    console.error('loadStats error:', err);
  }
}

async function loadLogs() {
  try {
    const lines = document.getElementById('log-lines')?.value || 200;
    const res = await fetch('/api/logs?lines=' + lines);
    const data = await res.json();
    renderLogs(data.lines || []);
  } catch (err) {
    console.error('loadLogs error:', err);
  }
}

function refreshDashboard() {
  renderDashProxies();
  renderDashProviderHealth();
  renderDashRecentRequests();
  detectClientTools();
}

// ---------- Client Config (Claude Code / Codex) ----------
let ccCurrentTool = null;    // 'claude-code' | 'codex'
let ccCurrentStep = null;    // 'select-proxy' | 'install' | 'preview' | 'result'
let ccSelectedProxyId = null;
let ccToolInfo = null;       // { installed, configured, ... }

async function detectClientTools() {
  for (const toolId of ['claude-code', 'codex']) {
    const el = document.getElementById(toolId === 'claude-code' ? 'cc-status' : 'codex-status');
    if (!el) continue;
    try {
      const res = await fetch(`/api/client-config/detect/${toolId}`);
      const data = await res.json();
      if (!data.ok) { el.textContent = '检测失败'; continue; }
      if (!data.installed) {
        el.textContent = '未安装';
        el.className = 'client-config-status not-installed';
      } else if (data.configuredOurProxy) {
        el.textContent = '已配置 · 指向本代理';
        el.className = 'client-config-status configured';
      } else if (data.configured) {
        el.textContent = '已配置 · 指向其他代理';
        el.className = 'client-config-status configured-other';
      } else {
        el.textContent = '已安装 · 未配置';
        el.className = 'client-config-status not-configured';
      }
    } catch {
      el.textContent = '检测失败';
    }
  }
}

async function startClientConfig(toolId) {
  ccCurrentTool = toolId;
  ccSelectedProxyId = null;
  const toolName = toolId === 'claude-code' ? 'Claude Code' : 'Codex';
  document.getElementById('client-config-modal-title').textContent = `一键配置 ${toolName}`;

  // Hide all steps
  ['cc-step-select-proxy', 'cc-step-install', 'cc-step-preview', 'cc-step-result', 'cc-hint'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.display = 'none';
  });
  showModal('client-config-modal');

  // Step 1: Check proxies
  if (!proxies || proxies.length === 0) {
    // No proxies - show onboarding first
    hideModal('client-config-modal');
    navigateTo('proxies');
    openOnboardingModal();
    return;
  }

  // Step 2: Detect tool
  const detectRes = await fetch(`/api/client-config/detect/${toolId}`);
  const detectData = await detectRes.json();
  ccToolInfo = detectData;

  if (!detectData.ok) {
    showClientConfigResult(false, '检测工具状态失败');
    return;
  }

  if (!detectData.installed) {
    // Not installed - show install step
    showClientConfigInstall();
    return;
  }

  // Installed - select proxy (or auto-select if only one)
  if (proxies.length === 1) {
    ccSelectedProxyId = proxies[0].id;
    showClientConfigPreview();
  } else {
    showClientConfigSelectProxy();
  }
}

function showClientConfigSelectProxy() {
  ccCurrentStep = 'select-proxy';
  const stepEl = document.getElementById('cc-step-select-proxy');
  stepEl.style.display = '';
  document.getElementById('cc-install-log').className = 'cc-install-log';

  const listEl = document.getElementById('cc-proxy-list');
  listEl.innerHTML = proxies.map(p => {
    const provider = providers.find(pr => pr.id === p.providerId);
    return `<div class="cc-proxy-item" data-id="${p.id}" onclick="selectClientConfigProxy('${p.id}')">
      <div class="proxy-dot ${p.running ? 'running' : 'stopped'}"></div>
      <span class="proxy-name">${escapeHtml(p.name)}</span>
      <span class="proxy-port">:${p.port} · ${escapeHtml(provider?.name || '')}</span>
    </div>`;
  }).join('');

  const actionBtn = document.getElementById('cc-action-btn');
  actionBtn.textContent = '下一步';
  actionBtn.disabled = true;
}

function selectClientConfigProxy(proxyId) {
  ccSelectedProxyId = proxyId;
  document.querySelectorAll('.cc-proxy-item').forEach(el => {
    el.classList.toggle('selected', el.dataset.id === proxyId);
  });
  document.getElementById('cc-action-btn').disabled = false;
}

function showClientConfigInstall() {
  ccCurrentStep = 'install';
  const toolName = ccCurrentTool === 'claude-code' ? 'Claude Code' : 'Codex';
  document.getElementById('cc-install-label').textContent = `检测到未安装 ${toolName}，是否一键安装？`;
  document.getElementById('cc-step-install').style.display = '';
  document.getElementById('cc-install-log').className = 'cc-install-log';
  document.getElementById('cc-install-log').textContent = '';

  const actionBtn = document.getElementById('cc-action-btn');
  actionBtn.textContent = '安装';
  actionBtn.disabled = false;
}

function showClientConfigPreview() {
  ccCurrentStep = 'preview';
  const stepEl = document.getElementById('cc-step-preview');
  stepEl.style.display = '';

  const actionBtn = document.getElementById('cc-action-btn');
  actionBtn.textContent = '确认配置';
  actionBtn.disabled = true;

  // Ensure proxy is running
  const proxy = proxies.find(p => p.id === ccSelectedProxyId);
  if (proxy && !proxy.running) {
    fetch(`/api/proxies/${proxy.id}/start`, { method: 'POST' }).then(() => {
      loadProxies().then(() => fetchPreview());
    });
  } else {
    fetchPreview();
  }
}

async function fetchPreview() {
  try {
    const res = await fetch(`/api/client-config/preview/${ccCurrentTool}?proxyId=${ccSelectedProxyId}`);
    const data = await res.json();
    if (!data.ok) {
      showClientConfigResult(false, data.message);
      return;
    }

    const fileEl = document.getElementById('cc-preview-file');
    fileEl.textContent = data.willCreate
      ? `将创建: ${data.configPath}`
      : `修改: ${data.configPath}`;

    const changesEl = document.getElementById('cc-preview-changes');
    if (data.changes.length === 0) {
      changesEl.innerHTML = '<div class="cc-no-proxy-msg">配置已是最新，无需变更</div>';
      document.getElementById('cc-action-btn').disabled = true;
    } else {
      changesEl.innerHTML = data.changes.map(c => `<div class="cc-change-item">
        <div class="cc-change-field">${escapeHtml(c.field)}</div>
        <div><span class="cc-change-old">${escapeHtml(String(c.old))}</span> <span class="cc-change-arrow">→</span> <span class="cc-change-new">${escapeHtml(String(c.new))}</span></div>
      </div>`).join('');
      document.getElementById('cc-action-btn').disabled = false;
    }
  } catch {
    showClientConfigResult(false, '获取配置预览失败');
  }
}

function showClientConfigResult(success, message) {
  ccCurrentStep = 'result';
  ['cc-step-select-proxy', 'cc-step-install', 'cc-step-preview'].forEach(id => {
    document.getElementById(id).style.display = 'none';
  });
  document.getElementById('cc-step-result').style.display = '';
  document.getElementById('cc-result-icon').textContent = success ? '✅' : '❌';
  document.getElementById('cc-result-text').textContent = message;
  document.getElementById('cc-hint').style.display = success ? 'none' : '';

  const actionBtn = document.getElementById('cc-action-btn');
  actionBtn.textContent = '完成';
  actionBtn.onclick = () => closeClientConfigModal();
}

function closeClientConfigModal() {
  hideModal('client-config-modal');
  ccCurrentTool = null;
  ccCurrentStep = null;
  ccSelectedProxyId = null;
  // Reset action button onclick
  document.getElementById('cc-action-btn').onclick = clientConfigAction;
  detectClientTools();
}

async function clientConfigAction() {
  const actionBtn = document.getElementById('cc-action-btn');

  if (ccCurrentStep === 'select-proxy') {
    if (!ccSelectedProxyId) return;
    showClientConfigPreview();
  } else if (ccCurrentStep === 'install') {
    actionBtn.disabled = true;
    actionBtn.textContent = '安装中...';
    const logEl = document.getElementById('cc-install-log');
    logEl.className = 'cc-install-log active';
    const method = document.querySelector('input[name="cc-install-method"]:checked')?.value || 'npm';

    try {
      const res = await fetch(`/api/client-config/install/${ccCurrentTool}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ method }),
      });
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop();
        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const data = JSON.parse(line.slice(6));
            if (data.type === 'log') {
              logEl.textContent += data.message;
              logEl.scrollTop = logEl.scrollHeight;
            } else if (data.type === 'done') {
              if (data.ok) {
                showClientConfigResult(true, '安装成功');
              } else {
                // Show retry button
                actionBtn.disabled = false;
                actionBtn.textContent = '重试';
                actionBtn.onclick = () => {
                  actionBtn.textContent = '安装中...';
                  actionBtn.disabled = true;
                  logEl.textContent = '';
                  clientConfigAction();
                };
                document.getElementById('cc-hint').style.display = '';
              }
            }
          }
        }
      }
    } catch (err) {
      showClientConfigResult(false, `安装出错: ${err.message}`);
    }
  } else if (ccCurrentStep === 'preview') {
    actionBtn.disabled = true;
    actionBtn.textContent = '写入中...';
    try {
      const res = await fetch(`/api/client-config/write/${ccCurrentTool}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ proxyId: ccSelectedProxyId }),
      });
      const data = await res.json();
      if (data.ok) {
        showClientConfigResult(true, '配置完成，可以开始使用');
      } else {
        showClientConfigResult(false, data.message || '写入失败');
      }
    } catch (err) {
      showClientConfigResult(false, `写入出错: ${err.message}`);
    }
  }
}

// ---------- Dashboard Rendering ----------
function updateDashStats(statsData) {
  const running = proxies.filter(p => p.running).length;
  document.getElementById('dash-running').textContent = running;
  document.getElementById('dash-total').textContent = proxies.length;

  if (statsData) {
    document.getElementById('dash-tokens').textContent = formatTokens(statsData.summary?.total || 0);
    document.getElementById('dash-tokens-sub').textContent = (statsData.summary?.hasEstimated ? '\u542b\u4f30\u7b97 ' : '') + '\u4eca\u65e5';
    document.getElementById('dash-requests').textContent = (statsData.summary?.requests || 0).toLocaleString();
    document.getElementById('dash-requests-sub').textContent = statsData.byProvider?.length + ' \u4e2a\u4f9b\u5e94\u5546';
  }

  const healthStatuses = Object.values(keyHealth);
  const unhealthy = healthStatuses.filter(h => h.status === 'unhealthy').length;
  const partial = healthStatuses.filter(h => h.status === 'partial').length;
  if (unhealthy > 0) {
    document.getElementById('dash-health').textContent = unhealthy + '\u4e2a\u5f02\u5e38';
    document.getElementById('dash-health').style.color = 'var(--error)';
    document.getElementById('dash-health-sub').textContent = partial > 0 ? partial + ' \u4e2a\u90e8\u5206\u5f02\u5e38' : '\u9700\u8981\u5173\u6ce8';
  } else if (partial > 0) {
    document.getElementById('dash-health').textContent = partial + '\u4e2a\u8b66\u544a';
    document.getElementById('dash-health').style.color = 'var(--warning)';
    document.getElementById('dash-health-sub').textContent = '\u90e8\u5206 Key \u5f02\u5e38';
  } else {
    document.getElementById('dash-health').textContent = '\u6b63\u5e38';
    document.getElementById('dash-health').style.color = 'var(--success)';
    document.getElementById('dash-health-sub').textContent = '\u5168\u90e8\u4f9b\u5e94\u5546\u5065\u5eb7';
  }
}

function renderDashProxies() {
  const container = document.getElementById('dash-proxy-list');
  if (!container) return;
  if (proxies.length === 0) {
    container.innerHTML = '<div class="empty-sm">\u6682\u65e0\u4ee3\u7406\u914d\u7f6e</div>';
    return;
  }
  container.innerHTML = proxies.slice(0, 6).map(p => {
    const provider = providers.find(pr => pr.id === p.providerId);
    return `
      <div class="proxy-mini-item" onclick="navigateTo('proxies')">
        <div class="proxy-mini-status ${p.running ? 'running' : 'stopped'}"></div>
        <div class="proxy-mini-info">
          <div class="proxy-mini-name">${escapeHtml(p.name)}</div>
          <div class="proxy-mini-meta">${escapeHtml(provider?.name || p.providerId)}</div>
        </div>
        <div class="proxy-mini-port">:${p.port}</div>
      </div>
    `;
  }).join('');
}

function renderDashProviderHealth() {
  const container = document.getElementById('dash-provider-health');
  if (!container) return;
  if (providers.length === 0) {
    container.innerHTML = '<div class="empty-sm">\u6682\u65e0\u4f9b\u5e94\u5546</div>';
    return;
  }
  container.innerHTML = providers.map(p => {
    const h = keyHealth[p.id];
    let statusClass = 'unknown';
    let statusText = '\u672a\u68c0\u6d4b';
    if (h) {
      if (h.status === 'healthy') { statusClass = 'healthy'; statusText = '\u6b63\u5e38'; }
      else if (h.status === 'partial') { statusClass = 'partial'; statusText = '\u90e8\u5206\u5f02\u5e38'; }
      else if (h.status === 'unhealthy') { statusClass = 'unhealthy'; statusText = '\u5f02\u5e38'; }
    }
    return `
      <div class="provider-health-item">
        <div class="provider-health-name">${escapeHtml(p.name)}</div>
        <div class="provider-health-status ${statusClass}">${statusText}</div>
      </div>
    `;
  }).join('');
}

function renderDashRecentRequests() {
  const tbody = document.getElementById('dash-recent-requests');
  if (!tbody) return;
  const recent = requestLogs.slice(0, 8);
  if (recent.length === 0) {
    tbody.innerHTML = '<tr><td colspan="6" class="empty-cell">\u6682\u65e0\u8bf7\u6c42\u8bb0\u5f55</td></tr>';
    return;
  }
  tbody.innerHTML = recent.map(r => renderRequestLogRow(r, true)).join('');
}

function updateTopbarHealth() {
  const container = document.getElementById('topbar-health');
  if (!container) return;
  const statuses = Object.values(keyHealth);
  const unhealthy = statuses.filter(s => s.status === 'unhealthy').length;
  const partial = statuses.filter(s => s.status === 'partial').length;
  if (unhealthy > 0) {
    container.innerHTML = `<span class="health-dot error"></span>${unhealthy} \u4e2a\u4f9b\u5e94\u5546\u5f02\u5e38`;
  } else if (partial > 0) {
    container.innerHTML = `<span class="health-dot warn"></span>${partial} \u4e2a\u4f9b\u5e94\u5546\u8b66\u544a`;
  } else if (statuses.length > 0) {
    container.innerHTML = `<span class="health-dot ok"></span>\u5168\u90e8\u6b63\u5e38`;
  } else {
    container.innerHTML = '';
  }
}

// ---------- Proxy Page ----------
function renderProxies() {
  const grid = document.getElementById('proxy-grid');
  if (!grid) return;
  const search = (document.getElementById('proxy-search')?.value || '').toLowerCase();
  const filtered = proxies.filter(p =>
    !search ||
    p.name.toLowerCase().includes(search) ||
    String(p.port).includes(search) ||
    (p.providerName || '').toLowerCase().includes(search)
  );

  if (filtered.length === 0 && proxies.length === 0) {
    grid.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon"><svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><polygon points="12 2 2 7 12 12 22 7 12 2"></polygon><polyline points="2 17 12 22 22 17"></polyline><polyline points="2 12 12 17 22 12"></polyline></svg></div>
        <p>\u8fd8\u6ca1\u6709\u914d\u7f6e\u4ee3\u7406</p>
        <button class="btn btn-primary" onclick="openProxyModal()">\u521b\u5efa\u7b2c\u4e00\u4e2a\u4ee3\u7406</button>
      </div>`;
    return;
  }
  if (filtered.length === 0) {
    grid.innerHTML = '<div class="empty-state"><p>\u6ca1\u6709\u5339\u914d\u7684\u4ee3\u7406</p></div>';
    return;
  }

  grid.innerHTML = filtered.map(p => {
    const provider = providers.find(pr => pr.id === p.providerId);
    return `
      <div class="proxy-card ${p.running ? 'running' : 'stopped'}">
        <div class="proxy-card-header">
          <div class="proxy-card-title">${escapeHtml(p.name)}</div>
          <span class="proxy-card-badge ${p.running ? 'running' : 'stopped'}">${p.running ? '\u8fd0\u884c\u4e2d' : '\u5df2\u505c\u6b62'}</span>
        </div>
        <div class="proxy-card-meta">
          <div class="proxy-card-meta-item">
            <div class="proxy-card-meta-label">\u7aef\u53e3</div>
            <div class="proxy-card-meta-value">:${p.port}</div>
          </div>
          <div class="proxy-card-meta-item">
            <div class="proxy-card-meta-label">\u4f9b\u5e94\u5546</div>
            <div class="proxy-card-meta-value">${escapeHtml(provider?.name || p.providerId)}</div>
          </div>
          <div class="proxy-card-meta-item">
            <div class="proxy-card-meta-label">\u534f\u8bae</div>
            <div class="proxy-card-meta-value">${escapeHtml(p.protocol || provider?.protocol || 'openai')}</div>
          </div>
          <div class="proxy-card-meta-item">
            <div class="proxy-card-meta-label">\u8def\u7531</div>
            <div class="proxy-card-meta-value">${formatRouting(p.routingStrategy)}</div>
          </div>
        </div>
        ${p.defaultModel ? `<div style="margin-bottom:8px;font-size:12px;color:var(--text-muted);font-family:var(--font-mono)">\u9ed8\u8ba4\u6a21\u578b: ${escapeHtml(p.defaultModel)}</div>` : ''}
        ${p.providerPool && p.providerPool.length > 0 ? `<div class="proxy-pool-preview">\u5907\u9009: ${p.providerPool.map(item => { const fp = providers.find(x => x.id === item.providerId); return escapeHtml(fp?.name || item.providerId); }).join(' / ')}</div>` : ''}
        <div class="proxy-card-actions">
          ${p.running
            ? `<button class="btn btn-sm" onclick="stopProxy('${p.id}')">\u505c\u6b62</button>`
            : `<button class="btn btn-sm btn-primary" onclick="startProxy('${p.id}')">\u542f\u52a8</button>`
          }
          <button class="btn btn-sm" onclick="editProxy('${p.id}')">\u7f16\u8f91</button>
          <button class="btn btn-sm" onclick="copyProxyUrl('${p.id}')">\u590d\u5236\u5730\u5740</button>
          <button class="btn btn-sm" style="color:var(--error)" onclick="deleteProxy('${p.id}')">\u5220\u9664</button>
        </div>
      </div>
    `;
  }).join('');
}

function filterProxies() {
  renderProxies();
}

function formatRouting(s) {
  const map = {
    primary_fallback: '\u4e3b\u5907',
    round_robin: '\u8f6e\u8be2',
    weighted: '\u52a0\u6743',
    fastest: '\u6700\u5feb',
  };
  return map[s] || s;
}

async function startProxy(id) {
  try {
    await fetch(`/api/proxies/${id}/start`, { method: 'POST' });
    await loadProxies();
    showToast('\u4ee3\u7406\u5df2\u542f\u52a8');
  } catch (err) {
    showToast('\u542f\u52a8\u5931\u8d25: ' + err.message, true);
  }
}

async function stopProxy(id) {
  try {
    await fetch(`/api/proxies/${id}/stop`, { method: 'POST' });
    await loadProxies();
    showToast('\u4ee3\u7406\u5df2\u505c\u6b62');
  } catch (err) {
    showToast('\u505c\u6b62\u5931\u8d25: ' + err.message, true);
  }
}

async function startAllProxies() {
  try {
    const res = await fetch('/api/proxies/start-all', { method: 'POST' });
    const data = await res.json();
    await loadProxies();
    const success = data.results?.filter(r => r.success).length || 0;
    showToast(`\u542f\u52a8\u5b8c\u6210: ${success} / ${data.results?.length || 0}`);
  } catch (err) {
    showToast('\u6279\u91cf\u542f\u52a8\u5931\u8d25: ' + err.message, true);
  }
}

async function stopAllProxies() {
  try {
    await fetch('/api/proxies/stop-all', { method: 'POST' });
    await loadProxies();
    showToast('\u5168\u90e8\u4ee3\u7406\u5df2\u505c\u6b62');
  } catch (err) {
    showToast('\u6279\u91cf\u505c\u6b62\u5931\u8d25: ' + err.message, true);
  }
}

async function deleteProxy(id) {
  const p = proxies.find(x => x.id === id);
  if (!p) return;
  const ok = await showConfirm(`\u786e\u5b9a\u5220\u9664\u4ee3\u7406 <strong>${escapeHtml(p.name)}</strong>\uff1f`);
  if (!ok) return;
  try {
    await fetch(`/api/proxies/${id}`, { method: 'DELETE' });
    await loadProxies();
    showToast('\u4ee3\u7406\u5df2\u5220\u9664');
  } catch (err) {
    showToast('\u5220\u9664\u5931\u8d25: ' + err.message, true);
  }
}

function copyProxyUrl(id) {
  const p = proxies.find(x => x.id === id);
  if (!p) return;
  const url = `http://localhost:${p.port}`;
  navigator.clipboard.writeText(url).then(() => showToast('\u5730\u5740\u5df2\u590d\u5236'));
}

// ---------- Proxy Modal ----------
function openProxyModal() {
  editingProxyId = null;
  document.getElementById('proxy-modal-title').textContent = '\u65b0\u5efa\u4ee3\u7406';
  document.getElementById('proxy-id').value = '';
  document.getElementById('proxy-name').value = '';
  document.getElementById('proxy-port').value = '';
  document.getElementById('proxy-auth').value = 'false';
  document.getElementById('proxy-auth-token').value = '';
  document.getElementById('proxy-auth-token-group').style.display = 'none';
  document.getElementById('proxy-provider').value = '';
  document.getElementById('proxy-model').innerHTML = '<option value="">\u4f7f\u7528\u8bf7\u6c42\u6a21\u578b</option>';
  document.getElementById('proxy-routing').value = 'primary_fallback';
  document.getElementById('proxy-weight').value = '1';
  providerPoolItems = [];
  renderPoolEditor();
  populateProxyProviderSelect();
  showModal('proxy-modal');
}

function editProxy(id) {
  const p = proxies.find(x => x.id === id);
  if (!p) return;
  editingProxyId = id;
  document.getElementById('proxy-modal-title').textContent = '\u7f16\u8f91\u4ee3\u7406';
  document.getElementById('proxy-id').value = p.id;
  document.getElementById('proxy-name').value = p.name;
  document.getElementById('proxy-port').value = p.port;
  document.getElementById('proxy-auth').value = p.requireAuth ? 'true' : 'false';
  document.getElementById('proxy-auth-token').value = p.authToken || '';
  document.getElementById('proxy-auth-token-group').style.display = p.requireAuth ? '' : 'none';
  document.getElementById('proxy-provider').value = p.providerId || '';
  document.getElementById('proxy-routing').value = p.routingStrategy || 'primary_fallback';
  document.getElementById('proxy-weight').value = p.providerWeight || 1;
  populateProxyProviderSelect();
  updateProxyModelSelect(p.providerId, p.defaultModel);
  providerPoolItems = Array.isArray(p.providerPool) ? p.providerPool.map(x => ({...x})) : [];
  renderPoolEditor();
  showModal('proxy-modal');
}

function closeProxyModal() {
  hideModal('proxy-modal');
}


function populateProxyProviderSelect() {
  const select = document.getElementById('proxy-provider');
  const current = select.value;
  select.innerHTML = '<option value="">\u9009\u62e9\u4f9b\u5e94\u5546...</option>' +
    providers.map(p => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.name)}</option>`).join('');
  select.value = current || '';
}

function updateProxyModelSelect(providerId, selectedModel) {
  const select = document.getElementById('proxy-model');
  const provider = providers.find(p => p.id === providerId);
  const models = provider?.models || [];
  select.innerHTML = '<option value="">\u4f7f\u7528\u8bf7\u6c42\u6a21\u578b</option>' +
    models.map(m => `<option value="${escapeHtml(m.name)}">${escapeHtml(m.name)}</option>`).join('');
  if (selectedModel) select.value = selectedModel;
}

function renderPoolEditor() {
  const container = document.getElementById('proxy-pool-editor');
  if (providerPoolItems.length === 0) {
    container.innerHTML = '<div class="pool-empty">\u6682\u65e0\u5907\u9009\u4f9b\u5e94\u5546</div>';
    return;
  }
  container.innerHTML = providerPoolItems.map((item, i) => {
    const provider = providers.find(p => p.id === item.providerId);
    const models = provider?.models || [];
    return `
      <div class="pool-item">
        <select class="pool-item-select" onchange="updatePoolProvider(${i}, this.value)">
          <option value="">\u9009\u62e9\u4f9b\u5e94\u5546...</option>
          ${providers.map(p => `<option value="${escapeHtml(p.id)}" ${p.id === item.providerId ? 'selected' : ''}>${escapeHtml(p.name)}</option>`).join('')}
        </select>
        <select class="pool-item-select" onchange="updatePoolModel(${i}, this.value)">
          <option value="">\u9ed8\u8ba4\u6a21\u578b</option>
          ${models.map(m => `<option value="${escapeHtml(m.name)}" ${m.name === item.model ? 'selected' : ''}>${escapeHtml(m.name)}</option>`).join('')}
        </select>
        <input type="number" min="1" value="${item.weight || 1}" onchange="updatePoolWeight(${i}, this.value)" style="width:50px" title="\u6743\u91cd">
        <button type="button" class="pool-item-remove" onclick="removePoolItem(${i})">&times;</button>
      </div>
    `;
  }).join('');
}

function addPoolItem() {
  if (providers.length === 0) {
    showToast('\u8bf7\u5148\u521b\u5efa\u4f9b\u5e94\u5546', true);
    return;
  }
  providerPoolItems.push({ providerId: '', model: '', weight: 1 });
  renderPoolEditor();
}

function updatePoolProvider(index, providerId) {
  providerPoolItems[index].providerId = providerId;
  providerPoolItems[index].model = '';
  renderPoolEditor();
}

function updatePoolModel(index, model) {
  providerPoolItems[index].model = model;
}

function removePoolItem(index) {
  providerPoolItems.splice(index, 1);
  renderPoolEditor();
}

function updatePoolWeight(index, value) {
  providerPoolItems[index].weight = Math.max(1, parseInt(value) || 1);
}

async function handleProxySubmit(e) {
  e.preventDefault();
  const payload = {
    name: document.getElementById('proxy-name').value.trim(),
    port: parseInt(document.getElementById('proxy-port').value),
    requireAuth: document.getElementById('proxy-auth').value === 'true',
    authToken: document.getElementById('proxy-auth-token').value.trim() || null,
    providerId: document.getElementById('proxy-provider').value,
    defaultModel: document.getElementById('proxy-model').value,
    routingStrategy: document.getElementById('proxy-routing').value,
    providerWeight: parseInt(document.getElementById('proxy-weight').value) || 1,
    providerPool: providerPoolItems,
  };
  if (!payload.name || !payload.port || !payload.providerId) {
    showToast('\u8bf7\u586b\u5199\u5b8c\u6574\u4fe1\u606f', true);
    return;
  }
  try {
    if (editingProxyId) {
      await fetch(`/api/proxies/${editingProxyId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      showToast('\u4ee3\u7406\u5df2\u66f4\u65b0');
    } else {
      await fetch('/api/proxies', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      showToast('\u4ee3\u7406\u5df2\u521b\u5efa');
    }
    closeProxyModal();
    await loadProxies();
  } catch (err) {
    showToast('\u4fdd\u5b58\u5931\u8d25: ' + err.message, true);
  }
}

async function testConnectionFromModal() {
  const providerId = document.getElementById('proxy-provider').value;
  if (!providerId) {
    showToast('\u8bf7\u5148\u9009\u62e9\u4f9b\u5e94\u5546', true);
    return;
  }
  await testProviderConnection(providerId);
}

// ---------- Provider Page ----------
function renderProviders() {
  const grid = document.getElementById('provider-grid');
  if (!grid) return;
  const search = (document.getElementById('provider-search')?.value || '').toLowerCase();
  const filtered = providers.filter(p =>
    !search ||
    p.name.toLowerCase().includes(search) ||
    p.url.toLowerCase().includes(search)
  );

  if (filtered.length === 0 && providers.length === 0) {
    grid.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon"><svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"></path><polyline points="3.27 6.96 12 12.01 20.73 6.96"></polyline><line x1="12" y1="22.08" x2="12" y2="12"></line></svg></div>
        <p>\u8fd8\u6ca1\u6709\u914d\u7f6e\u4f9b\u5e94\u5546</p>
        <button class="btn btn-primary" onclick="openProviderModal()">\u521b\u5efa\u7b2c\u4e00\u4e2a\u4f9b\u5e94\u5546</button>
      </div>`;
    return;
  }
  if (filtered.length === 0) {
    grid.innerHTML = '<div class="empty-state"><p>\u6ca1\u6709\u5339\u914d\u7684\u4f9b\u5e94\u5546</p></div>';
    return;
  }

  grid.innerHTML = filtered.map(p => {
    const h = keyHealth[p.id];
    let statusDot = '';
    if (h) {
      const color = h.status === 'healthy' ? 'var(--success)' : h.status === 'partial' ? 'var(--warning)' : 'var(--error)';
      statusDot = `<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${color};margin-left:8px;"></span>`;
    }
    return `
      <div class="provider-card${p.enabled === false ? ' provider-disabled' : ''}">
        <div class="provider-card-header">
          <div class="provider-card-name">${escapeHtml(p.name)}${statusDot}</div>
          <span class="provider-card-protocol">${escapeHtml(p.protocol)}</span>
          ${p.adapter ? `<span class="provider-card-adapter">${escapeHtml(p.adapter)}</span>` : ''}
          ${(p.capabilities || []).map(c => `<span class="provider-card-adapter">${escapeHtml(c)}</span>`).join('')}
        </div>
        <div class="provider-card-url">${escapeHtml(p.url)}</div>
        <div class="provider-card-models">
          ${(p.models || []).slice(0, 6).map(m => `<span class="provider-card-model">${escapeHtml(m.name)}${m.contextLength ? ` (${formatTokens(m.contextLength)})` : ''}</span>`).join('')}
          ${(p.models || []).length > 6 ? `<span class="provider-card-model">+${p.models.length - 6}</span>` : ''}
        </div>
        <div class="provider-card-keys">${(p.apiKeys || []).length} \u4e2a API Key</div>
        <div class="provider-card-actions">
          <label class="toggle-switch" title="${p.enabled === false ? '\u5df2\u7981\u7528' : '\u5df2\u542f\u7528'}">
            <input type="checkbox" ${p.enabled !== false ? 'checked' : ''} onchange="toggleProviderEnabled('${p.id}', this.checked)">
            <span class="toggle-slider"></span>
          </label>
          <button class="btn btn-sm" onclick="editProvider('${p.id}')">\u7f16\u8f91</button>
          <button class="btn btn-sm" onclick="testProviderConnection('${p.id}')">\u6d4b\u8bd5</button>
          <button class="btn btn-sm" style="color:var(--error)" onclick="deleteProvider('${p.id}')">\u5220\u9664</button>
        </div>
      </div>
    `;
  }).join('');
}

function filterProviders() {
  renderProviders();
}

async function toggleProviderEnabled(id, enabled) {
  try {
    await fetch(`/api/providers/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled }),
    });
    await loadProviders();
    showToast(enabled ? '供应商已启用' : '供应商已禁用');
  } catch (err) {
    showToast('操作失败: ' + err.message, true);
  }
}

function openProviderModal() {
  editingProviderId = null;
  document.getElementById('provider-modal-title').textContent = '\u65b0\u5efa\u4f9b\u5e94\u5546';
  document.getElementById('provider-edit-id').value = '';
  document.getElementById('provider-name').value = '';
  document.getElementById('provider-protocol').value = 'openai';
  document.getElementById('provider-adapter').value = '';
  document.getElementById('provider-enabled').checked = true;
  setProviderCapabilities(['chat']);
  document.getElementById('provider-url').value = '';
  providerModelTags = [];
  renderModelTags();
  providerKeys = [{ key: '', alias: '', index: 0, enabled: true }];
  renderProviderKeys();
  document.getElementById('provider-azure-row').style.display = 'none';
  document.getElementById('provider-azure-deployment').value = '';
  document.getElementById('provider-azure-version').value = '';
  showModal('provider-modal');
}

function editProvider(id) {
  const p = providers.find(x => x.id === id);
  if (!p) return;
  editingProviderId = id;
  document.getElementById('provider-modal-title').textContent = '\u7f16\u8f91\u4f9b\u5e94\u5546';
  document.getElementById('provider-edit-id').value = p.id;
  document.getElementById('provider-name').value = p.name;
  document.getElementById('provider-protocol').value = p.protocol || 'openai';
  document.getElementById('provider-adapter').value = p.adapter || '';
  document.getElementById('provider-enabled').checked = p.enabled !== false;
  setProviderCapabilities(p.capabilities || ['chat']);
  document.getElementById('provider-url').value = p.url;
  providerModelTags = [...(p.models || [])];
  renderModelTags();
  providerKeys = (p.apiKeys || []).map((k, i) => ({ ...k, index: typeof k.index === 'number' ? k.index : i }));
  if (providerKeys.length === 0) providerKeys = [{ key: '', alias: '', index: 0 }];
  renderProviderKeys();
  const isAzure = p.protocol === 'openai' && p.azureDeployment;
  document.getElementById('provider-azure-row').style.display = isAzure ? 'grid' : 'none';
  document.getElementById('provider-azure-deployment').value = p.azureDeployment || '';
  document.getElementById('provider-azure-version').value = p.azureApiVersion || '';
  showModal('provider-modal');
}

function closeProviderModal() {
  hideModal('provider-modal');
}

function renderModelTags() {
  const list = document.getElementById('provider-models-list');
  list.innerHTML = providerModelTags.map((tag, i) => `
    <span class="tag">${escapeHtml(tag.name)}<button type="button" class="tag-remove" onclick="removeModelTag(${i})">&times;</button></span>
  `).join('');
  renderModelContextTable();
}

function handleModelTagInput(e) {
  if (e.key === 'Enter') {
    e.preventDefault();
    const val = e.target.value.trim();
    if (val && !providerModelTags.some(m => m.name === val)) {
      providerModelTags.push({ name: val, contextLength: 0, thinkingEffort: '' });
      renderModelTags();
      e.target.value = '';
    }
  }
}

function renderModelContextTable() {
  const wrapper = document.getElementById('model-context-table');
  const tbody = document.getElementById('model-context-tbody');
  if (!wrapper || !tbody) return;
  if (providerModelTags.length === 0) { wrapper.style.display = 'none'; return; }
  wrapper.style.display = '';
  const isDeepseek = document.getElementById('provider-adapter')?.value === 'deepseek';
  const thEl = document.getElementById('model-thinking-th');
  if (thEl) thEl.style.display = isDeepseek ? '' : 'none';
  tbody.innerHTML = providerModelTags.map((m, i) => {
    const unit = m._unit || 'k';
    const divisor = unit === 'm' ? 1000000 : 1000;
    const effort = m.thinkingEffort || '';
    const thinkingCol = isDeepseek ? `<td><select onchange="updateModelThinkingEffort(${i}, this.value)" style="font-size:12px;padding:2px 4px;border:1px solid var(--border-default);border-radius:3px;background:var(--bg-surface);color:var(--text-primary)"><option value=""${effort === '' ? ' selected' : ''}>关闭</option><option value="high"${effort === 'high' ? ' selected' : ''}>高</option><option value="max"${effort === 'max' ? ' selected' : ''}>极限</option></select></td>` : '';
    return `<tr>
      <td>${escapeHtml(m.name)}</td>
      <td style="display:flex;align-items:center;gap:4px"><input type="number" min="0" step="any" value="${m.contextLength ? m.contextLength / divisor : ''}" placeholder="跟随系统设置"
          onchange="updateModelContext(${i}, this.value)" style="width:90px"><select onchange="updateModelContextUnit(${i}, this.value)" style="font-size:12px;padding:2px;border:1px solid var(--border-default);border-radius:3px;background:var(--bg-surface);color:var(--text-primary);width:40px"><option value="k"${unit === 'k' ? ' selected' : ''}>k</option><option value="m"${unit === 'm' ? ' selected' : ''}>m</option></select></td>
      ${thinkingCol}
    </tr>`;
  }).join('');
}

function updateModelContextUnit(index, unit) {
  const m = providerModelTags[index];
  if (!m) return;
  const oldUnit = m._unit || 'k';
  if (unit === oldUnit) return;
  const oldDivisor = oldUnit === 'm' ? 1000000 : 1000;
  const newMultiplier = unit === 'm' ? 1000000 : 1000;
  const row = document.getElementById('model-context-tbody')?.rows[index];
  const input = row?.querySelector('input');
  const displayVal = input ? parseFloat(input.value) || 0 : (m.contextLength / oldDivisor);
  m.contextLength = Math.round(displayVal * newMultiplier);
  m._unit = unit;
  renderModelContextTable();
}

function updateModelContext(index, value) {
  if (providerModelTags[index]) {
    const unit = providerModelTags[index]._unit || 'k';
    const multiplier = unit === 'm' ? 1000000 : 1000;
    providerModelTags[index].contextLength = Math.max(0, Math.round((parseFloat(value) || 0) * multiplier));
  }
}

function updateModelThinkingEffort(index, value) {
  if (providerModelTags[index]) {
    providerModelTags[index].thinkingEffort = value;
  }
}

function removeModelTag(index) {
  providerModelTags.splice(index, 1);
  renderModelTags();
}

function renderProviderKeys() {
  const container = document.getElementById('provider-keys-list');
  container.innerHTML = providerKeys.map((k, i) => `
    <div class="key-row" data-index="${k.index ?? i}" data-masked="${k.masked ? 'true' : 'false'}">
      <input type="text" placeholder="\u522b\u540d" value="${escapeHtml(k.alias || '')}" oninput="providerKeys[${i}].alias = this.value">
      ${k.masked
        ? `<span class="api-key-masked" data-idx="${i}">sk-••••••••</span>`
        : `<input type="password" placeholder="sk-..." value="${escapeHtml(k.key || '')}" oninput="providerKeys[${i}].key = this.value">`
      }
      <label class="toggle-switch" title="${k.enabled !== false ? '\u5df2\u542f\u7528' : '\u5df2\u7981\u7528'}">
        <input type="checkbox" ${k.enabled !== false ? 'checked' : ''} onchange="providerKeys[${i}].enabled = this.checked">
        <span class="toggle-slider"></span>
      </label>
      <button type="button" class="btn btn-sm" onclick="removeProviderKey(${i})">\u79fb\u9664</button>
    </div>
  `).join('');
  attachMaskedKeyClicks();
}

function addProviderKey() {
  providerKeys.push({ key: '', alias: '', index: providerKeys.length, enabled: true });
  renderProviderKeys();
}

function removeProviderKey(index) {
  providerKeys.splice(index, 1);
  if (providerKeys.length === 0) providerKeys.push({ key: '', alias: '', index: 0 });
  renderProviderKeys();
}

function attachMaskedKeyClicks() {
  document.querySelectorAll('.api-key-masked').forEach(span => {
    if (span._attached) return;
    span._attached = true;
    span.title = '点击修改';
    span.addEventListener('click', () => {
      const i = parseInt(span.dataset.idx, 10);
      const row = span.closest('.key-row');
      const group = span.parentElement;

      // Replace span with input
      const input = document.createElement('input');
      input.type = 'password';
      input.className = 'key-input';
      input.placeholder = '输入新的 API Key...';
      group.replaceChild(input, span);
      input.focus();

      input.addEventListener('blur', () => {
        const val = input.value.trim();
        if (!val) {
          // Restore masked span
          const restored = document.createElement('span');
          restored.className = 'api-key-masked';
          restored.dataset.idx = i;
          restored.textContent = 'sk-••••••••';
          group.replaceChild(restored, input);
          attachMaskedKeyClicks();
          return;
        }
        // Mark as edited — replace with password input
        const newInput = document.createElement('input');
        newInput.type = 'password';
        newInput.className = 'key-input';
        newInput.value = val;
        group.replaceChild(newInput, input);
        newInput.addEventListener('input', () => { providerKeys[i].key = newInput.value; });
        providerKeys[i].key = val;
        providerKeys[i].masked = false;
        if (row) row.dataset.masked = 'false';
      });
    });
  });
}

function collectProviderKeys() {
  return providerKeys.map(k => {
    const alias = (k.alias || '').trim();
    const enabled = k.enabled !== false;
    if (k.masked) {
      // Existing key: if key was edited, send key; otherwise preserve
      if (k.key && !k.masked) return { key: k.key.trim(), alias, enabled };
      return { alias, masked: true, index: k.index, enabled };
    }
    const key = (k.key || '').trim();
    if (!key) return null;
    return { key, alias, enabled };
  }).filter(Boolean);
}

function setProviderCapabilities(capabilities) {
  const caps = Array.isArray(capabilities) ? capabilities : [];
  document.getElementById('provider-cap-chat').checked = caps.length === 0 || caps.includes('chat');
  document.getElementById('provider-cap-vision').checked = caps.includes('vision');
  document.getElementById('provider-cap-image-gen').checked = caps.includes('image_gen');
}

function collectProviderCapabilities() {
  const caps = [];
  if (document.getElementById('provider-cap-chat').checked) caps.push('chat');
  if (document.getElementById('provider-cap-vision').checked) caps.push('vision');
  if (document.getElementById('provider-cap-image-gen').checked) caps.push('image_gen');
  return caps;
}

async function handleProviderSubmit(e) {
  e.preventDefault();
  const payload = {
    name: document.getElementById('provider-name').value.trim(),
    protocol: document.getElementById('provider-protocol').value,
    adapter: document.getElementById('provider-adapter').value,
    enabled: document.getElementById('provider-enabled').checked,
    capabilities: collectProviderCapabilities(),
    url: document.getElementById('provider-url').value.trim(),
    models: providerModelTags,
    apiKeys: collectProviderKeys(),
  };
  if (payload.protocol === 'openai') {
    const azDep = document.getElementById('provider-azure-deployment').value.trim();
    if (azDep) {
      payload.azureDeployment = azDep;
      payload.azureApiVersion = document.getElementById('provider-azure-version').value.trim() || '2024-02-01';
    }
  }
  if (!payload.name || !payload.url) {
    showToast('\u8bf7\u586b\u5199\u5b8c\u6574\u4fe1\u606f', true);
    return;
  }
  try {
    if (editingProviderId) {
      await fetch(`/api/providers/${editingProviderId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      showToast('\u4f9b\u5e94\u5546\u5df2\u66f4\u65b0');
    } else {
      await fetch('/api/providers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      showToast('\u4f9b\u5e94\u5546\u5df2\u521b\u5efa');
    }
    closeProviderModal();
    await loadProviders();
  } catch (err) {
    showToast('\u4fdd\u5b58\u5931\u8d25: ' + err.message, true);
  }
}

async function deleteProvider(id) {
  const p = providers.find(x => x.id === id);
  if (!p) return;
  const ok = await showConfirm(`\u786e\u5b9a\u5220\u9664\u4f9b\u5e94\u5546 <strong>${escapeHtml(p.name)}</strong>\uff1f`);
  if (!ok) return;
  try {
    const res = await fetch(`/api/providers/${id}`, { method: 'DELETE' });
    if (!res.ok) {
      const data = await res.json();
      showToast(data.error || '\u5220\u9664\u5931\u8d25', true);
      return;
    }
    await loadProviders();
    showToast('\u4f9b\u5e94\u5546\u5df2\u5220\u9664');
  } catch (err) {
    showToast('\u5220\u9664\u5931\u8d25: ' + err.message, true);
  }
}

async function fetchModelsForProvider(el) {
  const url = document.getElementById('provider-url').value.trim();
  const protocol = document.getElementById('provider-protocol').value;
  if (!url) {
    showToast('\u8bf7\u5148\u586b\u5199 API \u5730\u5740', true);
    return;
  }
  if (protocol === 'anthropic') {
    showToast('Anthropic \u534f\u8bae\u6682\u4e0d\u652f\u6301\u81ea\u52a8\u83b7\u53d6\u6a21\u578b\u5217\u8868\uff0c\u8bf7\u624b\u52a8\u6dfb\u52a0', true);
    return;
  }
  const btn = el || document.activeElement;
  if (btn) { btn.disabled = true; btn.textContent = '\u83b7\u53d6\u4e2d...'; }
  try {
    const payload = { url, protocol };
    const azureDep = document.getElementById('provider-azure-deployment')?.value?.trim();
    if (azureDep) {
      payload.azureDeployment = azureDep;
      payload.azureApiVersion = document.getElementById('provider-azure-version')?.value?.trim() || '2024-02-01';
    }
    let res;
    if (editingProviderId) {
      payload.apiKeys = providerKeys.map(k => ({ key: (k.key || '').trim(), alias: k.alias, index: k.index, masked: !!k.masked }));
      res = await fetch(`/api/providers/${editingProviderId}/available-models`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
    } else {
      const key = providerKeys.find(k => k.key && k.key.trim())?.key.trim() || '';
      payload.apiKey = key;
      res = await fetch('/api/providers/available-models', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
    }
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    const models = data.models || [];
    const existing = new Set(providerModelTags.map(m => m.name));
    const newModels = models.filter(m => !existing.has(m.name));
    providerModelTags.push(...newModels);
    renderModelTags();
    showToast(`\u5df2\u5bfc\u5165 ${newModels.length} \u4e2a\u6a21\u578b`);
  } catch (err) {
    showToast('\u83b7\u53d6\u5931\u8d25: ' + err.message, true);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '\u81ea\u52a8\u83b7\u53d6\u6a21\u578b\u5217\u8868'; }
  }
}

async function testProviderConnection(id, opts) {
  const p = providers.find(x => x.id === id);
  if (!p) return;
  try {
    const res = await fetch(`/api/providers/${id}/test`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        apiKeys: opts?.apiKeys || p.apiKeys,
        models: p.models,
        protocol: opts?.protocol || p.protocol,
      }),
    });
    const data = await res.json();
    showTestResult(data.ok, `${data.passed || 0}/${data.results?.length || 0} 个 Key 正常`, data.results || []);
  } catch (err) {
    showTestResult(false, '测试失败: ' + err.message, []);
  }
}

async function testProviderFromModal() {
  const url = document.getElementById('provider-url').value.trim();
  const protocol = document.getElementById('provider-protocol').value;
  if (!url) {
    showToast('\u8bf7\u5148\u586b\u5199 API \u5730\u5740', true);
    return;
  }
  const isNew = !editingProviderId;
  if (isNew) {
    // \u65b0\u5efa\u4f9b\u5e94\u5546\uff1a\u53ea\u6d4b\u65b0\u8f93\u5165\u7684 key\uff0c\u7528 /api/test-connection
    const apiKeys = collectProviderKeys()
      .filter(k => !k.masked && k.key)
      .map(k => ({ key: k.key.trim(), alias: k.alias || '' }));
    await testProviderConnectionDirect({
      url,
      protocol,
      apiKeys,
      models: providerModelTags,
      azureDeployment: document.getElementById('provider-azure-deployment').value.trim(),
      azureApiVersion: document.getElementById('provider-azure-version').value.trim(),
    });
  } else {
    // \u7f16\u8f91\u5df2\u6709\u4f9b\u5e94\u5546\uff1a\u6536\u96c6\u8868\u5355\u4e2d\u7684\u6240\u6709 key\uff08\u542b\u65b0\u589e\u672a\u4fdd\u5b58\u7684\uff09\uff0c\u53d1\u7ed9\u540e\u7aef\u6d4b\u8bd5
    const apiKeys = collectProviderKeys();
    const protocol = document.getElementById('provider-protocol').value;
    await testProviderConnection(editingProviderId, { apiKeys, protocol });
  }
}

async function testProviderConnectionDirect(provider) {
  const keys = (provider.apiKeys || []).filter(k => k.key);
  if (keys.length === 0) {
    showTestResult(false, '\u6ca1\u6709\u53ef\u7528\u7684 API Key', []);
    return;
  }
  try {
    const res = await fetch('/api/test-connection', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: provider.url,
        protocol: provider.protocol,
        apiKeys: keys,
        models: provider.models,
        azureDeployment: provider.azureDeployment,
        azureApiVersion: provider.azureApiVersion,
      }),
    });
    const data = await res.json();
    const passed = data.passed || 0;
    const total = data.results?.length || 0;
    showTestResult(data.ok, `${passed}/${total} \u4e2a Key \u6b63\u5e38`, data.results || []);
  } catch (err) {
    showTestResult(false, '\u6d4b\u8bd5\u5931\u8d25: ' + err.message, []);
  }
}

function showTestResult(ok, summary, results) {
  document.getElementById('test-summary').innerHTML = ok
    ? `<span style="color:var(--success)">\u2713 ${escapeHtml(summary)}</span>`
    : `<span style="color:var(--error)">\u2717 ${escapeHtml(summary)}</span>`;
  document.getElementById('test-details').innerHTML = results.map(r => `
    <div style="display:flex;align-items:center;gap:8px;padding:8px 0;border-bottom:1px solid var(--border-subtle);font-size:13px">
      <span style="color:${r.ok ? 'var(--success)' : 'var(--error)'};font-weight:600">${r.ok ? '\u2713' : '\u2717'}</span>
      <span style="flex:1">${escapeHtml(r.alias || '\u672a\u547d\u540d')}</span>
      ${r.latencyMs ? `<span style="color:var(--text-muted);font-family:var(--font-mono);font-size:12px">${r.latencyMs}ms</span>` : ''}
      ${r.message ? `<span style="color:var(--error);font-size:12px">${escapeHtml(r.message)}</span>` : ''}
    </div>
  `).join('');
  showModal('test-modal');
}

function closeTestModal() {
  hideModal('test-modal');
}

// ==================== 多模态服务管理 ====================

let multimodalServices = [];
let editingMmId = null;
let mmModelTags = [];
let _lastAutoUrl = ''; // 记录上次自动填充的 URL，避免覆盖用户手动输入

function renderMmModelTags() {
  const list = document.getElementById('mm-models-list');
  if (!list) return;
  list.innerHTML = mmModelTags.map((tag, i) => `
    <span class="tag">${escapeHtml(tag.name)}<button type="button" class="tag-remove" onclick="removeMmModelTag(${i})">&times;</button></span>
  `).join('');
}

function handleMmModelTagInput(e) {
  if (e.key === 'Enter') {
    e.preventDefault();
    const val = e.target.value.trim();
    if (val && !mmModelTags.some(m => m.name === val)) {
      mmModelTags.push({ name: val });
      renderMmModelTags();
      e.target.value = '';
    }
  }
}

function removeMmModelTag(index) {
  mmModelTags.splice(index, 1);
  renderMmModelTags();
}

async function loadMultimodal() {
  try {
    const res = await fetch('/api/multimodal');
    multimodalServices = await res.json();
    renderMultimodal();
    const badge = document.getElementById('nav-multimodal-count');
    if (badge) badge.textContent = multimodalServices.length || '';
  } catch {}
}

function renderMultimodal() {
  const grid = document.getElementById('multimodal-grid');
  if (!grid) return;
  const search = (document.getElementById('mm-search')?.value || '').toLowerCase();
  const filtered = multimodalServices.filter(s =>
    !search || s.name.toLowerCase().includes(search) || (s.brand || '').toLowerCase().includes(search)
  );
  const typeLabel = { image: '图片生成', video: '视频生成', tts: '语音合成', music: '音乐生成' };
  const typeIcon = { image: '🖼️', video: '🎬', tts: '🔊', music: '🎵' };
  const brandLabel = { openai: 'OpenAI', mimo: 'MiMo', minimax: 'MiniMax', custom: '自定义' };

  if (filtered.length === 0) {
    grid.innerHTML = `<div class="empty-state"><p>还没有配置多模态服务</p><button class="btn btn-primary" onclick="openMultimodalModal()">添加第一个服务</button></div>`;
    return;
  }
  grid.innerHTML = filtered.map(s => `
    <div class="provider-card${s.enabled === false ? ' provider-disabled' : ''}">
      <div class="provider-card-header">
        <div class="provider-card-name">${typeIcon[s.serviceType] || ''} ${escapeHtml(s.name)}</div>
        <span class="provider-card-category">${escapeHtml(typeLabel[s.serviceType] || s.serviceType)}</span>
        <span class="provider-card-protocol">${escapeHtml(brandLabel[s.brand] || s.brand)}</span>
      </div>
      <div class="provider-card-url">${escapeHtml(s.url || '(默认)')}</div>
      ${(s.models && s.models.length > 0) ? `<div class="provider-card-models">${s.models.map(m => `<span class="provider-card-model">${escapeHtml(typeof m === 'string' ? m : m.name)}</span>`).join('')}</div>` : (s.model ? `<div class="provider-card-models"><span class="provider-card-model">${escapeHtml(s.model)}</span></div>` : '')}
      <div class="provider-card-actions">
        <button class="btn btn-sm" onclick="editMultimodal('${s.id}')">编辑</button>
        <button class="btn btn-sm" style="color:var(--error)" onclick="deleteMultimodal('${s.id}')">删除</button>
      </div>
    </div>
  `).join('');
}

function openMultimodalModal() {
  editingMmId = null;
  document.getElementById('mm-modal-title').textContent = '添加多模态服务';
  document.getElementById('mm-edit-id').value = '';
  document.getElementById('mm-name').value = '';
  document.getElementById('mm-type').value = 'image';
  document.getElementById('mm-brand').value = 'openai';
  document.getElementById('mm-url').value = '';
  document.getElementById('mm-apikey').value = '';
  document.getElementById('mm-enabled').checked = true;
  mmModelTags = [];
  _lastAutoUrl = '';
  renderMmModelTags();
  onBrandChange();
  showModal('mm-modal');
}

function editMultimodal(id) {
  const s = multimodalServices.find(x => x.id === id);
  if (!s) return;
  editingMmId = id;
  document.getElementById('mm-modal-title').textContent = '编辑多模态服务';
  document.getElementById('mm-edit-id').value = s.id;
  document.getElementById('mm-name').value = s.name;
  document.getElementById('mm-type').value = s.serviceType;
  document.getElementById('mm-brand').value = s.brand;
  document.getElementById('mm-url').value = s.url || '';
  document.getElementById('mm-apikey').value = s.apiKey || '';
  document.getElementById('mm-enabled').checked = s.enabled !== false;
  onBrandChange();
  // 兼容旧数据：model 字符串 → models 数组（覆盖 onBrandChange 填充的预设）
  mmModelTags = (s.models && s.models.length > 0)
    ? s.models.map(m => typeof m === 'string' ? { name: m } : m)
    : (s.model ? [{ name: s.model }] : []);
  renderMmModelTags();
  showModal('mm-modal');
}

function closeMultimodalModal() {
  hideModal('mm-modal');
  editingMmId = null;
}

async function handleMultimodalSubmit(e) {
  e.preventDefault();
  const payload = {
    name: document.getElementById('mm-name').value.trim(),
    serviceType: document.getElementById('mm-type').value,
    brand: document.getElementById('mm-brand').value,
    models: mmModelTags.map(t => ({ name: t.name })),
    url: document.getElementById('mm-url').value.trim(),
    apiKey: document.getElementById('mm-apikey').value,
    enabled: document.getElementById('mm-enabled').checked,
  };
  if (!payload.name) { showToast('请填写服务名称', true); return; }
  try {
    if (editingMmId) {
      await fetch(`/api/multimodal/${editingMmId}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      showToast('服务已更新');
    } else {
      await fetch('/api/multimodal', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      showToast('服务已创建');
    }
    closeMultimodalModal();
    await loadMultimodal();
  } catch (err) {
    showToast('保存失败: ' + err.message, true);
  }
}

async function deleteMultimodal(id) {
  const s = multimodalServices.find(x => x.id === id);
  if (!s) return;
  const ok = await showConfirm(`确定删除多模态服务 <strong>${escapeHtml(s.name)}</strong>？`);
  if (!ok) return;
  try {
    await fetch(`/api/multimodal/${id}`, { method: 'DELETE' });
    await loadMultimodal();
    showToast('服务已删除');
  } catch (err) {
    showToast('删除失败: ' + err.message, true);
  }
}

function onBrandChange() {
  const serviceType = document.getElementById('mm-type').value;
  const brandSelect = document.getElementById('mm-brand');
  const urlField = document.getElementById('mm-url');
  // 每个服务类型可用的品牌
  const brandsByType = {
    image: [
      { value: 'openai', label: 'OpenAI 兼容' },
      { value: 'minimax', label: 'MiniMax' },
      { value: 'custom', label: '自定义' },
    ],
    video: [
      { value: 'minimax', label: 'MiniMax' },
      { value: 'custom', label: '自定义' },
    ],
    tts: [
      { value: 'openai', label: 'OpenAI 兼容' },
      { value: 'mimo', label: 'MiMo（小米）' },
      { value: 'minimax', label: 'MiniMax' },
      { value: 'custom', label: '自定义' },
    ],
    music: [
      { value: 'minimax', label: 'MiniMax' },
      { value: 'custom', label: '自定义' },
    ],
  };
  // 更新品牌下拉（保留当前选中值）
  const prevBrand = brandSelect.value;
  const brands = brandsByType[serviceType] || brandsByType.custom;
  brandSelect.innerHTML = brands.map(b => `<option value="${b.value}">${b.label}</option>`).join('');
  if (brands.some(b => b.value === prevBrand)) {
    brandSelect.value = prevBrand;
  }
  const brand = brandSelect.value;
  const defaults = {
    openai: { url: 'https://api.openai.com' },
    mimo: { url: 'https://api.xiaomimimo.com' },
    minimax: { url: 'https://api.minimaxi.com' },
    custom: { url: '' },
  };
  const d = defaults[brand] || defaults.custom;
  if (!urlField.value || urlField.value === _lastAutoUrl) {
    urlField.value = d.url;
    _lastAutoUrl = d.url;
  }
}

// ---------- Stats Page ----------
function changeStatsRange(range) {
  statsRange = range;
  loadStats();
}

function changeStatsProxy(proxyId) {
  statsProxyId = proxyId;
  loadStats();
}

function renderStats(data) {
  const summary = data.summary || {};
  document.getElementById('stats-total').textContent = formatTokens(summary.total || 0);
  document.getElementById('stats-prompt').textContent = formatTokens(summary.prompt || 0);
  document.getElementById('stats-completion').textContent = formatTokens(summary.completion || 0);
  document.getElementById('stats-requests').textContent = (summary.requests || 0).toLocaleString();
  document.getElementById('stats-estimated-badge').style.display = summary.hasEstimated ? 'inline' : 'none';

  const tbody = document.getElementById('stats-table-body');
  const byModel = data.byModel || [];
  if (byModel.length === 0) {
    tbody.innerHTML = '<tr><td colspan="6" class="empty-cell">\u6682\u65e0\u6570\u636e</td></tr>';
    return;
  }
  tbody.innerHTML = byModel.map(item => {
    const prefix = item.hasEstimated ? '~' : '';
    return `
      <tr>
        <td>${escapeHtml(item.provider)}</td>
        <td><code>${escapeHtml(item.model)}</code></td>
        <td class="num">${item.requests.toLocaleString()}</td>
        <td class="num">${prefix}${formatTokens(item.prompt)}</td>
        <td class="num">${prefix}${formatTokens(item.completion)}</td>
        <td class="num">${prefix}${formatTokens(item.total)}</td>
      </tr>
    `;
  }).join('');
}

function populateProxyFilterOptions() {
  const selects = ['stats-proxy-filter', 'rq-proxy-filter'];
  selects.forEach(id => {
    const select = document.getElementById(id);
    if (!select) return;
    const current = select.value;
    select.innerHTML = '<option value="">\u5168\u90e8\u4ee3\u7406</option>' +
      proxies.map(p => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.name)}</option>`).join('');
    select.value = current || '';
  });
}

async function exportStatsCSV() {
  try {
    const params = new URLSearchParams({ range: statsRange });
    if (statsProxyId) params.set('proxyId', statsProxyId);
    const start = document.getElementById('stats-start')?.value;
    const end = document.getElementById('stats-end')?.value;
    if (start) params.set('startDate', start);
    if (end) params.set('endDate', end);
    const res = await fetch('/api/stats?' + params);
    const data = await res.json();
    if (!data.byModel || data.byModel.length === 0) {
      showToast('\u5f53\u524d\u7b5b\u9009\u6761\u4ef6\u4e0b\u65e0\u6570\u636e\u53ef\u5bfc\u51fa', true);
      return;
    }
    const rows = [['\u4f9b\u5e94\u5546', '\u6a21\u578b', '\u8bf7\u6c42\u6570', '\u8f93\u5165Token', '\u8f93\u51faToken', '\u5408\u8ba1Token', '\u542b\u4f30\u7b97']];
    for (const item of data.byModel) {
      rows.push([item.provider, item.model, item.requests, item.prompt, item.completion, item.total, item.hasEstimated ? '\u662f' : '\u5426']);
    }
    const s = data.summary;
    rows.push(['\u5408\u8ba1', '', s.requests, s.prompt, s.completion, s.total, s.hasEstimated ? '\u662f' : '\u5426']);
    const csv = '\ufeff' + rows.map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `stats-${statsRange}-${new Date().toISOString().slice(0,10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  } catch (err) {
    showToast('\u5bfc\u51fa\u5931\u8d25: ' + err.message, true);
  }
}

// ---------- Request Logs Page ----------
function connectRequestLogWS() {
  const wsProto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${wsProto}//${location.host}`;
  // Fallback: if no WS endpoint, use polling via a custom endpoint or skip
  // Since the backend may not have WS, we'll use a polling approach with the existing API
  // Actually, the original code used WebSocket. Let's try to connect.
  try {
    ws = new WebSocket(wsUrl);
    ws.onopen = () => {
      const btn = document.getElementById('rq-ws-btn');
      if (btn) { btn.textContent = '\u5b9e\u65f6'; btn.style.color = 'var(--success)'; }
    };
    ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        // MCP 状态更新
        if (msg.type === 'mcp_status') {
          updateMcpServerStatus(msg.server, msg);
          return;
        }
        // 多 Agent 任务状态更新
        if (msg.type === 'task' && msg.task) {
          const t = msg.task;
          if (t.status === 'completed') updateDelegateTask(t.id, 'completed', t.summary);
          else if (t.status === 'failed') updateDelegateTask(t.id, 'failed', t.error);
          else if (t.status === 'running') updateDelegateTask(t.id, 'running');
          else if (t.status === 'stopped') updateDelegateTask(t.id, 'stopped', '已终止');
          if (typeof onTaskEvent === 'function') onTaskEvent(t);
          return;
        }
        if (msg.type === 'task' && msg.event === 'progress' && msg.taskId) {
          updateDelegateProgress(msg.taskId, msg.progress);
          if (typeof onTaskProgressEvent === 'function') onTaskProgressEvent(msg.taskId, msg.progress);
          return;
        }
        // 子任务批次创建（替代 SSE delegate created 事件）
        if (msg.type === 'batch' && msg.event === 'created' && msg.tasks) {
          handleDelegateEvent({ type: 'created', tasks: msg.tasks });
          return;
        }
        const entry = msg.id ? msg : (msg.data || msg);
        if (entry && entry.id) {
          requestLogs.unshift(entry);
          if (requestLogs.length > 500) requestLogs.pop();
          if (currentPage === 'request-logs') {
            // Prepend single row instead of full re-render to preserve open detail rows
            const tbody = document.getElementById('rq-tbody');
            if (tbody) {
              const proxyFilter = document.getElementById('rq-proxy-filter')?.value || '';
              const statusFilter = document.getElementById('rq-status-filter')?.value || '';
              const modelFilter = (document.getElementById('rq-model-filter')?.value || '').toLowerCase();
              let passes = true;
              if (proxyFilter && entry.proxyId !== proxyFilter) passes = false;
              if (statusFilter === 'success' && entry.status !== 'success') passes = false;
              if (statusFilter === 'failure' && entry.status === 'success') passes = false;
              if (statusFilter === '429' && entry.status !== '429') passes = false;
              if (modelFilter && !(entry.model || '').toLowerCase().includes(modelFilter)) passes = false;
              if (passes) {
                const tmp = document.createElement('tbody');
                tmp.innerHTML = renderRequestLogRow(entry);
                const newRow = tmp.firstElementChild;
                if (newRow) tbody.insertBefore(newRow, tbody.firstChild);
              }
            }
          }
          if (currentPage === 'dashboard') renderDashRecentRequests();
        }
      } catch {}
    };
    ws.onclose = () => {
      const btn = document.getElementById('rq-ws-btn');
      if (btn) { btn.textContent = '\u5df2\u65ad\u5f00'; btn.style.color = 'var(--error)'; }
      setTimeout(connectRequestLogWS, 3000);
    };
    ws.onerror = () => {
      const btn = document.getElementById('rq-ws-btn');
      if (btn) { btn.textContent = '\u8fde\u63a5\u5931\u8d25'; btn.style.color = 'var(--error)'; }
    };
  } catch {
    // WS not available, show as disabled
    const btn = document.getElementById('rq-ws-btn');
    if (btn) { btn.textContent = '\u672a\u8fde\u63a5'; btn.style.color = 'var(--text-faint)'; }
  }
}

function renderRequestLogs() {
  const tbody = document.getElementById('rq-tbody');
  if (!tbody) return;

  const proxyFilter = document.getElementById('rq-proxy-filter')?.value || '';
  const statusFilter = document.getElementById('rq-status-filter')?.value || '';
  const modelFilter = (document.getElementById('rq-model-filter')?.value || '').toLowerCase();

  const filtered = requestLogs.filter(r => {
    if (proxyFilter && r.proxyId !== proxyFilter) return false;
    if (statusFilter) {
      if (statusFilter === 'success' && r.status !== 'success') return false;
      if (statusFilter === 'failure' && r.status === 'success') return false;
      if (statusFilter === '429' && r.status !== '429') return false;
    }
    if (modelFilter && !(r.model || '').toLowerCase().includes(modelFilter)) return false;
    return true;
  });

  // Update summary
  const total = filtered.length;
  const success = filtered.filter(r => r.status === 'success').length;
  const avgLatency = total > 0 ? Math.round(filtered.reduce((a, r) => a + (r.latencyMs || 0), 0) / total) : 0;
  const summary = document.getElementById('rq-summary');
  if (summary) {
    summary.innerHTML = `
      <div class="request-log-summary-item">\u603b\u8ba1: <strong>${total}</strong></div>
      <div class="request-log-summary-item">\u6210\u529f: <strong style="color:var(--success)">${success}</strong></div>
      <div class="request-log-summary-item">\u5931\u8d25: <strong style="color:var(--error)">${total - success}</strong></div>
      <div class="request-log-summary-item">\u5e73\u5747\u5ef6\u8fdf: <strong>${avgLatency}ms</strong></div>
    `;
  }

  if (filtered.length === 0) {
    tbody.innerHTML = '<tr><td colspan="9" class="empty-cell">\u6682\u65e0\u8bf7\u6c42\u8bb0\u5f55</td></tr>';
    return;
  }

  tbody.innerHTML = filtered.slice(0, 200).map(r => renderRequestLogRow(r)).join('');
}

function toggleRequestLogDetail(row, entry) {
  const next = row.nextElementSibling;
  if (next && next.classList.contains('request-log-detail-row')) {
    next.remove();
    return;
  }
  const detailRow = document.createElement('tr');
  detailRow.className = 'request-log-detail-row';
  const time = entry.timestamp ? new Date(entry.timestamp).toLocaleString('zh-CN', { hour12: false }) : '-';
  detailRow.innerHTML = `<td colspan="9"><div class="request-log-detail">
    <div class="request-log-detail-grid">
      <span class="detail-label">Request ID</span><span><code>${escapeHtml(entry.id || '-')}</code></span>
      <span class="detail-label">时间</span><span>${time}</span>
      <span class="detail-label">客户端 IP</span><span>${escapeHtml(entry.clientIP || '-')}</span>
      <span class="detail-label">入站协议</span><span>${escapeHtml(entry.inboundProtocol || '-')}</span>
      <span class="detail-label">目标协议</span><span>${escapeHtml(entry.targetProtocol || '-')}</span>
      <span class="detail-label">代理</span><span>${escapeHtml(entry.proxyName || '-')} <code style="font-size:11px;color:var(--text-dim)">${escapeHtml(entry.proxyId || '')}</code></span>
      <span class="detail-label">供应商</span><span>${escapeHtml(entry.providerName || '-')}</span>
      <span class="detail-label">模型</span><span><code>${escapeHtml(entry.model || '-')}</code></span>
      <span class="detail-label">Key</span><span>${escapeHtml(entry.keyAlias || '-')}</span>
      <span class="detail-label">流式</span><span>${entry.stream ? '是' : '否'}</span>
      <span class="detail-label">上游状态码</span><span>${entry.upstreamStatusCode || '-'}</span>
      <span class="detail-label">延迟</span><span>${entry.latencyMs != null ? entry.latencyMs + 'ms' : '-'}</span>
      <span class="detail-label">Token</span><span>${entry.promptTokens || 0} 输入 + ${entry.completionTokens || 0} 输出 = ${entry.totalTokens || 0} ${entry.isEstimated ? '(估算)' : ''}</span>
      ${entry.errorMessage ? `<span class="detail-label">错误信息</span><span class="request-log-detail-error">${escapeHtml(entry.errorMessage)}</span>` : ''}
    </div>
    <div style="margin-top:12px">
      <button class="btn btn-sm" onclick="replayRequest(this,'${escapeHtml(entry.id)}')">重放请求</button>
    </div>
  </div></td>`;
  row.after(detailRow);
}

async function replayRequest(btn, id) {
  btn.disabled = true;
  const origText = btn.textContent;
  btn.textContent = '重放中...';
  try {
    const res = await fetch(`/api/request-logs/${encodeURIComponent(id)}/replay`, { method: 'POST' });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      btn.textContent = data.error || '重放失败';
      btn.style.color = 'var(--error)';
    } else {
      btn.textContent = '重放成功';
      btn.style.color = 'var(--success)';
    }
  } catch (e) {
    btn.textContent = '重放错误';
    btn.style.color = 'var(--error)';
  } finally {
    setTimeout(() => { btn.disabled = false; btn.textContent = origText; btn.style.color = ''; }, 2000);
  }
}

function renderRequestLogRow(r, compact) {
  const time = r.timestamp ? new Date(r.timestamp).toLocaleTimeString('zh-CN', { hour12: false }) : '-';
  const status = r.status === 'success'
    ? `<span style="color:var(--success);font-weight:600">\u2713</span>`
    : (r.status === '429'
      ? `<span style="color:var(--warning);font-weight:600">429</span>`
      : `<span style="color:var(--error);font-weight:600">\u2717</span>`);
  const latency = r.latencyMs ? `<span style="color:var(--text-muted)">${r.latencyMs}ms</span>` : '-';
  const tokens = r.totalTokens ? formatTokens(r.totalTokens) : '-';
  const keyLabel = r.keyAlias || (r.key ? `\u2026${r.key.slice(-4)}` : '-');

  if (compact) {
    return `
      <tr>
        <td>${time}</td>
        <td>${escapeHtml(r.proxyName || r.proxyId || '-')}</td>
        <td><code>${escapeHtml(r.inboundProtocol || '-')}</code></td>
        <td><code>${escapeHtml(r.model || '-')}</code></td>
        <td>${status}</td>
        <td class="num">${latency}</td>
      </tr>
    `;
  }

  return `
    <tr class="clickable" data-entry-id="${escapeHtml(r.id || '')}">
      <td>${time}</td>
      <td>${escapeHtml(r.proxyName || r.proxyId || '-')}</td>
      <td><code>${escapeHtml(r.inboundProtocol || '-')}</code></td>
      <td><code>${escapeHtml(r.model || '-')}</code></td>
      <td>${status}</td>
      <td class="num">${tokens}</td>
      <td class="num">${latency}</td>
      <td>${escapeHtml(r.providerName || r.provider || '-')}</td>
      <td><span style="font-family:var(--font-mono);font-size:12px;color:var(--text-muted)">${escapeHtml(keyLabel)}</span></td>
    </tr>
  `;
}

function filterRequestLogs() {
  renderRequestLogs();
}

function exportRequestLogs() {
  if (requestLogs.length === 0) {
    showToast('\u65e0\u6570\u636e\u53ef\u5bfc\u51fa', true);
    return;
  }
  const rows = [['\u65f6\u95f4', '\u4ee3\u7406', '\u534f\u8bae', '\u6a21\u578b', '\u72b6\u6001', 'Tokens', '\u5ef6\u8fdf', '\u4f9b\u5e94\u5546', 'Key']];
  for (const r of requestLogs) {
    rows.push([r.timestamp || '-', r.proxyName || r.proxyId || '-', r.inboundProtocol || '-', r.model || '-', r.status === 'success' ? '\u6210\u529f' : '\u5931\u8d25', r.totalTokens || 0, r.latencyMs || 0, r.providerName || '-', r.keyAlias || '-']);
  }
  const csv = '\ufeff' + rows.map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `request-logs-${new Date().toISOString().slice(0,10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

function clearRequestLogs() {
  requestLogs = [];
  renderRequestLogs();
}

// ---------- System Logs ----------
function renderLogs(lines) {
  const container = document.getElementById('log-content');
  if (!container) return;
  if (!lines || lines.length === 0) {
    container.innerHTML = '<div class="empty-sm">\u6682\u65e0\u65e5\u5fd7</div>';
    return;
  }
  container.innerHTML = lines.map(line => {
    const levelMatch = line.match(/\[(ERROR|WARN|INFO)\]/i);
    let levelClass = '';
    if (levelMatch) {
      const lvl = levelMatch[1].toUpperCase();
      if (lvl === 'ERROR') levelClass = 'log-level-error';
      else if (lvl === 'WARN') levelClass = 'log-level-warn';
      else levelClass = 'log-level-info';
    }
    const timeMatch = line.match(/^(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2})/);
    let display = escapeHtml(line);
    if (timeMatch) {
      display = `<span class="log-time">${escapeHtml(timeMatch[1])}</span>` + escapeHtml(line.slice(timeMatch[1].length));
    }
    return `<div class="log-line ${levelClass}">${display}</div>`;
  }).join('');
  container.scrollTop = container.scrollHeight;
}

// ---------- Config Import/Export ----------
async function exportConfig() {
  try {
    const res = await fetch('/api/config/export');
    const data = await res.json();
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `config-backup-${new Date().toISOString().slice(0,10).replace(/-/g,'')}.json`;
    a.click();
    URL.revokeObjectURL(url);
    showToast('\u914d\u7f6e\u5df2\u5bfc\u51fa');
  } catch (err) {
    showToast('\u5bfc\u51fa\u5931\u8d25: ' + err.message, true);
  }
}

function handleImportFile(e) {
  const file = e.target.files[0];
  if (!file) return;
  e.target.value = '';
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const data = JSON.parse(reader.result);
      if (!Array.isArray(data.providers) || !Array.isArray(data.proxies)) {
        showToast('\u914d\u7f6e\u683c\u5f0f\u9519\u8bef', true);
        return;
      }
      importData = data;
      document.getElementById('import-providers-count').textContent = data.providers.length;
      document.getElementById('import-proxies-count').textContent = data.proxies.length;
      showModal('import-modal');
    } catch (err) {
      showToast('\u6587\u4ef6\u89e3\u6790\u5931\u8d25: ' + err.message, true);
    }
  };
  reader.readAsText(file);
}

function closeImportModal() {
  hideModal('import-modal');
  importData = null;
}

async function confirmImport() {
  if (!importData) return;
  const mode = document.querySelector('input[name="import-mode"]:checked')?.value || 'merge';
  if (mode === 'overwrite') {
    const ok = await showConfirm('\u786e\u8ba4<strong>\u8986\u76d6</strong>\u73b0\u6709\u914d\u7f6e\uff1f\u6b64\u64cd\u4f5c\u4e0d\u53ef\u64a4\u9500\u3002');
    if (!ok) return;
  }
  try {
    const res = await fetch('/api/config/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ config: importData, mode }),
    });
    const result = await res.json();
    if (!res.ok) {
      showToast(result.error || '\u5bfc\u5165\u5931\u8d25', true);
      return;
    }
    closeImportModal();
    await Promise.all([loadProxies(), loadProviders()]);
    const added = result.added;
    let msg = `\u5bfc\u5165\u6210\u529f`;
    if (added) msg += `\uff1a\u65b0\u589e ${added.providers} \u4f9b\u5e94\u5546\u3001${added.proxies} \u4ee3\u7406`;
    showToast(msg);
    const restart = await showConfirm(msg + `\u3002<br><br>\u662f\u5426\u7acb\u5373\u91cd\u542f\u6240\u6709\u4ee3\u7406\uff1f`);
    if (restart) {
      await restartAllProxies();
    }
  } catch (err) {
    showToast('\u5bfc\u5165\u5931\u8d25: ' + err.message, true);
  }
}

async function restartAllProxies() {
  try {
    const statusRes = await fetch('/api/status');
    const status = await statusRes.json();
    const runningIds = (status.running || []).map(r => r.id);
    for (const id of runningIds) {
      await fetch(`/api/proxies/${id}/stop`, { method: 'POST' });
    }
    await loadProxies();
    for (const p of proxies) {
      await fetch(`/api/proxies/${p.id}/start`, { method: 'POST' });
    }
    await loadProxies();
    showToast('\u6240\u6709\u4ee3\u7406\u5df2\u91cd\u542f');
  } catch (err) {
    showToast('\u91cd\u542f\u5931\u8d25: ' + err.message, true);
  }
}

// ---------- History Modal ----------
let _historySnapshots = [];

async function openHistoryModal() {
  try {
    const res = await fetch('/api/config/history');
    const data = await res.json();
    const list = document.getElementById('history-list');
    const snapshots = data.snapshots || [];
    _historySnapshots = snapshots;
    if (snapshots.length === 0) {
      list.innerHTML = '<div class="empty-sm">\u6682\u65e0\u5386\u53f2\u8bb0\u5f55</div>';
    } else {
      list.innerHTML = snapshots.map((s, i) => {
        const isReconstructed = !s.hasSnapshot && s.reconstructable;
        const badge = s.hasSnapshot ? '' : '<span class="history-badge reconstructed">\u91cd\u5efa</span>';
        const rollbackBtn = i === 0 ? '' : `<button class="btn btn-sm" onclick="rollbackConfig('${escapeHtml(s.id)}')">${s.hasSnapshot ? '\u56de\u6eda' : '\u91cd\u5efa\u56de\u6eda'}</button>`;
        return `
        <div class="history-item${i === 0 ? ' is-head' : ''}${isReconstructed ? ' is-reconstructed' : ''}">
          <div class="history-meta">
            <div class="history-name">${escapeHtml(s.reason)} ${badge}</div>
            <div class="history-reason">${new Date(s.timestamp).toLocaleString('zh-CN')}</div>
            ${s.summary ? '<div class="history-summary">' + escapeHtml(s.summary) + '</div>' : ''}
          </div>
          <div class="history-actions">
            <button class="btn btn-sm" onclick="openDiffModal(${i})">\u5bf9\u6bd4</button>
            ${rollbackBtn}
          </div>
        </div>
      `}).join('');
    }
    showModal('history-modal');
  } catch (err) {
    showToast('\u52a0\u8f7d\u5386\u53f2\u5931\u8d25: ' + err.message, true);
  }
}

function closeHistoryModal() {
  hideModal('history-modal');
}

async function rollbackConfig(versionId) {
  const ok = await showConfirm(`\u786e\u5b9a\u56de\u6eda\u5230\u8be5\u7248\u672c\uff1f`);
  if (!ok) return;
  try {
    const res = await fetch('/api/config/rollback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ versionId }),
    });
    const data = await res.json();
    if (data.error) {
      showToast('\u56de\u6eda\u5931\u8d25: ' + data.error, true);
      return;
    }
    closeHistoryModal();
    await Promise.all([loadProxies(), loadProviders()]);
    showToast(data.reconstructed ? '\u5df2\u91cd\u5efa\u5e76\u56de\u6eda\u5230\u9009\u5b9a\u7248\u672c' : '\u5df2\u56de\u6eda\u5230\u9009\u5b9a\u7248\u672c');
  } catch (err) {
    showToast('\u56de\u6eda\u5931\u8d25: ' + err.message, true);
  }
}

// ---------- Diff Modal ----------
function openDiffModal(selectedIndex) {
  const fromSelect = document.getElementById('diff-from');
  const toSelect = document.getElementById('diff-to');
  const snapshots = _historySnapshots;
  if (!snapshots.length) return;

  const options = snapshots.map((s, i) => {
    const label = `${s.reason} \u00b7 ${new Date(s.timestamp).toLocaleString('zh-CN')}${s.hasSnapshot ? '' : ' [\u91cd\u5efa]'}`;
    return '<option value="' + i + '">' + escapeHtml(label) + '</option>';
  }).join('');

  fromSelect.innerHTML = options;
  toSelect.innerHTML = options;

  // \u9ed8\u8ba4\u9009\u62e9\uff1afrom = selectedIndex \u6216\u5012\u6570\u7b2c\u4e8c\u4e2a, to = \u7b2c\u4e00\u4e2a\uff08\u6700\u65b0\uff09
  if (snapshots.length >= 2) {
    const fromIdx = selectedIndex != null ? selectedIndex : snapshots.length - 2;
    fromSelect.value = Math.min(fromIdx, snapshots.length - 1);
    toSelect.value = 0;
  }

  document.getElementById('diff-result').innerHTML = '';
  showModal('diff-modal');
  if (snapshots.length >= 2) loadVersionDiff();
}

function closeDiffModal() {
  hideModal('diff-modal');
}

async function loadVersionDiff() {
  const fromIdx = parseInt(document.getElementById('diff-from').value, 10);
  const toIdx = parseInt(document.getElementById('diff-to').value, 10);
  const resultDiv = document.getElementById('diff-result');

  if (isNaN(fromIdx) || isNaN(toIdx)) {
    resultDiv.innerHTML = '<div class="diff-empty">\u8bf7\u9009\u62e9\u4e24\u4e2a\u7248\u672c</div>';
    return;
  }
  if (fromIdx === toIdx) {
    resultDiv.innerHTML = '<div class="diff-empty">\u4e24\u4e2a\u7248\u672c\u76f8\u540c\uff0c\u65e0\u5dee\u5f02</div>';
    return;
  }

  const snapshots = _historySnapshots;
  const fromSnap = snapshots[fromIdx];
  const toSnap = snapshots[toIdx];
  if (!fromSnap || !toSnap) {
    resultDiv.innerHTML = '<div class="diff-empty">\u7248\u672c\u9009\u62e9\u65e0\u6548</div>';
    return;
  }

  resultDiv.innerHTML = '<div class="diff-empty">\u52a0\u8f7d\u4e2d...</div>';

  try {
    let url;
    // \u5982\u679c\u4e24\u4e2a\u7248\u672c\u90fd\u6709\u5feb\u7167\uff0c\u4f7f\u7528\u65e7\u7aef\u70b9\uff08\u66f4\u5feb\uff09
    if (fromSnap.hasSnapshot && toSnap.hasSnapshot) {
      url = `/api/config/diff?from=${encodeURIComponent(fromSnap.file)}&to=${encodeURIComponent(toSnap.file)}`;
    } else {
      // \u81f3\u5c11\u4e00\u4e2a\u6ca1\u6709\u5feb\u7167\uff0c\u4f7f\u7528\u91cd\u5efa\u7aef\u70b9
      url = `/api/config/diff-version?fromVersionId=${encodeURIComponent(fromSnap.id)}&toVersionId=${encodeURIComponent(toSnap.id)}`;
    }
    const res = await fetch(url);
    const diff = await res.json();
    if (diff.error) {
      resultDiv.innerHTML = '<div class="diff-empty">' + escapeHtml(diff.error) + '</div>';
      return;
    }
    renderDiff(diff, resultDiv);
  } catch (err) {
    resultDiv.innerHTML = '<div class="diff-empty">\u52a0\u8f7d\u5bf9\u6bd4\u5931\u8d25: ' + escapeHtml(err.message) + '</div>';
  }
}

function renderDiff(diff, container) {
  const sections = [];
  if (diff.added && diff.added.length) {
    sections.push(`
      <div class="diff-section">
        <div class="diff-section-title added">\u65b0\u589e (${diff.added.length})</div>
        ${diff.added.map(a => `
          <div class="diff-entry added">
            <span class="diff-path">${escapeHtml(a.path)}</span>
            ${formatDiffValue(a.value)}
          </div>
        `).join('')}
      </div>
    `);
  }
  if (diff.removed && diff.removed.length) {
    sections.push(`
      <div class="diff-section">
        <div class="diff-section-title removed">\u5220\u9664 (${diff.removed.length})</div>
        ${diff.removed.map(r => `
          <div class="diff-entry removed">
            <span class="diff-path">${escapeHtml(r.path)}</span>
            ${formatDiffValue(r.oldValue)}
          </div>
        `).join('')}
      </div>
    `);
  }
  if (diff.changed && diff.changed.length) {
    sections.push(`
      <div class="diff-section">
        <div class="diff-section-title changed">\u4fee\u6539 (${diff.changed.length})</div>
        ${diff.changed.map(c => `
          <div class="diff-entry changed">
            <span class="diff-path">${escapeHtml(c.path)}</span>
            <span class="diff-old-value">${escapeHtml(JSON.stringify(c.oldValue))}</span>
            \u2192
            <span class="diff-new-value">${escapeHtml(JSON.stringify(c.newValue))}</span>
          </div>
        `).join('')}
      </div>
    `);
  }
  if (!sections.length) {
    container.innerHTML = '<div class="diff-empty">\u4e24\u4e2a\u7248\u672c\u914d\u7f6e\u5b8c\u5168\u76f8\u540c</div>';
  } else {
    container.innerHTML = sections.join('');
  }
}

function formatDiffValue(val) {
  if (val === null || val === undefined) return '<em>null</em>';
  if (typeof val === 'object') return '<code>' + escapeHtml(JSON.stringify(val)) + '</code>';
  return escapeHtml(String(val));
}

// ---------- Confirm Modal ----------
let confirmResolve = null;

function showConfirm(html, okText) {
  return new Promise(resolve => {
    confirmResolve = resolve;
    document.getElementById('confirm-text').innerHTML = html;
    const okBtn = document.getElementById('confirm-ok');
    okBtn.textContent = okText || '\u786e\u8ba4';
    okBtn.onclick = () => { hideModal('confirm-modal'); resolve(true); };
    document.getElementById('confirm-cancel').onclick = () => { hideModal('confirm-modal'); resolve(false); };
    showModal('confirm-modal');
  });
}

// ---------- Modal Helpers ----------
function showModal(id) {
  const overlay = document.getElementById(id);
  if (overlay) overlay.classList.add('active');
}

function hideModal(id) {
  const overlay = document.getElementById(id);
  if (overlay) overlay.classList.remove('active');
}

// Close modal on overlay click
document.querySelectorAll('.modal-overlay').forEach(overlay => {
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) overlay.classList.remove('active');
  });
});

// Close modal on Escape
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    document.querySelectorAll('.modal-overlay.active').forEach(o => o.classList.remove('active'));
  }
});

// ---------- Toast ----------
let toastTimer = null;
function showToast(message, isError) {
  const toast = document.getElementById('toast');
  toast.textContent = message;
  toast.className = 'toast' + (isError ? ' error' : '');
  toast.style.display = 'block';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.style.display = 'none'; }, 2800);
}

// ---------- Utilities ----------
function escapeHtml(text) {
  if (text == null) return '';
  const div = document.createElement('div');
  div.textContent = String(text);
  return div.innerHTML;
}

function formatTokens(n) {
  if (!n || n === 0) return '0';
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'm';
  if (n >= 1000) return (n / 1000).toFixed(0) + 'k';
  return n.toLocaleString();
}


// ---------- Onboarding ----------

function openOnboardingModal() {
  document.getElementById('onboarding-url').value = '';
  document.getElementById('onboarding-key').value = '';
  document.getElementById('onboarding-protocol').value = 'openai';
  document.getElementById('onboarding-model').value = '';
  const statusEl = document.getElementById('onboarding-status');
  if (statusEl) { statusEl.style.display = 'none'; statusEl.className = ''; }
  const saveBtn = document.getElementById('onboarding-save-btn');
  if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = '保存并启动'; }
  showModal('onboarding-modal');
}

function closeOnboardingModal() {
  hideModal('onboarding-modal');
  localStorage.setItem('onboardingDismissed', 'true');
}

function onboardingDetectProtocol() {
  const url = document.getElementById('onboarding-url').value.trim().toLowerCase();
  if (!url) return;
  const select = document.getElementById('onboarding-protocol');
  if (url.includes('anthropic')) select.value = 'anthropic';
  else if (url.includes('google') || url.includes('gemini')) select.value = 'gemini';
  else select.value = 'openai';
  onboardingAutoFetchModels();
}

let _onboardingFetchTimer = null;
function onboardingAutoFetchModels() {
  const url = document.getElementById('onboarding-url').value.trim();
  const key = document.getElementById('onboarding-key').value.trim();
  if (!url || !key) return;
  const model = document.getElementById('onboarding-model').value.trim();
  if (model) return;
  const btn = document.getElementById('onboarding-fetch-models-btn');
  if (btn.disabled) return;
  clearTimeout(_onboardingFetchTimer);
  _onboardingFetchTimer = setTimeout(() => onboardingFetchModels(), 300);
}

function onboardingProtocolChanged() {
  document.getElementById('onboarding-model').value = '';
}

async function onboardingFetchModels() {
  const url = document.getElementById('onboarding-url').value.trim();
  const key = document.getElementById('onboarding-key').value.trim();
  const protocol = document.getElementById('onboarding-protocol').value;
  if (!url || !key) {
    showOnboardingStatus('请先填写 API 地址和 API Key', true);
    return;
  }
  const btn = document.getElementById('onboarding-fetch-models-btn');
  btn.disabled = true;
  btn.textContent = '...';
  try {
    const res = await fetch('/api/providers/available-models', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, protocol, apiKey: key }),
    });
    const data = await res.json();
    if (data.models && data.models.length > 0) {
      const first = data.models[0];
      document.getElementById('onboarding-model').value = typeof first === 'string' ? first : first.name;
      showOnboardingStatus(`已获取 ${data.models.length} 个模型`, false);
    } else {
      showOnboardingStatus(data.message || '未获取到模型列表，请手动输入', true);
    }
  } catch (err) {
    showOnboardingStatus('获取模型列表失败: ' + err.message, true);
  } finally {
    btn.disabled = false;
    btn.textContent = '⚡';
  }
}

function showOnboardingStatus(message, isError) {
  const el = document.getElementById('onboarding-status');
  if (!el) return;
  el.textContent = message;
  el.style.display = 'block';
  el.className = isError ? 'error' : 'success';
}

async function handleOnboardingSave() {
  const url = document.getElementById('onboarding-url').value.trim();
  const key = document.getElementById('onboarding-key').value.trim();
  const protocol = document.getElementById('onboarding-protocol').value;
  const model = document.getElementById('onboarding-model').value.trim();

  if (!url) { showOnboardingStatus('请填写 API 地址', true); return; }
  if (!key) { showOnboardingStatus('请填写 API Key', true); return; }
  if (!model) { showOnboardingStatus('请填写或选择模型', true); return; }

  const saveBtn = document.getElementById('onboarding-save-btn');
  saveBtn.disabled = true;
  saveBtn.textContent = '测试中...';

  // 第一步：真实对话测试
  try {
    const testRes = await fetch('/api/onboarding/test-chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, protocol, apiKey: key, model }),
    });
    const testData = await testRes.json();
    if (!testData.ok) {
      showOnboardingStatus('模型测试失败: ' + testData.message, true);
      saveBtn.disabled = false;
      saveBtn.textContent = '保存并启动';
      return;
    }
  } catch (err) {
    showOnboardingStatus('测试请求失败: ' + err.message, true);
    saveBtn.disabled = false;
    saveBtn.textContent = '保存并启动';
    return;
  }

  // 第二步：创建供应商和代理
  saveBtn.textContent = '创建中...';
  try {
    const setupRes = await fetch('/api/onboarding/setup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, protocol, apiKey: key, model }),
    });
    const setupData = await setupRes.json();
    if (!setupData.ok) {
      showOnboardingStatus('创建失败: ' + setupData.message, true);
      saveBtn.disabled = false;
      saveBtn.textContent = '保存并启动';
      return;
    }

    showOnboardingStatus('代理创建成功！正在启动...', false);
    await loadProxies();
    await loadProviders();
    hideModal('onboarding-modal');
    showToast(`代理已创建并启动，端口 :${setupData.proxy.port}`);
    navigateTo('proxies');
  } catch (err) {
    showOnboardingStatus('创建失败: ' + err.message, true);
    saveBtn.disabled = false;
    saveBtn.textContent = '保存并启动';
  }
}

// ---------- Initialization ----------
async function init() {
  // Set default dates for stats
  const today = new Date().toISOString().slice(0, 10);
  const startInput = document.getElementById('stats-start');
  const endInput = document.getElementById('stats-end');
  if (startInput && !startInput.value) startInput.value = today;
  if (endInput && !endInput.value) endInput.value = today;

  // Safe event bindings
  const proxyAuth = document.getElementById('proxy-auth');
  if (proxyAuth) proxyAuth.addEventListener('change', function() {
    document.getElementById('proxy-auth-token-group').style.display = this.value === 'true' ? '' : 'none';
  });
  const proxyProvider = document.getElementById('proxy-provider');
  if (proxyProvider) proxyProvider.addEventListener('change', function() {
    updateProxyModelSelect(this.value);
  });
  const providerProtocol = document.getElementById('provider-protocol');
  if (providerProtocol) providerProtocol.addEventListener('change', function() {
    document.getElementById('provider-azure-row').style.display = this.value === 'openai' ? 'grid' : 'none';
  });

  // 加载版本号
  fetch('/api/health').then(r => r.json()).then(d => {
    const el = document.getElementById('app-version');
    if (el && d.version) el.textContent = 'v' + d.version;
  }).catch(() => {});

  await Promise.all([loadProxies(), loadProviders(), loadKeyHealth(), loadMultimodal()]);
  loadStats();
  loadLogs();
  loadRequestLogHistory();
  connectRequestLogWS();
  refreshDashboard();

  // Request log row click → toggle detail
  const rqTbody = document.getElementById('rq-tbody');
  if (rqTbody && !rqTbody._delegated) {
    rqTbody.addEventListener('click', (ev) => {
      const row = ev.target.closest('tr.clickable');
      if (!row || row.parentElement !== rqTbody) return;
      const entryId = row.dataset.entryId;
      const entry = requestLogs.find(r => r.id === entryId);
      if (entry) toggleRequestLogDetail(row, entry);
    });
    rqTbody._delegated = true;
  }

  // Auto-refresh
  setInterval(loadStats, 30000);
  setInterval(loadKeyHealth, 5 * 60 * 1000);

  // ==================== Onboarding ====================

  if (proxies.length === 0 && !localStorage.getItem('onboardingDismissed')) {
    setTimeout(() => openOnboardingModal(), 500);
  }

  // ==================== Assistant textarea auto-resize + skill autocomplete
  const assistantInput = document.getElementById('assistant-input');
  if (assistantInput) {
    assistantInput.addEventListener('input', function() {
      this.style.height = 'auto';
      this.style.height = Math.min(this.scrollHeight, 120) + 'px';
      updateSkillAutocomplete(this.value);
    });
    assistantInput.addEventListener('keydown', function(e) {
      const ac = document.getElementById('skill-autocomplete');
      const isOpen = ac && ac.style.display === 'block';
      const items = isOpen ? ac.querySelectorAll('.skill-ac-item') : [];

      if (e.key === 'ArrowDown' && isOpen) {
        e.preventDefault();
        skillAcIndex = skillAcIndex < items.length - 1 ? skillAcIndex + 1 : 0;
        highlightAcItem(items, skillAcIndex);
      } else if (e.key === 'ArrowUp' && isOpen) {
        e.preventDefault();
        skillAcIndex = skillAcIndex > 0 ? skillAcIndex - 1 : items.length - 1;
        highlightAcItem(items, skillAcIndex);
      } else if (e.key === 'Enter' && !e.shiftKey) {
        if (isOpen && skillAcIndex >= 0 && items[skillAcIndex]) {
          e.preventDefault();
          selectSkill(items[skillAcIndex].dataset.name);
        } else {
          e.preventDefault();
          sendAssistantMessage();
        }
      } else if (e.key === 'Escape') {
        if (isOpen) {
          ac.style.display = 'none';
          skillAcIndex = -1;
        } else if (assistantDisplayedConvId && assistantConvControllers.has(assistantDisplayedConvId)) {
          assistantConvControllers.get(assistantDisplayedConvId).abort();
        }
      }
    });
    // 粘贴图片/音频/视频支持
    assistantInput.addEventListener('paste', function(e) {
      const items = e.clipboardData?.items;
      if (!items) return;
      const files = [];
      for (const item of items) {
        if (item.kind === 'file') {
          const file = item.getAsFile();
          if (file) files.push(file);
        }
      }
      if (files.length > 0) {
        e.preventDefault();
        handleAssistantFileSelect(files);
        return;
      }
      // 检测粘贴的视频 URL
      const text = e.clipboardData?.getData('text/plain')?.trim();
      if (text && /^https?:\/\/\S+\.(mp4|mov|avi|wmv)(\?|$)/i.test(text)) {
        e.preventDefault();
        addVideoUrlAttachment(text);
      }
    });
    // 拖拽文件到输入框
    assistantInput.addEventListener('dragover', function(e) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      assistantInput.classList.add('drag-over');
    });
    assistantInput.addEventListener('dragleave', function() {
      assistantInput.classList.remove('drag-over');
    });
    assistantInput.addEventListener('drop', function(e) {
      e.preventDefault();
      assistantInput.classList.remove('drag-over');
      if (e.dataTransfer.files.length > 0) {
        handleAssistantFileSelect(e.dataTransfer.files);
      }
    });
  }
  // 点击外部关闭补全
  document.addEventListener('click', (e) => {
    const ac = document.getElementById('skill-autocomplete');
    if (ac && !ac.contains(e.target) && e.target.id !== 'assistant-input') {
      ac.style.display = 'none';
    }
  });
}

async function loadRequestLogHistory() {
  try {
    const res = await fetch('/api/request-logs?limit=200');
    const data = await res.json();
    requestLogs = data.entries || [];
    if (currentPage === 'request-logs') renderRequestLogs();
    if (currentPage === 'dashboard') renderDashRecentRequests();
  } catch (err) {
    console.error('loadRequestLogHistory error:', err);
  }
}

// ---------- Assistant ----------

function populateAssistantProxySelect() {
  const running = proxies.filter(p => p.running);
  const preferredId = (assistantProxyId && running.find(p => p.id === assistantProxyId)) ? assistantProxyId
    : (savedAssistantProxyId && running.find(p => p.id === savedAssistantProxyId)) ? savedAssistantProxyId
    : running.length > 0 ? running[0].id : '';
  if (preferredId) {
    assistantProxyId = preferredId;
    _treeExpandedProxies.add(preferredId);
    document.getElementById('assistant-send-btn').disabled = false;
    buildModelTree();
    loadProxyProviders(preferredId);
  } else {
    assistantProxyId = '';
    document.getElementById('assistant-send-btn').disabled = true;
    buildModelTree();
  }
}

// ==================== 语音录音 ====================

let voiceMediaRecorder = null;
let voiceAudioChunks = [];
let isVoiceRecording = false;
let voiceAnalyser = null;
let voiceAnimFrameId = null;
let voicePendingSend = false; // 停止录音后自动发送

const MIC_SVG_IDLE = `<svg width="20" height="20" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg" style="pointer-events:none">
  <path d="M10 1a3.5 3.5 0 0 0-3.5 3.5v4a3.5 3.5 0 0 0 7 0v-4A3.5 3.5 0 0 0 10 1z" fill="#888"/>
  <path d="M10 1a3.5 3.5 0 0 0-3.5 3.5v4a3.5 3.5 0 0 0 7 0v-4A3.5 3.5 0 0 0 10 1z" stroke="#888" stroke-width="1.2" fill="none"/>
  <path d="M5 9.5a5 5 0 0 0 10 0" stroke="#888" stroke-width="1.2" fill="none" stroke-linecap="round"/>
  <line x1="10" y1="14.5" x2="10" y2="17" stroke="#888" stroke-width="1.2" stroke-linecap="round"/>
  <line x1="7.5" y1="17" x2="12.5" y2="17" stroke="#888" stroke-width="1.2" stroke-linecap="round"/>
</svg>`;

function buildMicSvg(fillRatio) {
  const y = 20 - fillRatio * 20;
  return `<svg width="20" height="20" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg" style="pointer-events:none">
    <defs><clipPath id="mic-fill-clip"><rect x="0" y="${y}" width="20" height="20"/></clipPath></defs>
    <path d="M10 1a3.5 3.5 0 0 0-3.5 3.5v4a3.5 3.5 0 0 0 7 0v-4A3.5 3.5 0 0 0 10 1z" fill="#ef4444" clip-path="url(#mic-fill-clip)"/>
    <path d="M10 1a3.5 3.5 0 0 0-3.5 3.5v4a3.5 3.5 0 0 0 7 0v-4A3.5 3.5 0 0 0 10 1z" stroke="#ef4444" stroke-width="1.2" fill="none"/>
    <path d="M5 9.5a5 5 0 0 0 10 0" stroke="#ef4444" stroke-width="1.2" fill="none" stroke-linecap="round"/>
    <line x1="10" y1="14.5" x2="10" y2="17" stroke="#ef4444" stroke-width="1.2" stroke-linecap="round"/>
    <line x1="7.5" y1="17" x2="12.5" y2="17" stroke="#ef4444" stroke-width="1.2" stroke-linecap="round"/>
  </svg>`;
}

function toggleVoiceRecording() {
  if (isVoiceRecording) {
    stopVoiceRecording();
  } else {
    startVoiceRecording();
  }
}

async function startVoiceRecording() {
  // 检查当前供应商是否支持音频输入
  const proxy = proxies.find(p => p.id === assistantProxyId);
  const selectedProvider = assistantProviderId
    ? proxyProviders.find(p => p.id === assistantProviderId)
    : proxy?.providerId
      ? proxyProviders.find(p => p.id === proxy.providerId)
      : null;
  const protocol = selectedProvider?.protocol || '';
  if (protocol === 'anthropic') {
    const cancelBtn = document.getElementById('confirm-cancel');
    cancelBtn.style.display = 'none';
    showConfirm(`${selectedProvider?.name || '当前供应商'} 使用 Anthropic 协议，不支持语音输入。<br>请切换到 OpenAI 协议的供应商，或改用文字输入。`, '知道了').then(() => { cancelBtn.style.display = ''; });
    return;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
      ? 'audio/webm;codecs=opus'
      : MediaRecorder.isTypeSupported('audio/webm')
        ? 'audio/webm'
        : '';

    // 创建音量分析器
    const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const source = audioCtx.createMediaStreamSource(stream);
    voiceAnalyser = audioCtx.createAnalyser();
    voiceAnalyser.fftSize = 256;
    source.connect(voiceAnalyser);

    voiceMediaRecorder = new MediaRecorder(stream, mimeType ? { mimeType } : {});
    voiceAudioChunks = [];

    voiceMediaRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) voiceAudioChunks.push(e.data);
    };

    voiceMediaRecorder.onstop = async () => {
      const blob = new Blob(voiceAudioChunks, { type: mimeType || 'audio/webm' });
      await convertBlobToWavAttachment(blob);
      stream.getTracks().forEach(t => t.stop());
      audioCtx.close();
      if (voicePendingSend) { voicePendingSend = false; sendAssistantMessage(); }
    };

    voiceMediaRecorder.start();
    isVoiceRecording = true;
    updateMicButtonState();
    startVolumeAnimation();
  } catch (err) {
    showToast('无法访问麦克风: ' + err.message, true);
  }
}

function stopVoiceRecording(autoSend) {
  if (!isVoiceRecording) return;
  voicePendingSend = !!autoSend;
  isVoiceRecording = false;
  stopVolumeAnimation();
  updateMicButtonState();
  try {
    if (voiceMediaRecorder && voiceMediaRecorder.state !== 'inactive') {
      voiceMediaRecorder.stop();
    } else {
      // MediaRecorder 已停止，直接检查是否需要自动发送
      if (voicePendingSend) { voicePendingSend = false; sendAssistantMessage(); }
    }
  } catch (err) {
    console.error('停止录音失败:', err);
    showToast('停止录音失败: ' + err.message, true);
  }
}

function startVolumeAnimation() {
  const btn = document.getElementById('mic-btn');
  if (!btn || !voiceAnalyser) return;
  const dataArray = new Uint8Array(voiceAnalyser.frequencyBinCount);
  let smoothVol = 0;

  function animate() {
    if (!isVoiceRecording) return;
    voiceAnalyser.getByteFrequencyData(dataArray);
    let sum = 0;
    for (let i = 0; i < dataArray.length; i++) sum += dataArray[i];
    const avg = sum / dataArray.length;
    smoothVol += (avg - smoothVol) * 0.3;
    const ratio = Math.min(smoothVol / 100, 1);
    btn.innerHTML = buildMicSvg(ratio);
    voiceAnimFrameId = requestAnimationFrame(animate);
  }
  voiceAnimFrameId = requestAnimationFrame(animate);
}

function stopVolumeAnimation() {
  if (voiceAnimFrameId) {
    cancelAnimationFrame(voiceAnimFrameId);
    voiceAnimFrameId = null;
  }
  voiceAnalyser = null;
  const btn = document.getElementById('mic-btn');
  if (btn) btn.innerHTML = MIC_SVG_IDLE;
}

function updateMicButtonState() {
  const btn = document.getElementById('mic-btn');
  if (!btn) return;
  if (isVoiceRecording) {
    btn.innerHTML = buildMicSvg(0);
    btn.title = '点击停止录音';
  } else {
    btn.innerHTML = MIC_SVG_IDLE;
    btn.title = '语音输入';
  }
}
updateMicButtonState();

async function convertBlobToWavAttachment(blob) {
  const arrayBuffer = await blob.arrayBuffer();
  const audioContext = new (window.AudioContext || window.webkitAudioContext)();
  const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);
  const wavBuffer = audioBufferToWav(audioBuffer);
  const base64 = arrayBufferToBase64(wavBuffer);

  const timeStr = new Date().toLocaleTimeString('zh-CN', { hour12: false }).replace(/:/g, '-');
  assistantAttachments.push({
    type: 'input_audio',
    mimeType: 'audio/wav',
    name: `录音_${timeStr}.wav`,
    data: base64,
  });
  renderAttachmentPreview();
  await audioContext.close();
}

function audioBufferToWav(buffer) {
  const numOfChannels = buffer.numberOfChannels;
  const sampleRate = buffer.sampleRate;
  const format = 1;
  const bitDepth = 16;
  const bytesPerSample = bitDepth / 8;
  const blockAlign = numOfChannels * bytesPerSample;
  const dataLength = buffer.length * numOfChannels * bytesPerSample;
  const arrayBuffer = new ArrayBuffer(44 + dataLength);
  const view = new DataView(arrayBuffer);

  function writeString(offset, string) {
    for (let i = 0; i < string.length; i++) {
      view.setUint8(offset + i, string.charCodeAt(i));
    }
  }

  writeString(0, 'RIFF');
  view.setUint32(4, 36 + dataLength, true);
  writeString(8, 'WAVE');
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, format, true);
  view.setUint16(22, numOfChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitDepth, true);
  writeString(36, 'data');
  view.setUint32(40, dataLength, true);

  const channels = [];
  for (let i = 0; i < numOfChannels; i++) {
    channels.push(buffer.getChannelData(i));
  }

  let index = 0;
  const offset = 44;
  for (let i = 0; i < buffer.length; i++) {
    for (let c = 0; c < numOfChannels; c++) {
      const sample = Math.max(-1, Math.min(1, channels[c][i]));
      const intSample = sample < 0 ? sample * 0x8000 : sample * 0x7FFF;
      view.setInt16(offset + index, intSample, true);
      index += 2;
    }
  }

  return arrayBuffer;
}

function arrayBufferToBase64(buffer) {
  let binary = '';
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

// ==================== 多模态附件处理 ====================

function isTextFile(file) {
  if (file.type.startsWith('text/')) return true;
  const ext = (file.name.split('.').pop() || '').toLowerCase();
  return ['txt','json','csv','md','js','ts','jsx','tsx','py','rb','go','java','c','cpp','h','hpp','css','html','xml','yaml','yml','toml','ini','sh','bat','ps1','sql','log','env','gitignore','dockerfile','makefile'].includes(ext);
}

function isDocumentFile(file) {
  const ext = (file.name.split('.').pop() || '').toLowerCase();
  return ['pdf', 'docx', 'pptx', 'xlsx'].includes(ext);
}

function handleAssistantFileSelect(files) {
  if (!files || files.length === 0) return;
  const MAX_BASE64_SIZE = 37 * 1024 * 1024; // 原始文件上限，base64 编码后约 50MB
  for (const file of files) {
    if (file.type.startsWith('image/')) {
      // 图片：读取 base64
      readAsBase64(file, 'image_url');
    } else if (file.type.startsWith('audio/')) {
      // 音频：读取 base64
      readAsBase64(file, 'input_audio');
    } else if (file.type.startsWith('video/')) {
      if (file.size > MAX_BASE64_SIZE) {
        showToast(`视频文件过大（${(file.size / 1024 / 1024).toFixed(1)}MB），base64 模式限制 50MB，请使用视频 URL 方式`, true);
        continue;
      }
      readAsBase64(file, 'video_url');
    } else if (isTextFile(file)) {
      // 文本文件：读取为文本内容
      readAsText(file);
    } else if (isDocumentFile(file)) {
      // Office/PDF：原样保存，交由 Code Interpreter 处理
      if (file.size > MAX_BASE64_SIZE) {
        showToast(`文件过大（${(file.size / 1024 / 1024).toFixed(1)}MB），限制 50MB`, true);
        continue;
      }
      readAsBase64(file, 'file');
    } else {
      showToast(`暂不支持此文件类型: ${file.name}`, true);
    }
  }
  // 清空 input 以便重复选择同一文件
  const input = document.getElementById('assistant-file-input');
  if (input) input.value = '';
}

function readAsBase64(file, type) {
  const reader = new FileReader();
  reader.onload = (e) => {
    assistantAttachments.push({
      type,
      mimeType: file.type,
      name: file.name,
      data: e.target.result.split(',')[1],
    });
    renderAttachmentPreview();
  };
  reader.readAsDataURL(file);
}

function readAsText(file) {
  const reader = new FileReader();
  reader.onload = (e) => {
    assistantAttachments.push({
      type: 'text',
      mimeType: file.type || 'text/plain',
      name: file.name,
      data: e.target.result,
    });
    renderAttachmentPreview();
  };
  reader.readAsText(file);
}

function addVideoUrlAttachment(url) {
  // 从 URL 提取文件名
  const pathname = new URL(url).pathname;
  const name = decodeURIComponent(pathname.split('/').pop() || 'video.mp4');
  assistantAttachments.push({
    type: 'video_url',
    mimeType: 'video/mp4',
    name,
    data: url,
    isUrl: true,
  });
  renderAttachmentPreview();
  showToast(`已添加视频链接: ${name}`);
}

function removeAttachment(index) {
  assistantAttachments.splice(index, 1);
  renderAttachmentPreview();
}

function clearAttachments() {
  assistantAttachments = [];
  renderAttachmentPreview();
}

function renderAttachmentPreview() {
  const container = document.getElementById('attachment-preview');
  if (!container) return;
  if (assistantAttachments.length === 0) {
    container.innerHTML = '';
    return;
  }
  container.innerHTML = assistantAttachments.map((att, i) => {
    if (att.type === 'image_url') {
      return `<div class="attachment-item">
        <img src="data:${att.mimeType};base64,${att.data}" alt="${escapeHtml(att.name)}">
        <span class="attachment-name">${escapeHtml(att.name)}</span>
        <button class="attachment-remove" onclick="removeAttachment(${i})" title="移除">×</button>
      </div>`;
    }
    if (att.type === 'video_url') {
      return `<div class="attachment-item">
        <span style="font-size:16px">🎬</span>
        <span class="attachment-name">${escapeHtml(att.name)}</span>
        <button class="attachment-remove" onclick="removeAttachment(${i})" title="移除">×</button>
      </div>`;
    }
    if (att.type === 'text') {
      const lines = att.data.split('\n').length;
      return `<div class="attachment-item">
        <span style="font-size:16px">📄</span>
        <span class="attachment-name">${escapeHtml(att.name)} (${lines}行)</span>
        <button class="attachment-remove" onclick="removeAttachment(${i})" title="移除">×</button>
      </div>`;
    }
    if (att.type === 'file') {
      const sizeKB = Math.round(att.data.length * 3 / 4 / 1024);
      return `<div class="attachment-item">
        <span style="font-size:16px">📎</span>
        <span class="attachment-name">${escapeHtml(att.name)} (${sizeKB}KB)</span>
        <button class="attachment-remove" onclick="removeAttachment(${i})" title="移除">×</button>
      </div>`;
    }
    return `<div class="attachment-item">
      <span style="font-size:16px">🔊</span>
      <span class="attachment-name">${escapeHtml(att.name)}</span>
      <button class="attachment-remove" onclick="removeAttachment(${i})" title="移除">×</button>
    </div>`;
  }).join('');
}

function setSendBtnState(running) {
  const btn = document.getElementById('assistant-send-btn');
  if (!btn) return;
  if (running) {
    btn.textContent = '停止';
    btn.classList.add('btn-stop');
    btn.onclick = () => { const ac = assistantConvControllers.get(assistantDisplayedConvId); if (ac) ac.abort(); };
  } else {
    btn.textContent = '发送';
    btn.classList.remove('btn-stop');
    btn.onclick = sendAssistantMessage;
  }
}

async function sendAssistantMessage() {
  if (assistantConvControllers.has(assistantDisplayedConvId)) return; // 已有请求进行中，防连点
  if (isVoiceRecording) { stopVoiceRecording(true); return; } // 录音中：停止后自动发送
  // 新会话：分配临时 ID，确保消息有正确的 convId 目标
  if (!assistantDisplayedConvId) {
    assistantDisplayedConvId = 'new-' + Date.now();
    setCurrentConvId(assistantDisplayedConvId);
  }
  const input = document.getElementById('assistant-input');
  const text = input.value.trim();
  const hasAttachments = assistantAttachments.length > 0;
  if (!text && !hasAttachments) return;

  // 客户端命令拦截（在代理检查之前，/help 等命令不需要代理）
  if (text.startsWith('/')) {
    const cmdMatch = text.match(/^\/(\w+)(?:\s+(.*))?$/);
    if (cmdMatch) {
      const cmd = cmdMatch[1].toLowerCase();
      const handled = handleSlashCommand(cmd, cmdMatch[2]);
      if (handled) {
        input.value = '';
        input.style.height = 'auto';
        return;
      }
    }
  }

  if (!assistantProxyId) return;

  const convId = assistantDisplayedConvId;

  // 构建多模态消息内容
  let messagePayload = text;
  if (hasAttachments) {
    const content = [];
    if (text) content.push({ type: 'text', text });
    for (const att of assistantAttachments) {
      if (att.type === 'image_url') {
        content.push({ type: 'image_url', image_url: { url: `data:${att.mimeType};base64,${att.data}` } });
      } else if (att.type === 'input_audio') {
        const format = att.mimeType.replace(/^audio\//, '').replace(/;.*$/, '') || 'mp3';
        content.push({ type: 'input_audio', input_audio: { data: att.data, format } });
      } else if (att.type === 'video_url') {
        // URL 类型直接用，base64 类型构造 data URI
        const url = att.data.startsWith('http') ? att.data : `data:${att.mimeType};base64,${att.data}`;
        content.push({ type: 'video_url', video_url: { url }, fps: 2, media_resolution: 'default' });
      } else if (att.type === 'text') {
        content.push({ type: 'text', text: `📄 ${att.name}:\n${att.data}` });
      } else if (att.type === 'file') {
        // 文件附件：用 text block 告知模型，实际数据由后端保存到磁盘供 Code Interpreter 使用
        content.push({ type: 'text', text: `[附件: ${att.name}]` });
        content.push({ type: 'text', text: `__FILE_DATA__${att.name}|${att.mimeType}|${att.data}__END_FILE_DATA__` });
      }
    }
    messagePayload = content;
  }

  addAssistantMessage('user', messagePayload, null, convId);
  input.value = '';
  input.style.height = 'auto';
  clearAttachments();

  const proxy = proxies.find(p => p.id === assistantProxyId);
  if (!proxy) {
    addAssistantMessage('assistant', '所选代理不存在或已停止，请重新选择。', null, convId);
    return;
  }

  const thinkingId = addAssistantMessage('thinking', '', null, convId);
  const myController = new AbortController();
  assistantConvControllers.set(convId, myController);
  assistantStreamingConvs.add(convId);
  setSendBtnState(true);
  // 同步更新 badge（不依赖异步 fetch）
  updateSidebarBadges();
  // 新会话仍需等 conversation 事件后刷新侧边栏结构
  if (convId.startsWith('new-')) {
    setTimeout(loadConversations, 500);
  }

  try {
    const providerVal = assistantProviderId;
    const modelVal = assistantModel;
    const res = await fetch('/api/assistant/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        proxyId: proxy.id, conversationId: getCurrentConvId(), message: messagePayload,
        ...(providerVal && { providerId: providerVal }),
        ...(modelVal && { model: modelVal }),
        permissionLevel: parseInt(document.getElementById('assistant-permission-select')?.value || '3'),
        thinkingEffort: document.getElementById('assistant-thinking-select')?.value || '',
        mode: assistantChatMode,
        chatMode: assistantPureMode ? 'pure' : 'assistant',
        ...(assistantChatMode === 'sliding' && { windowSize: assistantWindowSize }),
      }),
      signal: myController.signal,
    });

    if (!res.ok) {
      const err = await res.text().catch(() => 'Unknown error');
      removeAssistantMessage(thinkingId);
      addAssistantMessage('assistant', `请求失败: HTTP ${res.status}\n\n${err}`, null, convId);
      attachRetryButtonToLast();
      return;
    }

    await processAssistantSSE(res, thinkingId, convId);

  } catch (err) {
    removeAssistantMessage(thinkingId);
    if (err.name === 'AbortError') {
      addAssistantMessage('assistant', '已取消', null, convId);
    } else {
      addAssistantMessage('assistant', `请求出错: ${err.message}`, null, convId);
    }
    attachRetryButtonToLast();
  } finally {
    // 清理 controller（convId 可能是临时 ID，controller 可能已迁移到真实 ID）
    if (assistantConvControllers.get(convId) === myController) assistantConvControllers.delete(convId);
    if (assistantDisplayedConvId !== convId && assistantConvControllers.get(assistantDisplayedConvId) === myController) assistantConvControllers.delete(assistantDisplayedConvId);
    assistantStreamingConvs.delete(convId);
    assistantStreamingConvs.delete(assistantDisplayedConvId);
    setSendBtnState(false);
    updateSidebarBadges(); // 同步移除 badge
  }
}

async function processAssistantSSE(response, thinkingId, convId) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let fullContent = '';
  let currentEvent = '';
  let msgId = null;
  let thinkingRemoved = false;
  const collectedMedia = [];

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop();

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      if (trimmed.startsWith('event: ')) {
        currentEvent = trimmed.slice(7);
        continue;
      }

      if (!trimmed.startsWith('data: ')) continue;
      let data;
      try { data = JSON.parse(trimmed.slice(6)); } catch { continue; }

      switch (currentEvent) {
        case 'content': {
          if (!thinkingRemoved) { removeAssistantMessage(thinkingId); thinkingRemoved = true; }
          if (!msgId) {
            msgId = addAssistantMessage('assistant', '', null, convId);
          }
          fullContent += data.delta;
          updateAssistantMessage(msgId, fullContent);
          break;
        }

        case 'tool_calls': {
          if (!thinkingRemoved) { removeAssistantMessage(thinkingId); thinkingRemoved = true; }
          const calls = data.calls || [];
          fullContent = '';
          const callHtml = calls.map(tc => {
            const argsStr = Object.keys(tc.arguments || {}).length > 0
              ? `<span class="tool-call-args">${escapeHtml(JSON.stringify(tc.arguments))}</span>`
              : '';
            return `<div class="tool-call-item"><span class="tool-call-name">${escapeHtml(tc.name)}</span>${argsStr}</div>`;
          }).join('');
          addAssistantMessage('tool-calls', callHtml, null, convId);
          break;
        }

        case 'tool_approval': {
          if (!thinkingRemoved) { removeAssistantMessage(thinkingId); thinkingRemoved = true; }
          // 后台会话：存入待审批队列，切换时再渲染
          if (convId !== assistantDisplayedConvId) {
            if (!assistantPendingApprovals.has(convId)) assistantPendingApprovals.set(convId, []);
            assistantPendingApprovals.get(convId).push({ data, resolve: null });
            // 通知侧边栏有新审批
            highlightConversationUpdate(convId);
            break;
          }
          const argsDisplay = data.arguments ? JSON.stringify(data.arguments, null, 2) : '{}';
          const ep = data.execPolicy;
          let actionsHtml;
          if (ep && ep.decision === 'prompt') {
            const policyInfo = ep.matchedRule
              ? `<div style="font-size:11px;color:var(--text-muted);margin-bottom:6px">匹配规则: <code>${escapeHtml(ep.matchedRule)}</code> · ${escapeHtml(ep.description || '')}</div>`
              : `<div style="font-size:11px;color:var(--text-muted);margin-bottom:6px">${escapeHtml(ep.description || '未知命令')}</div>`;
            actionsHtml = `${policyInfo}
              <button class="btn btn-approve" onclick="approveTool('${escapeHtml(data.id)}', true, this)">✅ 本次批准</button>
              <button class="btn btn-approve" style="background:var(--accent);color:#fff" onclick="approveTool('${escapeHtml(data.id)}', 'session', this)">🔒 本次会话批准</button>
              <button class="btn btn-deny" onclick="approveTool('${escapeHtml(data.id)}', false, this)">❌ 拒绝</button>
              <span class="approval-status"></span>`;
          } else {
            actionsHtml = `
              <button class="btn btn-approve" onclick="approveTool('${escapeHtml(data.id)}', true, this)">✅ 批准执行</button>
              <button class="btn btn-deny" onclick="approveTool('${escapeHtml(data.id)}', false, this)">❌ 拒绝</button>
              <span class="approval-status"></span>`;
          }
          const approvalHtml = `<div class="tool-approval-card" id="approval-${escapeHtml(data.id)}">
            <div class="tool-approval-header">${ep ? '🛡️ 命令需要确认' : '⚠️ 需要确认执行'}</div>
            <div class="tool-approval-name">${escapeHtml(data.name)}</div>
            <pre class="tool-approval-args">${escapeHtml(argsDisplay)}</pre>
            <div class="tool-approval-actions">${actionsHtml}</div>
          </div>`;
          addAssistantMessage('tool-approval', approvalHtml, null, convId);
          break;
        }

        case 'tool_result': {
          // _multimodal 信封：从 content 数组提取媒体
          if (data.result && data.result._multimodal && Array.isArray(data.result.content)) {
            const mmContent = data.result.content;
            const textParts = mmContent.filter(p => p.type === 'text').map(p => p.text).join('\n');
            addAssistantMessage('tool-result', { name: data.name, result: textParts || '已加载多模态内容', tool_call_id: data.tool_call_id, is_error: false, images: null, media: null }, null, convId);
            for (const part of mmContent) {
              if (part.type === 'image_url' && part.image_url?.url) {
                collectedMedia.push({ type: 'image', base64: part.image_url.url });
              } else if (part.type === 'input_audio' && part.input_audio?.data) {
                collectedMedia.push({ type: 'audio', base64: part.input_audio.data, format: part.input_audio.format });
              } else if (part.type === 'video_url' && part.video_url?.url) {
                collectedMedia.push({ type: 'video_url', url: part.video_url.url });
              }
            }
          } else {
            const resultStr = JSON.stringify(data.result, null, 2);
            addAssistantMessage('tool-result', { name: data.name, result: resultStr, tool_call_id: data.tool_call_id, is_error: data.is_error, images: data.images || null, media: data.media || null }, null, convId);
            // 收集媒体用于附加到助手回复中
            if (data.images && data.images.length > 0) {
              for (const img of data.images) {
                collectedMedia.push({ type: 'image', file: img._file || null, base64: img.base64_data || null });
              }
            }
            if (data.media) {
              if (data.media.audio_file) collectedMedia.push({ type: 'audio', file: data.media.audio_file });
              if (data.media.video_file) collectedMedia.push({ type: 'video', file: data.media.video_file });
              if (data.media.video_url) collectedMedia.push({ type: 'video_url', url: data.media.video_url });
            }
          }
          break;
        }

        case 'progress': {
          const thinkingEl = document.getElementById(thinkingId);
          if (thinkingEl && !thinkingRemoved) {
            const labels = { llm: '模型思考中', tool: `执行 ${data.name || '工具'}`, compressing: '压缩上下文' };
            const label = labels[data.stage] || '处理中';
            const elapsed = data.elapsed > 0 ? ` (${data.elapsed}s)` : '';
            thinkingEl.innerHTML = `<span class="progress-text">${label}${elapsed}</span>`;
          }
          break;
        }

        case 'done': {
          if (!thinkingRemoved) { removeAssistantMessage(thinkingId); thinkingRemoved = true; }
          if (msgId) {
            const msgObj = getConvMessages(convId).find(m => m.id === msgId);
            if (msgObj) {
              if (data.reasoning_content && !fullContent.includes('<think>')) {
                fullContent = `<think>${data.reasoning_content}</think>` + fullContent;
              }
              // 附加工具生成的媒体标记到消息内容中（持久化到对话历史）
              if (collectedMedia.length > 0) {
                const mediaMarkers = collectedMedia.map(m => {
                  if (m.type === 'image') return m.file ? `[MEDIA:image:${m.file}]` : '';
                  if (m.type === 'audio') return `[MEDIA:audio:${m.file}]`;
                  if (m.type === 'video') return `[MEDIA:video:${m.file}]`;
                  if (m.type === 'video_url') return `[MEDIA:video_url:${m.url}]`;
                  return '';
                }).filter(Boolean).join('\n');
                if (mediaMarkers) fullContent += '\n' + mediaMarkers;
              }
              msgObj.content = fullContent;
              updateAssistantMessage(msgId, fullContent);
              if (data.assistantMessageId) {
                msgObj.backendMsgId = data.assistantMessageId;
                attachDeleteButton(msgId, data.assistantMessageId);
              }
            }
          }
          break;
        }

        case 'error': {
          if (!thinkingRemoved) { removeAssistantMessage(thinkingId); thinkingRemoved = true; }
          addAssistantMessage('assistant', `错误: ${data.message}`, null, convId);
          break;
        }

        case 'context': {
          // 保存到 per-conversation context
          assistantConvContext.set(convId, {
            tokens: data.tokens,
            maxTokens: data.maxTokens || contextMaxTokens,
            percent: data.percent,
            messages: data.messages,
          });
          // 仅当会话可见时更新 UI
          if (convId === assistantDisplayedConvId) {
            contextTokens = data.tokens;
            contextMaxTokens = data.maxTokens || contextMaxTokens;
            contextPercent = data.percent;
            contextMessages = data.messages;
            updateContextBar();
          }
          if (data.mode) assistantChatMode = data.mode;
          if (data.windowSize) assistantWindowSize = data.windowSize;
          break;
        }

        case 'compressed': {
          if (data.summary) applyCompression(data);
          break;
        }

        case 'compressing': {
          break;
        }

        case 'delegate': {
          handleDelegateEvent(data);
          break;
        }

        case 'conversation': {
          // 新会话：将临时 ID 的数据迁移到服务端分配的真实 ID
          if (assistantDisplayedConvId !== data.id && assistantConvMessages.has(assistantDisplayedConvId)) {
            assistantConvMessages.set(data.id, assistantConvMessages.get(assistantDisplayedConvId));
            assistantConvMessages.delete(assistantDisplayedConvId);
            if (assistantConvContext.has(assistantDisplayedConvId)) {
              assistantConvContext.set(data.id, assistantConvContext.get(assistantDisplayedConvId));
              assistantConvContext.delete(assistantDisplayedConvId);
            }
            if (assistantConvControllers.has(assistantDisplayedConvId)) {
              assistantConvControllers.set(data.id, assistantConvControllers.get(assistantDisplayedConvId));
              assistantConvControllers.delete(assistantDisplayedConvId);
            }
            if (assistantStreamingConvs.has(assistantDisplayedConvId)) {
              assistantStreamingConvs.delete(assistantDisplayedConvId);
              assistantStreamingConvs.add(data.id);
            }
            assistantDisplayedConvId = data.id;
          }
          // 更新用户选中的会话 ID（仅当前会话或新会话的 temp→real 迁移时）
          if (data.id === assistantDisplayedConvId || data.id === assistantConversationId
            || (assistantConversationId && assistantConversationId.startsWith('new-'))) {
            setCurrentConvId(data.id);
            saveAssistantSelection();
          }
          // 刷新侧边栏结构（新会话需要出现在列表中）
          loadConversations();
          if (data.userMessageId) {
            const lastUserMsg = [...getConvMessages(data.id)].reverse().find(m => m.role === 'user');
            if (lastUserMsg) {
              lastUserMsg.backendMsgId = data.userMessageId;
              attachDeleteButton(lastUserMsg.id, data.userMessageId);
            }
          }
          break;
        }
      }
    }
  }

  if (!thinkingRemoved && assistantConvMessages.has(convId)) removeAssistantMessage(thinkingId);
  // 会话可能在流式输出期间被删除，跳过后续操作
  if (!assistantConvMessages.has(convId)) return;
  if (msgId && fullContent) {
    const msgObj = getConvMessages(convId).find(m => m.id === msgId);
    if (msgObj && !msgObj.content) msgObj.content = fullContent;
  }
  // 后台会话任务完成：标记完成状态
  if (convId !== assistantDisplayedConvId) {
    assistantConvCompleted.add(convId);
    updateSidebarBadges(); // 同步更新
  }
  attachRetryButtonToLast();
}

function addAssistantMessage(role, content, backendMsgId = null, convId, renderOnly) {
  const targetConv = convId || assistantDisplayedConvId;
  if (!targetConv) return null;

  const id = 'msg-' + Date.now() + '-' + Math.random().toString(36).slice(2);
  const msgs = renderOnly ? null : getConvMessages(targetConv);
  if (msgs) msgs.push({ id, role, content, backendMsgId });

  // 后台会话：仅存储数据，不操作 DOM
  if (targetConv !== assistantDisplayedConvId) return id;

  const chat = document.getElementById('assistant-chat');
  if (!chat) return id;

  // 首条用户消息时清空 chat（仅非 renderOnly 模式）
  if (msgs) {
    const displayRoles = ['user', 'assistant', 'tool', 'tool-calls', 'tool-result', 'tool-approval'];
    if (msgs.filter(m => displayRoles.includes(m.role)).length === 1 && role === 'user') {
      chat.innerHTML = '';
    }
  }

  const div = document.createElement('div');
  div.id = id;
  div.className = `assistant-message ${role}`;

  if (role === 'thinking') {
    div.innerHTML = `<div class="assistant-dot"></div><div class="assistant-dot"></div><div class="assistant-dot"></div>`;
  } else if (role === 'tool-calls') {
    // content 已经是 HTML 字符串
    div.innerHTML = `<div class="tool-calls-header">调用工具</div>${content}`;
  } else if (role === 'tool-result') {
    // content 是 {name, result, tool_call_id, is_error, images}
    const toolData = typeof content === 'object' ? content : { name: 'unknown', result: content };
    const resultId = 'result-' + id;
    if (toolData.is_error) div.classList.add('tool-error');
    let imagesHtml = '';
    if (toolData.images && toolData.images.length > 0) {
      imagesHtml = '<div class="tool-result-images">' +
        toolData.images.map(img => `<img class="msg-media" src="data:image/png;base64,${escapeHtml(img.base64_data)}" alt="${escapeHtml(img.name)}">`).join('') +
        '</div>';
    }
    let mediaHtml = '';
    if (toolData.media) {
      const m = toolData.media;
      if (m.audio_file && targetConv) {
        mediaHtml += `<div class="tool-result-media"><audio controls src="/api/conv-files/${targetConv}/${encodeURIComponent(m.audio_file)}"></audio><span class="tool-media-name">${escapeHtml(m.audio_file)}</span></div>`;
      }
      if (m.video_file && targetConv) {
        mediaHtml += `<div class="tool-result-media"><video controls class="msg-media" src="/api/conv-files/${targetConv}/${encodeURIComponent(m.video_file)}"></video><span class="tool-media-name">${escapeHtml(m.video_file)}</span></div>`;
      }
      if (m.video_url) {
        mediaHtml += `<div class="tool-result-media"><video controls class="msg-media" src="${escapeHtml(m.video_url)}"></video></div>`;
      }
    }
    div.innerHTML = `
      <div class="tool-result-header" onclick="document.getElementById('${resultId}').classList.toggle('expanded')">
        <span class="tool-result-name">${toolData.is_error ? '⚠ ' : ''}${escapeHtml(toolData.name)}</span>
        <span class="tool-result-toggle">${toolData.is_error ? '错误详情 ▾' : '展开结果 ▾'}</span>
      </div>
      ${imagesHtml}
      ${mediaHtml}
      <div class="tool-result-body" id="${resultId}">
        <pre>${escapeHtml(toolData.result)}</pre>
      </div>`;
    // 保存 tool_call_id 到消息对象
    const msgObj = msgs && msgs.find(m => m.id === id);
    if (msgObj) {
      msgObj.tool_call_id = toolData.tool_call_id;
      msgObj.tool_name = toolData.name;
      msgObj.content = toolData.result;
    }
  } else if (role === 'assistant') {
    div.innerHTML = formatAssistantContent(content);
  } else if (role === 'tool-approval') {
    // content 已经是 HTML 字符串
    div.innerHTML = content;
  } else if (role === 'delegate-card') {
    // content = { createdId, tasks: [{id, objective}] }
    div.innerHTML = renderDelegateCard(content);
  } else if (role === 'user' && Array.isArray(content)) {
    // 多模态用户消息
    let html = '';
    for (const part of content) {
      if (part.type === 'text' && part.text?.startsWith('__FILE_DATA__')) continue;
      if (part.type === 'text' && part.text) {
        html += `<div>${escapeHtml(part.text)}</div>`;
      } else if (part.type === 'image_url' && part.image_url?.url) {
        html += `<img class="msg-media" src="${escapeHtml(part.image_url.url)}" alt="图片">`;
      } else if (part.type === 'input_audio' && part.input_audio?.data) {
        const format = part.input_audio.format || 'mp3';
        html += `<audio controls src="data:audio/${escapeHtml(format)};base64,${escapeHtml(part.input_audio.data)}"></audio>`;
      } else if (part.type === 'video_url' && part.video_url?.url) {
        const src = escapeHtml(part.video_url.url);
        html += `<video class="msg-video" controls src="${src}"></video>`;
      } else if (part.type === 'file' && part.file?.name) {
        const sizeKB = Math.round((part.file.data?.length || 0) * 3 / 4 / 1024);
        html += `<div style="padding:4px 0;font-size:13px;opacity:0.8">📎 ${escapeHtml(part.file.name)} (${sizeKB}KB)</div>`;
      }
    }
    div.innerHTML = html;
  } else {
    div.textContent = content;
  }

  // 为 user / assistant 消息添加删除按钮
  if ((role === 'user' || role === 'assistant') && backendMsgId) {
    const delBtn = document.createElement('button');
    delBtn.className = 'msg-delete-btn';
    delBtn.title = '删除该问答对';
    delBtn.innerHTML = '&times;';
    delBtn.onclick = () => deleteMessagePair(backendMsgId);
    div.appendChild(delBtn);
  }

  chat.appendChild(div);
  chat.scrollTop = chat.scrollHeight;
  return id;
}

function updateAssistantMessage(id, content) {
  const div = document.getElementById(id);
  if (div) {
    div.innerHTML = formatAssistantContent(content);
    const chat = document.getElementById('assistant-chat');
    if (chat) chat.scrollTop = chat.scrollHeight;
  }
  const msgObj = getCurrentConvMessages().find(m => m.id === id);
  if (msgObj) msgObj.content = content;
}

function removeAssistantMessage(id) {
  const div = document.getElementById(id);
  if (div) div.remove();
  const msgs = getCurrentConvMessages();
  const idx = msgs.findIndex(m => m.id === id);
  if (idx !== -1) msgs.splice(idx, 1);
}

function attachDeleteButton(msgId, backendMsgId) {
  const div = document.getElementById(msgId);
  if (!div || !backendMsgId) return;
  if (div.querySelector('.msg-delete-btn')) return;
  const delBtn = document.createElement('button');
  delBtn.className = 'msg-delete-btn';
  delBtn.title = '删除该问答对';
  delBtn.innerHTML = '&times;';
  delBtn.onclick = () => deleteMessagePair(backendMsgId);
  div.appendChild(delBtn);
}

async function deleteMessagePair(backendMsgId) {
  if (!backendMsgId) {
    showToast('消息尚未就绪，请稍后再试', true);
    return;
  }
  if (!assistantConversationId) {
    showToast('会话尚未就绪，请稍后再试', true);
    return;
  }
  const ok = await showConfirm('确定删除该问答对吗？');
  if (!ok) return;

  const msgs = getCurrentConvMessages();
  const clickIdx = msgs.findIndex(m => m.backendMsgId === backendMsgId);
  if (clickIdx === -1) {
    showToast('消息未找到', true);
    return;
  }

  let startIdx = clickIdx;
  while (startIdx > 0 && msgs[startIdx].role !== 'user') startIdx--;
  if (msgs[startIdx].role !== 'user') startIdx = clickIdx;

  let endIdx = startIdx;
  while (endIdx + 1 < msgs.length && msgs[endIdx + 1].role !== 'user') endIdx++;

  // 保存被删除的消息快照，用于失败回滚
  const removedMessages = msgs.slice(startIdx, endIdx + 1);
  const removedDivs = [];
  for (let i = startIdx; i <= endIdx; i++) {
    const div = document.getElementById(msgs[i].id);
    if (div) {
      removedDivs.push({ el: div, ref: div.nextSibling, parent: div.parentNode });
      div.remove();
    }
  }

  msgs.splice(startIdx, endIdx - startIdx + 1);

  try {
    const res = await fetch(`/api/assistant/conversations/${assistantConversationId}/messages/${backendMsgId}`, { method: 'DELETE' });
    if (!res.ok) {
      throw new Error((await res.json().catch(() => ({}))).error || '删除失败');
    }
    loadConversations();
    attachRetryButtonToLast();
  } catch (err) {
    // 回滚：恢复本地消息和 DOM
    msgs.splice(startIdx, 0, ...removedMessages);
    for (const { el, ref, parent } of removedDivs) {
      if (parent) parent.insertBefore(el, ref);
    }
    attachRetryButtonToLast();
    showToast('删除失败: ' + err.message, true);
  }
}

function attachRetryButtonToLast() {
  document.querySelectorAll('.msg-retry-btn').forEach(b => b.remove());
  const msgs = getCurrentConvMessages();
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m.role === 'user') {
      const div = document.getElementById(m.id);
      if (div) {
        const btn = document.createElement('button');
        btn.className = 'msg-retry-btn';
        btn.title = '重试';
        btn.innerHTML = '&#x21bb;';
        btn.onclick = retryLastMessage;
        div.appendChild(btn);
      }
      return;
    }
  }
}

async function retryLastMessage() {
  const convId = assistantDisplayedConvId;
  if (assistantConvControllers.has(convId)) return;

  const msgs = getCurrentConvMessages();
  let lastUserIdx = -1;
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].role === 'user') { lastUserIdx = i; break; }
  }
  if (lastUserIdx === -1) return;

  const userContent = msgs[lastUserIdx].content;

  // 移除 user 消息之后的所有消息（DOM + 数组）
  const toRemove = msgs.slice(lastUserIdx + 1);
  for (const m of toRemove) {
    const div = document.getElementById(m.id);
    if (div) div.remove();
  }
  msgs.splice(lastUserIdx + 1);

  // 清理服务端历史
  const lastWithBackend = [...toRemove].reverse().find(m => m.backendMsgId);
  if (assistantConversationId) {
    const deleteId = lastWithBackend?.backendMsgId || msgs[lastUserIdx]?.backendMsgId;
    if (deleteId) {
      try {
        await fetch(`/api/assistant/conversations/${assistantConversationId}/messages/${deleteId}`, { method: 'DELETE' });
      } catch {}
    }
  }

  document.querySelectorAll('.msg-retry-btn').forEach(b => b.remove());

  // 重新发送请求
  const proxy = proxies.find(p => p.id === assistantProxyId);
  if (!proxy) return;

  const thinkingId = addAssistantMessage('thinking', '', null, convId);
  const myController = new AbortController();
  assistantConvControllers.set(convId, myController);
  assistantStreamingConvs.add(convId);
  setSendBtnState(true);
  updateSidebarBadges(); // 同步更新 badge

  try {
    const providerVal = assistantProviderId;
    const modelVal = assistantModel;
    const res = await fetch('/api/assistant/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        proxyId: proxy.id, conversationId: getCurrentConvId(), message: userContent,
        ...(providerVal && { providerId: providerVal }),
        ...(modelVal && { model: modelVal }),
        permissionLevel: parseInt(document.getElementById('assistant-permission-select')?.value || '3'),
        thinkingEffort: document.getElementById('assistant-thinking-select')?.value || '',
        mode: assistantChatMode,
        chatMode: assistantPureMode ? 'pure' : 'assistant',
        ...(assistantChatMode === 'sliding' && { windowSize: assistantWindowSize }),
      }),
      signal: myController.signal,
    });

    if (!res.ok) {
      const err = await res.text().catch(() => 'Unknown error');
      removeAssistantMessage(thinkingId);
      addAssistantMessage('assistant', `请求失败: HTTP ${res.status}\n\n${err}`, null, convId);
      attachRetryButtonToLast();
      return;
    }

    await processAssistantSSE(res, thinkingId, convId);
  } catch (err) {
    removeAssistantMessage(thinkingId);
    if (err.name === 'AbortError') {
      addAssistantMessage('assistant', '已取消', null, convId);
    } else {
      addAssistantMessage('assistant', `请求出错: ${err.message}`, null, convId);
    }
    attachRetryButtonToLast();
  } finally {
    if (assistantConvControllers.get(convId) === myController) assistantConvControllers.delete(convId);
    if (assistantDisplayedConvId !== convId && assistantConvControllers.get(assistantDisplayedConvId) === myController) assistantConvControllers.delete(assistantDisplayedConvId);
    assistantStreamingConvs.delete(convId);
    assistantStreamingConvs.delete(assistantDisplayedConvId);
    setSendBtnState(false);
    updateSidebarBadges(); // 同步移除 badge
  }
}

// 配置 marked.js（GFM 支持表格/任务列表，breaks 匹配单换行转 <br）
if (typeof marked !== 'undefined') {
  marked.setOptions({ breaks: true, gfm: true });
}

function formatAssistantContent(text) {
  if (!text) return '';
  const MEDIA_PH = '█MEDIA_'; // 用全角字符避免被清理
  const THINK_PH = '█THINK_';
  const SUFFIX = '█';
  // 提取媒体标记
  const mediaBlocks = [];
  let processed = text.replace(/\[MEDIA:(image|audio|video|video_url):([^\]]+)\]/g, (_, type, data) => {
    const idx = mediaBlocks.length;
    mediaBlocks.push({ type, data });
    return MEDIA_PH + idx + SUFFIX;
  });
  // 提取 <think> 块
  const thinkBlocks = [];
  processed = processed.replace(/<think>([\s\S]*?)<\/think>/g, (_, think) => {
    const idx = thinkBlocks.length;
    thinkBlocks.push(think.trim());
    return THINK_PH + idx + SUFFIX;
  });
  // marked.js 渲染 Markdown
  let html = typeof marked !== 'undefined'
    ? marked.parse(processed)
    : escapeHtml(processed).replace(/\n{2,}/g, '</p><p>').replace(/\n/g, '<br>');
  // DOMPurify 消毒（在还原之前，确保安全）
  if (typeof DOMPurify !== 'undefined') {
    html = DOMPurify.sanitize(html, { ADD_TAGS: ['details', 'summary'] });
  }
  // 还原思考块
  html = html.replace(new RegExp(THINK_PH.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(\\d+)' + SUFFIX.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), (_, idx) => {
    const thinkId = 'think-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6);
    return `<details class="think-block"><summary>思考过程</summary><div class="think-content" id="${thinkId}">${escapeHtml(thinkBlocks[parseInt(idx)])}</div></details>`;
  });
  // 还原媒体块
  const convId = assistantConversationId;
  html = html.replace(new RegExp(MEDIA_PH.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(\\d+)' + SUFFIX.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), (_, idx) => {
    const m = mediaBlocks[parseInt(idx)];
    if (!m) return '';
    if (m.type === 'image' && convId) return `<img class="msg-media" src="/api/conv-files/${convId}/${encodeURIComponent(m.data)}" alt="generated image">`;
    if (m.type === 'audio' && convId) return `<div class="tool-result-media"><audio controls src="/api/conv-files/${convId}/${encodeURIComponent(m.data)}"></audio></div>`;
    if (m.type === 'video' && convId) return `<div class="tool-result-media"><video controls class="msg-media" src="/api/conv-files/${convId}/${encodeURIComponent(m.data)}"></video></div>`;
    if (m.type === 'video_url') return `<div class="tool-result-media"><video controls class="msg-media" src="${escapeHtml(m.data)}"></video></div>`;
    return '';
  });
  return html;
}

// ==================== 多 Agent 委派卡片 ====================

function renderDelegateCard({ createdId, tasks }) {
  const taskItems = tasks.map(t =>
    `<div class="delegate-task" data-task-id="${escapeHtml(t.id)}">
      <span class="delegate-task-dot status-created"></span>
      <span class="delegate-task-objective">${escapeHtml(t.objective)}</span>
      <span class="delegate-task-summary"></span>
    </div>`
  ).join('');
  return `<div class="delegate-header">委派 ${tasks.length} 个子任务</div>
    <div class="delegate-task-list">${taskItems}</div>`;
}

function updateDelegateTask(taskId, status, text) {
  const el = document.querySelector(`.delegate-task[data-task-id="${taskId}"]`);
  if (!el) return;
  const dot = el.querySelector('.delegate-task-dot');
  if (dot) {
    dot.className = 'delegate-task-dot status-' + status;
  }
  if (text) {
    const summary = el.querySelector('.delegate-task-summary');
    if (summary) {
      summary.textContent = status === 'failed' ? '失败: ' + text : text;
      summary.className = 'delegate-task-summary visible ' + (status === 'failed' ? 'error' : 'success');
    }
  }
  // 完成/失败/停止时隐藏进度
  if (['completed', 'failed', 'stopped'].includes(status)) {
    const progress = el.querySelector('.delegate-task-progress');
    if (progress) progress.style.display = 'none';
  }
}

function updateDelegateProgress(taskId, progress) {
  const el = document.querySelector(`.delegate-task[data-task-id="${taskId}"]`);
  if (!el || !progress) return;
  let progressEl = el.querySelector('.delegate-task-progress');
  if (!progressEl) {
    progressEl = document.createElement('div');
    progressEl.className = 'delegate-task-progress';
    el.appendChild(progressEl);
  }
  progressEl.textContent = `轮次 ${progress.round} · ${progress.lastTool}`;
  progressEl.style.display = '';
}

function handleDelegateEvent(data) {
  if (data.type === 'created') {
    const createdId = 'delegate-' + Date.now();
    const msgId = addAssistantMessage('delegate-card', { createdId, tasks: data.tasks });
    const taskMap = new Map();
    for (const t of data.tasks) taskMap.set(t.id, { objective: t.objective, status: 'created' });
    delegateCards.set(createdId, { msgId, tasks: taskMap });
  } else if (data.type === 'started') {
    updateDelegateTask(data.taskId, 'running');
  } else if (data.type === 'completed') {
    updateDelegateTask(data.taskId, 'completed', data.summary);
  } else if (data.type === 'failed') {
    updateDelegateTask(data.taskId, 'failed', data.error);
  }
}

async function approveTool(id, approved, btn) {
  btn.disabled = true;
  const card = btn.closest('.tool-approval-actions');
  if (card) card.querySelectorAll('button').forEach(b => b.disabled = true);
  try {
    const res = await fetch('/api/assistant/approve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, approved })
    });
    const statusEl = card?.querySelector('.approval-status');
    if (res.ok) {
      const labels = { true: '✅ 已批准', session: '🔒 会话已批准', false: '❌ 已拒绝' };
      if (statusEl) statusEl.textContent = labels[String(approved)] || '✅ 已批准';
      // 清除该会话的 pending approval 记录，刷新侧边栏高亮
      for (const [convId, list] of assistantPendingApprovals) {
        const idx = list.findIndex(p => p.data.id === id);
        if (idx !== -1) {
          list.splice(idx, 1);
          if (list.length === 0) assistantPendingApprovals.delete(convId);
          loadConversations();
          break;
        }
      }
    } else {
      const err = await res.json().catch(() => ({}));
      if (statusEl) statusEl.textContent = `⚠️ ${err.error || '操作失败'}`;
      btn.disabled = false;
      if (card) card.querySelectorAll('button').forEach(b => b.disabled = false);
    }
  } catch (e) {
    btn.disabled = false;
    if (card) card.querySelectorAll('button').forEach(b => b.disabled = false);
    const statusEl = card?.querySelector('.approval-status');
    if (statusEl) statusEl.textContent = '⚠️ 网络错误';
  }
}

function clearAssistantChat() {
  // 清理当前显示会话的数据
  if (assistantDisplayedConvId) {
    assistantConvMessages.delete(assistantDisplayedConvId);
    assistantConvContext.delete(assistantDisplayedConvId);
    assistantPendingApprovals.delete(assistantDisplayedConvId);
    assistantConvCompleted.delete(assistantDisplayedConvId);
  }
  assistantDisplayedConvId = '';
  setCurrentConvId('');
  saveAssistantSelection();
  highlightActiveConversation();
  const savedModel = assistantModel;
  buildModelTree();
  if (savedModel) {
    assistantModel = savedModel;
    buildModelTree();
  }
  contextTokens = 0;
  contextPercent = 0;
  contextMessages = 0;
  updateContextBar();
  const chat = document.getElementById('assistant-chat');
  if (!chat) return;
  // 重建带 ID 的 welcome 元素，供 updateWelcomeMessage 后续更新
  chat.innerHTML = `
    <div class="assistant-welcome">
      <div class="assistant-welcome-icon">
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path></svg>
      </div>
      <h3 id="assistant-welcome-title">智控助手</h3>
      <p id="assistant-welcome-desc">我是你的 Protocol Proxy 智能助手，可以帮你：</p>
      <ul id="assistant-welcome-features">
        <li>查询代理和供应商运行状态</li>
        <li>分析日志，定位异常原因</li>
        <li>解读配置并给出优化建议</li>
        <li>自然语言排障与问答</li>
      </ul>
      <p class="assistant-hint" id="assistant-welcome-hint">请先选择一个运行中的代理作为对话后端</p>
    </div>
  `;
  updateWelcomeMessage();
}

function formatTokenCount(n) {
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
  return String(n);
}

function updateContextBar() {
  const bar = document.getElementById('assistant-context-bar');
  if (!bar) return;
  if (contextMessages === 0) {
    bar.style.display = 'none';
    return;
  }
  bar.style.display = 'flex';

  document.getElementById('context-bar-tokens').textContent = formatTokenCount(contextTokens);
  document.getElementById('context-bar-max').textContent = formatTokenCount(contextMaxTokens);
  document.getElementById('context-bar-percent').textContent = contextPercent.toFixed(1);
  document.getElementById('context-bar-messages').textContent = contextMessages;

  const fill = document.getElementById('context-bar-fill');
  const pct = Math.min(100, contextPercent);
  fill.style.width = pct + '%';
  fill.className = 'context-bar-fill' + (pct >= 80 ? ' high' : pct >= 50 ? ' mid' : '');

  const compressBtn = document.getElementById('context-compress-btn');
  if (compressBtn) {
    compressBtn.style.display = pct >= 50 ? '' : 'none';
  }
}

function showSaveToast() {
  let toast = document.getElementById('settings-save-toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'settings-save-toast';
    toast.style.cssText = 'position:fixed;bottom:24px;right:24px;background:var(--success);color:#fff;padding:8px 16px;border-radius:var(--radius-md);font-size:13px;font-weight:500;z-index:9999;opacity:0;transition:opacity 0.2s;pointer-events:none';
    document.body.appendChild(toast);
  }
  toast.textContent = '已保存';
  toast.style.opacity = '1';
  clearTimeout(showSaveToast._timer);
  showSaveToast._timer = setTimeout(() => { toast.style.opacity = '0'; }, 1500);
}

function updateMaxContext(value) {
  const v = Math.max(10000, parseInt(value) || 200000);
  contextMaxTokens = v;
  fetch('/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ maxContext: v }) }).then(showSaveToast).catch(() => {});
  if (contextTokens > 0) {
    contextPercent = Math.round(contextTokens / contextMaxTokens * 1000) / 10;
    updateContextBar();
  }
}

function updateMaxRounds(value) {
  const v = Math.max(1, Math.min(100, parseInt(value) || 10));
  assistantMaxRounds = v;
  fetch('/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ maxRounds: v }) }).then(showSaveToast).catch(() => {});
}

function updateMaxConversations(value) {
  const v = Math.max(0, parseInt(value) || 0);
  fetch('/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ maxConversations: v }) }).then(showSaveToast).catch(() => {});
}

function updateAgentSetting(key, value) {
  fetch('/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ [key]: value }) }).then(showSaveToast).catch(() => {});
}

function updateMemorySetting(key, value) {
  fetch('/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ [key]: value }) }).then(showSaveToast).catch(() => {});
}

async function loadAgentToolsConfig(settings) {
  const loadingEl = document.getElementById('agent-tools-loading');
  const listEl = document.getElementById('agent-tools-list');
  const itemsEl = document.getElementById('agent-tools-items');
  if (!itemsEl) return;
  try {
    const res = await fetch('/api/assistant/tools');
    const tools = await res.json();
    const blockedSet = new Set(parseToolList(settings['agent.blockedTools'] || 'delegate_task'));
    const denySet = new Set(parseToolList(settings['agent.autoDenyTools'] || 'execute_command,write_file,edit_file'));
    renderAgentToolsList(tools, blockedSet, denySet);
    if (loadingEl) loadingEl.style.display = 'none';
    if (listEl) listEl.style.display = '';
  } catch {
    if (loadingEl) loadingEl.textContent = '加载失败';
  }
}

function parseToolList(val) {
  if (Array.isArray(val)) return val;
  return String(val).split(',').map(s => s.trim()).filter(Boolean);
}

function renderAgentToolsList(tools, blockedSet, denySet) {
  const itemsEl = document.getElementById('agent-tools-items');
  if (!itemsEl) return;
  itemsEl.innerHTML = tools.map(t => {
    const isBlocked = blockedSet.has(t.name);
    const isDeny = denySet.has(t.name);
    const permLabel = t.permission >= 3 ? ' <span style="color:var(--error);font-size:10px">危险</span>' : '';
    return `<div style="display:grid;grid-template-columns:1fr 56px 56px;padding:5px 12px;align-items:center;border-bottom:1px solid var(--border-subtle);font-size:12px">
      <div style="min-width:0">
        <div style="font-family:var(--font-mono);color:var(--text-primary);font-size:12px">${escapeHtml(t.name)}${permLabel}</div>
        <div style="color:var(--text-muted);font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${escapeHtml(t.description)}">${escapeHtml(t.description)}</div>
      </div>
      <div style="text-align:center"><input type="checkbox" data-tool="${escapeHtml(t.name)}" data-type="blocked" ${isBlocked ? 'checked' : ''} onchange="onAgentToolCheck(this)"></div>
      <div style="text-align:center"><input type="checkbox" data-tool="${escapeHtml(t.name)}" data-type="deny" ${isDeny ? 'checked' : ''} ${isBlocked ? 'disabled' : ''} onchange="onAgentToolCheck(this)"></div>
    </div>`;
  }).join('');
}

function onAgentToolCheck(checkbox) {
  const container = document.getElementById('agent-tools-items');
  if (!container) return;
  const blocked = [], deny = [];
  container.querySelectorAll('input[data-type="blocked"]').forEach(cb => {
    if (cb.checked) blocked.push(cb.dataset.tool);
  });
  container.querySelectorAll('input[data-type="deny"]').forEach(cb => {
    if (cb.checked && !cb.disabled) deny.push(cb.dataset.tool);
  });
  // 被阻止的工具自动禁用拒绝复选框
  container.querySelectorAll('input[data-type="blocked"]').forEach(cb => {
    const denyCb = container.querySelector(`input[data-type="deny"][data-tool="${cb.dataset.tool}"]`);
    if (denyCb) {
      denyCb.disabled = cb.checked;
      if (cb.checked) denyCb.checked = false;
    }
  });
  fetch('/api/settings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ 'agent.blockedTools': blocked.join(','), 'agent.autoDenyTools': deny.join(',') }),
  }).then(showSaveToast).catch(() => {});
}

function toggleAssistantSidebar() {
  const sidebar = document.getElementById('assistant-sidebar');
  const toggleBtn = document.getElementById('sidebar-toggle-btn');
  if (!sidebar) return;
  sidebar.classList.toggle('collapsed');
  const collapsed = sidebar.classList.contains('collapsed');
  if (toggleBtn) toggleBtn.style.display = collapsed ? '' : 'none';
  localStorage.setItem('assistant-sidebar-collapsed', collapsed ? '1' : '');
}

function highlightActiveConversation() {
  document.querySelectorAll('.sidebar-conv-item').forEach(el => {
    el.classList.toggle('active', el.dataset.id === assistantConversationId || el.dataset.id === assistantDisplayedConvId);
  });
}

function highlightConversationUpdate(convId) {
  if (convId === assistantDisplayedConvId) return;
  const item = document.querySelector(`.sidebar-conv-item[data-id="${convId}"]`);
  if (item) item.classList.add('has-update');
}

// 后台会话的 tool_approval 自动批准（通过 SSE 发回 approve 消息）
// 当用户切换到有 pending approval 的会话时渲染审批 UI
function renderPendingApprovals(convId) {
  const pending = assistantPendingApprovals.get(convId);
  if (!pending || !pending.length) return;
  assistantPendingApprovals.delete(convId);
  for (const { data } of pending) {
    // 复用 processAssistantSSE 中的 tool_approval 渲染逻辑
    const argsDisplay = data.arguments ? JSON.stringify(data.arguments, null, 2) : '{}';
    const ep = data.execPolicy;
    let actionsHtml;
    if (ep && ep.decision === 'prompt') {
      const policyInfo = ep.matchedRule
        ? `<div style="font-size:11px;color:var(--text-muted);margin-bottom:6px">匹配规则: <code>${escapeHtml(ep.matchedRule)}</code> · ${escapeHtml(ep.description || '')}</div>`
        : `<div style="font-size:11px;color:var(--text-muted);margin-bottom:6px">${escapeHtml(ep.description || '未知命令')}</div>`;
      actionsHtml = `${policyInfo}
        <button class="btn btn-approve" onclick="approveTool('${escapeHtml(data.id)}', true, this)">✅ 本次批准</button>
        <button class="btn btn-approve" style="background:var(--accent);color:#fff" onclick="approveTool('${escapeHtml(data.id)}', 'session', this)">🔒 本次会话批准</button>
        <button class="btn btn-deny" onclick="approveTool('${escapeHtml(data.id)}', false, this)">❌ 拒绝</button>
        <span class="approval-status"></span>`;
    } else {
      actionsHtml = `
        <button class="btn btn-approve" onclick="approveTool('${escapeHtml(data.id)}', true, this)">✅ 批准执行</button>
        <button class="btn btn-deny" onclick="approveTool('${escapeHtml(data.id)}', false, this)">❌ 拒绝</button>
        <span class="approval-status"></span>`;
    }
    const approvalHtml = `<div class="tool-approval-card" id="approval-${escapeHtml(data.id)}">
      <div class="tool-approval-header">${ep ? '🛡️ 命令需要确认' : '⚠️ 需要确认执行'}</div>
      <div class="tool-approval-name">${escapeHtml(data.name)}</div>
      <pre class="tool-approval-args">${escapeHtml(argsDisplay)}</pre>
      <div class="tool-approval-actions">${actionsHtml}</div>
    </div>`;
    addAssistantMessage('tool-approval', approvalHtml, null, convId);
  }
}

async function deleteConversationById(convId, event) {
  event.stopPropagation();
  const ok = await showConfirm('确定删除该会话？');
  if (!ok) return;
  try {
    await fetch(`/api/assistant/conversations/${convId}`, { method: 'DELETE' });
    // 停止该会话的流式输出
    const ac = assistantConvControllers.get(convId);
    if (ac) { ac.abort(); assistantConvControllers.delete(convId); }
    assistantStreamingConvs.delete(convId);
    // 清理 per-conversation 数据
    assistantConvMessages.delete(convId);
    assistantConvContext.delete(convId);
    assistantPendingApprovals.delete(convId);
    assistantConvCompleted.delete(convId);
    if (assistantConversationId === convId) clearAssistantChat();
    await loadConversations();
    showToast('会话已删除');
  } catch (err) {
    showToast('删除失败: ' + err.message, true);
  }
}

async function clearAllConversations() {
  const modeLabel = assistantPureMode ? '纯净模式' : '助手模式';
  const ok = await showConfirm(`确定清空${modeLabel}的所有历史会话？此操作不可恢复。`);
  if (!ok) return;
  try {
    const filterMode = assistantPureMode ? 'pure' : 'assistant';
    const res = await fetch(`/api/assistant/conversations?chatMode=${filterMode}`, { method: 'DELETE' });
    const data = await res.json();
    // 停止所有流式输出
    for (const [, ac] of assistantConvControllers) ac.abort();
    assistantConvControllers.clear();
    assistantStreamingConvs.clear();
    // 清理所有 per-conversation 数据
    assistantConvMessages.clear();
    assistantConvContext.clear();
    assistantPendingApprovals.clear();
    assistantConvCompleted.clear();
    clearAssistantChat();
    await loadConversations();
    showToast(`已清空 ${data.count || 0} 个会话`);
  } catch (err) {
    showToast('清空失败: ' + err.message, true);
  }
}

/**
 * 同步更新侧边栏 badge（流式输出/完成），不 fetch 服务端，不受 generation counter 影响
 */
function updateSidebarBadges() {
  document.querySelectorAll('.sidebar-conv-item').forEach(el => {
    const id = el.dataset.id;
    // 流式输出 badge
    const existing = el.querySelector('.streaming-badge');
    if (assistantStreamingConvs.has(id)) {
      if (!existing) {
        const badge = document.createElement('span');
        badge.className = 'streaming-badge';
        badge.title = '正在流式输出';
        badge.textContent = '●';
        el.insertBefore(badge, el.firstChild);
      }
    } else if (existing) {
      existing.remove();
    }
    // 完成 badge
    const existingComplete = el.querySelector('.completed-badge');
    const hasPending = assistantPendingApprovals.has(id);
    if (assistantConvCompleted.has(id) && !hasPending) {
      if (!existingComplete) {
        const badge = document.createElement('span');
        badge.className = 'completed-badge';
        badge.title = '任务已完成';
        badge.textContent = '✓';
        el.insertBefore(badge, el.firstChild);
      }
    } else if (existingComplete) {
      existingComplete.remove();
    }
  });
}

async function loadConversations() {
  const gen = ++loadConvoGeneration;
  try {
    const filterMode = assistantPureMode ? 'pure' : 'assistant';
    const res = await fetch(`/api/assistant/conversations?chatMode=${filterMode}`);
    if (gen !== loadConvoGeneration) return; // 有更新的调用，丢弃过期结果
    const data = await res.json();
    const list = document.getElementById('conversation-list');
    if (!list) return;
    const sorted = (data.conversations || []).slice().reverse();
    list.innerHTML = '';
    const activeId = assistantConversationId || assistantDisplayedConvId;
    for (const c of sorted) {
      const date = new Date(c.lastActivity).toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
      const label = (c.preview || '空会话').slice(0, 30) + ' — ' + date;
      const isActive = c.id === activeId;
      const isStreaming = assistantStreamingConvs.has(c.id);
      const hasPending = assistantPendingApprovals.has(c.id);
      const isCompleted = assistantConvCompleted.has(c.id);
      const classes = ['sidebar-conv-item'];
      if (isActive) classes.push('active');
      if (hasPending) classes.push('has-update');
      if (isCompleted && !hasPending) classes.push('has-completed');
      const item = document.createElement('div');
      item.className = classes.join(' ');
      item.dataset.id = c.id;
      const streamBadge = isStreaming ? '<span class="streaming-badge" title="正在流式输出">●</span>' : '';
      const completeBadge = isCompleted && !hasPending ? '<span class="completed-badge" title="任务已完成">✓</span>' : '';
      item.innerHTML = `${streamBadge}${completeBadge}<span class="sidebar-conv-item-label">${escapeHtml(label)}</span><button class="sidebar-conv-item-delete" title="删除">×</button>`;
      item.querySelector('.sidebar-conv-item-label').onclick = () => switchConversation(c.id, c);
      item.querySelector('.sidebar-conv-item-delete').onclick = (e) => deleteConversationById(c.id, e);
      list.appendChild(item);
    }
    // 安全兜底：确保当前会话的选中状态正确
    if (activeId) {
      const activeEl = list.querySelector(`.sidebar-conv-item[data-id="${activeId}"]`);
      if (activeEl && !activeEl.classList.contains('active')) {
        activeEl.classList.add('active');
      }
    }
    // 兜底：确保 badge 在侧边栏重建后仍然正确（防止异步竞争丢失 badge）
    updateSidebarBadges();
  } catch (err) {
    showToast('加载会话列表失败: ' + err.message, true);
  }
}

async function switchConversation(convId, convData) {
  if (!convId) {
    // 选择"新会话"
    assistantDisplayedConvId = '';
    setCurrentConvId('');
    clearAssistantChat();
    return;
  }

  // 切换显示目标（不中断流式输出）
  assistantDisplayedConvId = convId;
  setCurrentConvId(convId);
  saveAssistantSelection();
  assistantConvCompleted.delete(convId); // 清除完成标记

  // Restore conversation mode
  if (convData) {
    assistantChatMode = convData.mode || 'full';
    assistantWindowSize = convData.windowSize || 20;
    const modeSel = document.getElementById('assistant-mode-select');
    if (modeSel) modeSel.value = assistantChatMode;
    const wsInput = document.getElementById('settings-window-size');
    if (wsInput) wsInput.value = assistantWindowSize;
  }

  const chat = document.getElementById('assistant-chat');
  if (chat) chat.innerHTML = '';

  // 恢复 per-conversation 上下文栏
  const saved = assistantConvContext.get(convId);
  if (saved) {
    contextTokens = saved.tokens;
    contextMaxTokens = saved.maxTokens;
    contextPercent = saved.percent;
    contextMessages = saved.messages;
  } else {
    contextTokens = 0;
    contextPercent = 0;
    contextMessages = 0;
  }
  updateContextBar();

  // 如果内存中有消息（正在流式输出或之前加载过），直接渲染（不重复存储）
  const cached = assistantConvMessages.get(convId);
  if (cached && cached.length > 0) {
    for (const m of cached) {
      if (m.role === 'user') addAssistantMessage('user', m.content, m.backendMsgId, convId, true);
      else if (m.role === 'assistant' && m.content && String(m.content).trim()) addAssistantMessage('assistant', m.content, m.backendMsgId, convId, true);
      else if (['tool-calls', 'tool-result', 'tool-approval', 'delegate-card'].includes(m.role)) addAssistantMessage(m.role, m.content, m.backendMsgId, convId, true);
    }
    attachRetryButtonToLast();
    setSendBtnState(assistantConvControllers.has(convId));
    highlightActiveConversation();
    // 渲染后台期间积累的待审批
    renderPendingApprovals(convId);
    return;
  }

  // 首次加载：从服务端拉取历史
  try {
    const res = await fetch(`/api/assistant/conversations/${convId}/messages`);
    const data = await res.json();
    if (data.proxyId) {
      const running = proxies.filter(p => p.running);
      if (running.find(p => p.id === data.proxyId) && assistantProxyId !== data.proxyId) {
        assistantProxyId = data.proxyId;
        document.getElementById('assistant-send-btn').disabled = false;
        buildModelTree();
        loadProxyProviders(data.proxyId);
      }
    }
    if (data.compressionSummary) {
      const chatEl = document.getElementById('assistant-chat');
      if (chatEl) {
        const details = document.createElement('details');
        details.className = 'compression-summary';
        details.innerHTML = `<summary>之前的对话已被压缩</summary><div class="compression-summary-content">${escapeHtml(data.compressionSummary)}</div>`;
        chatEl.appendChild(details);
      }
    }
    for (const m of (data.messages || [])) {
      if (m.role === 'user') {
        addAssistantMessage('user', m.content, m.id, convId);
      } else if (m.role === 'assistant') {
        if (m.content && String(m.content).trim()) {
          addAssistantMessage('assistant', m.content, m.id, convId);
        }
      }
    }
    attachRetryButtonToLast();
    setSendBtnState(assistantConvControllers.has(convId));
    highlightActiveConversation();
    // 渲染后台期间积累的待审批
    renderPendingApprovals(convId);
  } catch (err) {
    showToast('加载会话失败: ' + err.message, true);
  }
}


async function compressAssistantContext() {
  if (!assistantProxyId || !assistantConversationId) return;
  const btn = document.getElementById('context-compress-btn');
  if (btn) { btn.disabled = true; btn.textContent = '压缩中...'; }
  try {
    const res = await fetch('/api/assistant/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        proxyId: assistantProxyId, conversationId: assistantConversationId, message: '', compress: true,
        ...(assistantProviderId && { providerId: assistantProviderId }),
        ...(assistantModel && { model: assistantModel }),
        chatMode: assistantPureMode ? 'pure' : 'assistant',
      }),
    });
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let currentEvent = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        if (trimmed.startsWith('event: ')) { currentEvent = trimmed.slice(7); continue; }
        if (!trimmed.startsWith('data: ')) continue;
        let data;
        try { data = JSON.parse(trimmed.slice(6)); } catch { continue; }
        if (currentEvent === 'compressed' && data.summary) applyCompression(data);
        if (currentEvent === 'context') {
          contextTokens = data.tokens;
          contextMaxTokens = data.maxTokens;
          contextPercent = data.percent;
          contextMessages = data.messages;
          updateContextBar();
        }
      }
    }
  } catch (err) {
    showToast('压缩失败: ' + err.message, true);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '压缩'; }
  }
}

function applyCompression(data) {
  // 后端已完成压缩，前端只更新显示
  if (data.tokens != null) contextTokens = data.tokens;
  if (data.maxTokens) contextMaxTokens = data.maxTokens;
  contextPercent = Math.round(contextTokens / contextMaxTokens * 1000) / 10;
  contextMessages = data.messages || 0;
  updateContextBar();
  if (data.summary) {
    showToast(`已压缩 ${data.removedCount} 条消息，摘要已保存`);
  }
}

// ========== 斜杠命令 ==========

function handleSlashCommand(cmd, args) {
  switch (cmd) {
    case 'help': showHelp(); return true;
    case 'clear': clearAssistantChat(); return true;
    case 'new': switchConversation(''); return true;
    case 'compact': compactConversation(); return true;
    case 'model': showModelPicker(); return true;
    default: return false;
  }
}

function showHelp() {
  const cmdList = SLASH_COMMANDS.map(c => `<tr><td><code>/${escapeHtml(c.name)}</code></td><td>${escapeHtml(c.description)}</td></tr>`).join('');
  const skillList = assistantSkills.length
    ? assistantSkills.map(s => {
      const desc = (s.description || '').length > 30 ? s.description.slice(0, 30) + '...' : (s.description || '');
      return `<tr><td><code>/${escapeHtml(s.name)}</code></td><td>${escapeHtml(desc)}</td></tr>`;
    }).join('')
    : '<tr><td colspan="2" style="color:var(--text-muted)">暂无技能</td></tr>';
  const html = `<div class="help-panel">
    <strong>命令</strong>
    <table class="help-table">${cmdList}</table>
    <strong style="margin-top:12px;display:block">技能</strong>
    <table class="help-table">${skillList}</table>
  </div>`;
  const id = addAssistantMessage('assistant', '');
  const el = document.getElementById(id);
  if (el) el.innerHTML = html;
}

async function compactConversation() {
  if (!assistantConversationId) {
    addAssistantMessage('assistant', '当前无对话可压缩。请先发送消息创建对话。');
    return;
  }
  if (!assistantProxyId) {
    addAssistantMessage('assistant', '请先选择代理。');
    return;
  }
  const msgId = addAssistantMessage('assistant', '正在压缩对话...');
  try {
    const res = await fetch('/api/assistant/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        proxyId: assistantProxyId, conversationId: assistantConversationId, message: '', compress: true,
        ...(assistantProviderId && { providerId: assistantProviderId }),
        ...(assistantModel && { model: assistantModel }),
        chatMode: assistantPureMode ? 'pure' : 'assistant',
      }),
    });
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let currentEvent = '';
    let summary = null;
    let removedCount = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        if (trimmed.startsWith('event: ')) { currentEvent = trimmed.slice(7); continue; }
        if (!trimmed.startsWith('data: ')) continue;
        let data;
        try { data = JSON.parse(trimmed.slice(6)); } catch { continue; }
        if (currentEvent === 'compressed') {
          if (data.summary) {
            summary = data.summary;
            removedCount = data.removedCount;
            applyCompression(data);
          }
        }
        if (currentEvent === 'context') {
          contextTokens = data.tokens;
          contextMaxTokens = data.maxTokens;
          contextPercent = data.percent;
          contextMessages = data.messages;
          updateContextBar();
        }
      }
    }
    if (summary) {
      updateAssistantMessage(msgId, `已压缩 ${removedCount} 条消息。\n\n**摘要：**\n${summary}`);
    } else {
      updateAssistantMessage(msgId, '无需压缩，对话内容较少。');
    }
  } catch (err) {
    updateAssistantMessage(msgId, `压缩失败: ${err.message}`);
  }
}

function showModelPicker() {
  const provider = proxyProviders.find(p => p.id === assistantProviderId);
  const models = (provider?.models || []).map(m => m.name);
  if (models.length === 0) {
    addAssistantMessage('assistant', '当前无可用模型。请先选择代理和供应商。');
    return;
  }
  const currentVal = assistantModel;
  const items = [{ value: '', label: '自动（跟随代理）' }, ...models.map(m => ({ value: m, label: m }))];
  const pickerId = addAssistantMessage('assistant', '');
  const htmlItems = items.map((m, i) =>
    `<div class="model-pick-item${m.value === currentVal ? ' selected' : ''}" data-model="${escapeHtml(m.value)}" data-index="${i}">${escapeHtml(m.label)}${m.value === currentVal ? ' (当前)' : ''}</div>`
  ).join('');
  const el = document.getElementById(pickerId);
  if (!el) return;

  el.innerHTML = `<strong>选择模型</strong><div class="model-picker" tabindex="0">${htmlItems}</div>`;
  const picker = el.querySelector('.model-picker');
  let activeIdx = items.findIndex(m => m.value === currentVal);
  if (activeIdx < 0) activeIdx = 0;

  function highlight(idx) {
    const all = picker.querySelectorAll('.model-pick-item');
    all.forEach((item, i) => item.classList.toggle('active', i === idx));
    if (all[idx]) all[idx].scrollIntoView({ block: 'nearest' });
  }

  function choose(idx) {
    const model = items[idx]?.value;
    if (model === undefined) return;
    assistantModel = model;
    saveAssistantSelection();
    buildModelTree();
    el.innerHTML = `已切换到 <strong>${escapeHtml(items[idx].label)}</strong>`;
    document.getElementById('assistant-input')?.focus();
  }

  highlight(activeIdx);
  picker.focus();

  picker.onkeydown = (e) => {
    const all = picker.querySelectorAll('.model-pick-item');
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      activeIdx = activeIdx < all.length - 1 ? activeIdx + 1 : 0;
      highlight(activeIdx);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      activeIdx = activeIdx > 0 ? activeIdx - 1 : all.length - 1;
      highlight(activeIdx);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      choose(activeIdx);
    } else if (e.key === 'Escape') {
      document.getElementById('assistant-input')?.focus();
    }
  };

  picker.onclick = (e) => {
    const item = e.target.closest('.model-pick-item');
    if (!item) return;
    choose(parseInt(item.dataset.index));
  };
}

// 加载代理的候选供应商列表
let proxyProviderRequestId = 0;
async function loadProxyProviders(proxyId) {
  const requestId = ++proxyProviderRequestId;
  // 保存用户当前选择，加载后恢复
  const prevProviderId = assistantProviderId;
  const prevModel = assistantModel;

  assistantProviderId = '';
  assistantModel = '';
  proxyProviders = [];
  _treeExpandedProviders.clear();
  buildModelTree();
  if (!proxyId) return;
  try {
    const res = await fetch(`/api/assistant/proxy-providers/${proxyId}`);
    const data = await res.json();
    // 并发保护：如果期间有更新的请求发起，本次结果作废
    if (requestId !== proxyProviderRequestId) return;
    proxyProviders = data.providers || [];
    // 优先恢复初始化时保存的选择（页面加载一次性）
    if (savedAssistantProviderId && proxyProviders.find(p => p.id === savedAssistantProviderId)) {
      assistantProviderId = savedAssistantProviderId;
      savedAssistantProviderId = '';
    } else if (prevProviderId && proxyProviders.find(p => p.id === prevProviderId)) {
      // 恢复用户之前的选择
      assistantProviderId = prevProviderId;
    }
    // 恢复模型选择
    const targetModel = savedAssistantModel || prevModel;
    if (targetModel) {
      const provider = proxyProviders.find(p => p.id === assistantProviderId);
      const models = provider?.models || [];
      if (models.find(m => m.name === targetModel)) {
        assistantModel = targetModel;
      }
      if (savedAssistantModel) savedAssistantModel = '';
    } else {
      assistantModel = prevModel || '';
    }
    // 自动展开已选中的供应商
    if (assistantProviderId) _treeExpandedProviders.add(assistantProviderId);
    buildModelTree();
    saveAssistantSelection();
    updateThinkingVisibility();
  } catch (err) {
    console.warn('[assistant] 加载供应商列表失败:', err.message);
  }
}

function populateProviderSelect() { /* no-op — tree handles this now */ }
function populateModelSelect() { /* no-op — tree handles this now */ }

// eslint-disable-next-line no-unused-vars
function onAssistantProviderChange(value) {
  assistantProviderId = value;
  assistantModel = '';
  updateThinkingVisibility();
  saveAssistantSelection();
  buildModelTree();
}

function updateThinkingVisibility() {
  const provider = proxyProviders.find(p => p.id === assistantProviderId);
  const wrap = document.getElementById('assistant-thinking-wrap');
  if (wrap) wrap.style.display = (provider?.adapter === 'deepseek') ? '' : 'none';
}

function saveAssistantSelection() {
  const permVal = document.getElementById('assistant-permission-select')?.value || '3';
  const thinkingVal = document.getElementById('assistant-thinking-select')?.value || '';
  fetch('/api/settings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ assistantProxyId, assistantProviderId, assistantModel, assistantPermissionLevel: permVal, assistantThinkingEffort: thinkingVal, assistantConversationId, pureConversationId, assistantChatMode, assistantWindowSize, assistantPureMode }),
  }).catch(() => {});
}

function updateWelcomeMessage() {
  const title = document.getElementById('assistant-welcome-title');
  const desc = document.getElementById('assistant-welcome-desc');
  const features = document.getElementById('assistant-welcome-features');
  const hint = document.getElementById('assistant-welcome-hint');
  if (!title) return;
  if (assistantPureMode) {
    title.textContent = '纯净模式';
    desc.textContent = '我是你的 AI 助手，可以帮你：';
    features.innerHTML = '<li>对话、写作、翻译、创意</li><li>数据分析、文件处理、图表</li><li>读写文件、执行代码</li><li>文档解析与内容提取</li>';
    hint.textContent = '请先选择一个运行中的代理作为对话后端';
  } else {
    title.textContent = '智控助手';
    desc.textContent = '我是你的 Protocol Proxy 智能助手，可以帮你：';
    features.innerHTML = '<li>查询代理和供应商运行状态</li><li>分析日志，定位异常原因</li><li>解读配置并给出优化建议</li><li>自然语言排障与问答</li>';
    hint.textContent = '请先选择一个运行中的代理作为对话后端';
  }
}

function getCurrentConvId() {
  return assistantPureMode ? pureConversationId : assistantConversationId;
}
function setCurrentConvId(id) {
  if (assistantPureMode) pureConversationId = id;
  else assistantConversationId = id;
}

function toggleAssistantPureMode() {
  // 切换模式
  assistantPureMode = !assistantPureMode;
  const toggle = document.getElementById('assistant-mode-toggle');
  if (toggle) toggle.classList.toggle('pure', assistantPureMode);

  // 读取目标模式的会话 ID 并切换显示
  const targetConvId = getCurrentConvId();
  // 同步调用 switchConversation（它内部会清空 chat、加载消息、设置 convId）
  if (targetConvId) {
    switchConversation(targetConvId);
  } else {
    clearAssistantChat();
  }
  saveAssistantSelection();
  loadConversations();
}

// ---- Model tree selector ----

const _treeExpandedProxies = new Set(); // expanded proxy IDs
const _treeExpandedProviders = new Set(); // expanded provider IDs

function buildModelTree() {
  const dropdown = document.getElementById('model-tree-dropdown');
  if (!dropdown) return;
  const running = proxies.filter(p => p.running);
  let html = '';

  running.forEach(proxy => {
    const isExpanded = _treeExpandedProxies.has(proxy.id);
    const isSelectedProxy = proxy.id === assistantProxyId;
    html += `<div class="mt-node${isSelectedProxy && !assistantProviderId && !assistantModel ? ' selected' : ''}" data-action="toggle-proxy" data-proxy-id="${escapeHtml(proxy.id)}">`;
    html += `<span class="mt-arrow${isExpanded ? ' expanded' : ''}">▶</span>`;
    html += `${escapeHtml(proxy.name)} <span style="opacity:0.5;font-size:11px">:${proxy.port}</span>`;
    html += `</div>`;

    if (isExpanded && isSelectedProxy) {
      // Provider auto option
      html += `<div class="mt-node mt-indent-1${!assistantProviderId ? ' selected' : ''}" data-action="select-auto-provider" data-proxy-id="${escapeHtml(proxy.id)}">`;
      html += `<span class="mt-leaf-space"></span><span class="mt-auto-label">自动（跟随代理）</span></div>`;

      proxyProviders.forEach(provider => {
        const isProvExpanded = _treeExpandedProviders.has(provider.id);
        const isSelectedProv = provider.id === assistantProviderId;
        html += `<div class="mt-node mt-indent-1${isSelectedProv && !assistantModel ? ' selected' : ''}" data-action="toggle-provider" data-provider-id="${escapeHtml(provider.id)}">`;
        html += `<span class="mt-arrow${isProvExpanded ? ' expanded' : ''}">▶</span>`;
        html += `${escapeHtml(provider.name)}`;
        html += `<span class="mt-protocol">${escapeHtml(provider.protocol)}</span>`;
        html += `</div>`;

        if (isProvExpanded && isSelectedProv) {
          // Model auto option
          html += `<div class="mt-node mt-indent-2${!assistantModel ? ' selected' : ''}" data-action="select-model" data-proxy-id="${escapeHtml(proxy.id)}" data-provider-id="${escapeHtml(provider.id)}" data-model="">`;
          html += `<span class="mt-leaf-space"></span><span class="mt-auto-label">自动（跟随代理）</span></div>`;

          (provider.models || []).forEach(m => {
            const isSel = assistantModel === m.name;
            html += `<div class="mt-node mt-indent-2${isSel ? ' selected' : ''}" data-action="select-model" data-proxy-id="${escapeHtml(proxy.id)}" data-provider-id="${escapeHtml(provider.id)}" data-model="${escapeHtml(m.name)}">`;
            html += `<span class="mt-leaf-space"></span>${escapeHtml(m.name)}</div>`;
          });
        }
      });
    }
  });

  if (!running.length) {
    html = '<div class="mt-node" style="opacity:0.5;cursor:default">无运行中的代理</div>';
  }

  dropdown.innerHTML = html;
  updateModelTreeLabel();
}

function updateModelTreeLabel() {
  const label = document.getElementById('model-tree-label');
  if (!label) return;
  const proxy = proxies.find(p => p.id === assistantProxyId);
  const provider = proxyProviders.find(p => p.id === assistantProviderId);
  if (!proxy) {
    label.textContent = '选择模型...';
    return;
  }
  const parts = [proxy.name];
  if (provider) parts.push(provider.name);
  if (assistantModel) parts.push(assistantModel);
  label.textContent = parts.join(' / ') || '选择模型...';
}

function toggleModelTreeDropdown() {
  const dropdown = document.getElementById('model-tree-dropdown');
  if (!dropdown) return;
  dropdown.classList.toggle('open');
}

// Close tree dropdown when clicking outside
document.addEventListener('click', (e) => {
  const wrapper = document.getElementById('model-tree-wrapper');
  const dropdown = document.getElementById('model-tree-dropdown');
  if (!wrapper || !dropdown) return;
  if (!wrapper.contains(e.target)) {
    dropdown.classList.remove('open');
  }
});

// Handle tree node clicks via delegation
document.addEventListener('click', (e) => {
  const node = e.target.closest('.mt-node');
  if (!node) return;
  const action = node.dataset.action;
  const proxyId = node.dataset.proxyId;
  const providerId = node.dataset.providerId;
  const model = node.dataset.model;

  if (action === 'toggle-proxy') {
    if (_treeExpandedProxies.has(proxyId)) {
      _treeExpandedProxies.delete(proxyId);
    } else {
      _treeExpandedProxies.add(proxyId);
      // If switching to a different proxy, load its providers
      if (proxyId !== assistantProxyId) {
        assistantProxyId = proxyId;
        assistantProviderId = '';
        assistantModel = '';
        _treeExpandedProviders.clear();
        const btn = document.getElementById('assistant-send-btn');
        if (btn) btn.disabled = false;
        loadProxyProviders(proxyId);
        saveAssistantSelection();
        return; // loadProxyProviders will call buildModelTree
      }
    }
    buildModelTree();
  } else if (action === 'toggle-provider') {
    if (_treeExpandedProviders.has(providerId)) {
      _treeExpandedProviders.delete(providerId);
    } else {
      _treeExpandedProviders.add(providerId);
    }
    if (providerId !== assistantProviderId) {
      assistantProviderId = providerId;
      assistantModel = '';
      updateThinkingVisibility();
      saveAssistantSelection();
    }
    buildModelTree();
  } else if (action === 'select-auto-provider') {
    assistantProviderId = '';
    assistantModel = '';
    updateThinkingVisibility();
    saveAssistantSelection();
    buildModelTree();
    document.getElementById('model-tree-dropdown')?.classList.remove('open');
  } else if (action === 'select-model') {
    if (providerId && providerId !== assistantProviderId) {
      assistantProviderId = providerId;
    }
    assistantModel = model || '';
    updateThinkingVisibility();
    saveAssistantSelection();
    buildModelTree();
    document.getElementById('model-tree-dropdown')?.classList.remove('open');
  }
});

async function onChatModeChange(newMode) {
  // sliding → full: estimate full conversation context usage
  if (newMode === 'full' && assistantChatMode === 'sliding') {
    // In sliding mode, contextPercent only reflects the window — estimate full usage
    const ws = assistantWindowSize || 20;
    const estimatedPercent = contextMessages > ws
      ? Math.round(contextPercent * contextMessages / ws)
      : contextPercent;
    if (estimatedPercent > 80) {
      const ok = await showConfirm(`完整会话约 ${contextMessages} 条消息，预估上下文使用约 ${estimatedPercent}%，切换到专业模式需要先压缩会话。是否立即压缩？`);
      if (ok) {
        await compressAssistantContext();
      } else {
        const sel = document.getElementById('assistant-mode-select');
        if (sel) sel.value = 'sliding';
        return;
      }
    }
  }
  assistantChatMode = newMode;
  saveAssistantSelection();
}

function onWindowSizeChange(val) {
  assistantWindowSize = Math.max(1, Math.min(200, parseInt(val) || 20));
  const el = document.getElementById('settings-window-size');
  if (el) el.value = assistantWindowSize;
  saveAssistantSelection();
}

// 树形选择器触发按钮
(function() {
  const trigger = document.getElementById('model-tree-trigger');
  if (trigger) {
    trigger.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleModelTreeDropdown();
    });
  }
})();

// 恢复侧边栏状态（默认收起，首次访问保持收起避免闪烁）
(function() {
  const sidebar = document.getElementById('assistant-sidebar');
  const toggleBtn = document.getElementById('sidebar-toggle-btn');
  const saved = localStorage.getItem('assistant-sidebar-collapsed');
  if (sidebar && saved !== null && saved !== '1') {
    sidebar.classList.remove('collapsed');
    if (toggleBtn) toggleBtn.style.display = 'none';
  }
})();

// ========== 助手 Skill 补全 ==========
let assistantSkills = []; // 助手页面缓存的 skill 列表

async function loadAssistantSkills() {
  try {
    const res = await fetch('/api/skills');
    const data = await res.json();
    assistantSkills = data.skills || [];
    renderSkillPanel();
  } catch {}
}

function toggleSkillPanel() {
  const panel = document.getElementById('skill-panel');
  if (!panel) return;
  panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
}

function renderSkillPanel() {
  const list = document.getElementById('skill-panel-list');
  if (!list) return;
  const catColors = { system: 'var(--error)', preset: 'var(--warning)', user: 'var(--success)' };
  const catLabels = { system: '系统', preset: '预设', user: '用户' };
  if (assistantSkills.length === 0) {
    list.innerHTML = '<div style="padding:8px;color:var(--text-muted);font-size:12px">暂无可用技能，可前往「技能管理」页面创建</div>';
    return;
  }
  list.innerHTML = assistantSkills.map(s =>
    `<div class="skill-panel-item" data-name="${escapeHtml(s.name)}">
      <span class="skill-panel-badge" style="background:${catColors[s.category] || 'var(--text-muted)'}">${catLabels[s.category] || s.category}</span>
      <strong>/${escapeHtml(s.name)}</strong>
      <span class="skill-panel-desc">${escapeHtml(s.description || '')}</span>
    </div>`
  ).join('');
  list.onclick = (e) => {
    const item = e.target.closest('[data-name]');
    if (item) selectSkill(item.dataset.name);
  };
}

function updateSkillAutocomplete(text) {
  const ac = document.getElementById('skill-autocomplete');
  if (!ac) return;
  // 只在输入以 / 开头且没有空格（还没输入参数）时显示
  const match = text.match(/^\/([a-zA-Z0-9_-]*)$/);
  if (!match) { ac.style.display = 'none'; skillAcIndex = -1; return; }
  const query = match[1].toLowerCase();
  const cmdItems = SLASH_COMMANDS.filter(c => c.name.includes(query)).map(c => ({ name: c.name, description: c.description, isCommand: true }));
  const skillItems = assistantSkills.filter(s => s.name.toLowerCase().includes(query)).map(s => ({ name: s.name, description: s.description || '', isCommand: false }));
  const filtered = [...cmdItems, ...skillItems];
  if (filtered.length === 0) { ac.style.display = 'none'; skillAcIndex = -1; return; }
  skillAcIndex = -1;
  ac.innerHTML = filtered.map((s, i) =>
    `<div class="skill-ac-item" data-name="${escapeHtml(s.name)}" data-index="${i}"><strong>/${escapeHtml(s.name)}</strong><span class="skill-ac-desc">${s.isCommand ? '[命令] ' : ''}${escapeHtml(s.description)}</span></div>`
  ).join('');
  ac.style.display = 'block';
  ac.onclick = (e) => {
    const item = e.target.closest('[data-name]');
    if (item) selectSkill(item.dataset.name);
  };
}

function highlightAcItem(items, index) {
  items.forEach((item, i) => item.classList.toggle('active', i === index));
  if (items[index]) items[index].scrollIntoView({ block: 'nearest' });
}

function selectSkill(name) {
  const input = document.getElementById('assistant-input');
  if (input) {
    input.value = '/' + name + ' ';
    input.focus();
  }
  const ac = document.getElementById('skill-autocomplete');
  if (ac) ac.style.display = 'none';
}

// ========== 技能管理 ==========
let allSkills = [];
let editingSkillName = '';
let skillModalMode = 'upload'; // 'upload' | 'edit' | 'create'
let pendingSkillFiles = null; // 待上传的文件夹 [{path, content(base64)}]

function reloadSkills() {
  fetch('/api/skills/reload', { method: 'POST' })
    .then(r => r.json())
    .then(() => loadSkills())
    .catch(() => loadSkills());
}

async function loadSkills() {
  try {
    const res = await fetch('/api/skills-status');
    const data = await res.json();
    allSkills = data.skills || [];
    renderSkills();
    const badge = document.getElementById('nav-skill-count');
    if (badge) badge.textContent = allSkills.length;
  } catch (err) {
    showToast('加载技能失败: ' + err.message, true);
  }
}

async function toggleSkillPureMode(name, enabled) {
  try {
    await fetch(`/api/skills/${encodeURIComponent(name)}/pure-toggle`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled }),
    });
    // 更新本地数据
    const skill = allSkills.find(s => s.name === name);
    if (skill) skill.pureModeEnabled = enabled;
  } catch (err) {
    showToast('切换失败: ' + err.message, true);
  }
}

function renderSkills() {
  const container = document.getElementById('skills-container');
  if (!container) return;
  const groups = { system: [], preset: [], user: [] };
  for (const s of allSkills) (groups[s.category] || groups.user).push(s);
  const labels = { system: '系统级', preset: '预设', user: '用户' };
  const colors = { system: 'var(--error)', preset: 'var(--warning)', user: 'var(--success)' };
  let html = '';
  for (const [cat, items] of Object.entries(groups)) {
    if (items.length === 0) continue;
    html += `<div class="skill-group"><h3 style="margin:0 0 12px;display:flex;align-items:center;gap:8px"><span class="skill-badge" style="background:${colors[cat]};color:#fff;padding:2px 8px;border-radius:4px;font-size:12px">${labels[cat]}</span> ${labels[cat]}技能 (${items.length})</h3><div class="skills-grid">`;
    for (const s of items) {
      const canEdit = cat === 'user';
      const canDelete = cat !== 'system';
      const canTogglePure = cat !== 'system'; // system 技能不显示开关
      const pureChecked = s.pureModeEnabled;
      html += `<div class="skill-card">
        <div class="skill-card-header"><strong>${escapeHtml(s.name)}</strong></div>
        <div class="skill-card-desc">${escapeHtml(s.description || '无描述')}</div>
        ${canTogglePure ? `<div class="skill-card-pure-toggle" style="display:flex;align-items:center;gap:6px;margin:6px 0;font-size:12px;color:var(--text-muted)">
          <label style="display:flex;align-items:center;gap:4px;cursor:pointer">
            <input type="checkbox" data-action="pure-toggle" data-name="${escapeHtml(s.name)}" ${pureChecked ? 'checked' : ''} style="cursor:pointer">
            纯净模式可用
          </label>
        </div>` : `<div style="margin:6px 0;font-size:11px;color:var(--text-muted);opacity:0.6">仅助手模式可用</div>`}
        <div class="skill-card-actions">
          <button class="btn btn-sm" data-action="view" data-name="${escapeHtml(s.name)}">查看</button>
          ${canEdit ? `<button class="btn btn-sm" data-action="edit" data-name="${escapeHtml(s.name)}">编辑</button>` : ''}
          ${canDelete ? `<button class="btn btn-sm btn-danger" data-action="delete" data-name="${escapeHtml(s.name)}">删除</button>` : ''}
        </div>
      </div>`;
    }
    html += '</div></div>';
  }
  container.innerHTML = html || '<p style="color:var(--text-muted)">暂无技能</p>';
  container.onclick = (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const name = btn.dataset.name;
    const action = btn.dataset.action;
    if (action === 'view') viewSkill(name);
    else if (action === 'edit') editSkill(name);
    else if (action === 'delete') deleteSkill(name);
    else if (action === 'pure-toggle') {
      toggleSkillPureMode(name, btn.checked);
    }
  };
}

function showSkillModal(name) {
  editingSkillName = name || '';
  pendingSkillFile = null;
  const isEdit = !!name;
  skillModalMode = isEdit ? 'edit' : 'upload';
  document.getElementById('skill-modal-title').textContent = isEdit ? '编辑技能' : '上传技能';
  document.getElementById('skill-save-btn').textContent = isEdit ? '保存' : '上传';
  document.getElementById('skill-upload-section').style.display = isEdit ? 'none' : 'block';
  document.getElementById('skill-edit-section').style.display = isEdit ? 'block' : 'none';
  if (isEdit) {
    document.getElementById('skill-name').value = name;
    document.getElementById('skill-name').disabled = true;
    document.getElementById('skill-existing-files').innerHTML = '';
    fetch(`/api/skills/${encodeURIComponent(name)}`).then(r => r.json()).then(s => {
      document.getElementById('skill-description').value = s.description || '';
      document.getElementById('skill-trigger').value = s.trigger || '';
      document.getElementById('skill-content').value = s.content || '';
      renderSkillFiles(s);
    });
  } else {
    document.getElementById('skill-trigger').value = '';
    document.getElementById('skill-file-input').value = '';
    document.getElementById('skill-file-preview').innerHTML = '';
  }
  showModal('skill-modal');
}

function showCreateSkillModal() {
  editingSkillName = '';
  skillModalMode = 'create';
  document.getElementById('skill-modal-title').textContent = '创建技能';
  document.getElementById('skill-save-btn').textContent = '创建';
  document.getElementById('skill-upload-section').style.display = 'none';
  document.getElementById('skill-edit-section').style.display = 'block';
  document.getElementById('skill-name').value = '';
  document.getElementById('skill-name').disabled = false;
  document.getElementById('skill-description').value = '';
  document.getElementById('skill-trigger').value = '';
  document.getElementById('skill-content').value = '';
  document.getElementById('skill-existing-files').innerHTML = '';
  showModal('skill-modal');
}

function renderSkillFiles(skill) {
  const el = document.getElementById('skill-existing-files');
  const allPaths = [];
  if (skill.scripts?.length) allPaths.push(...skill.scripts.map(f => `scripts/${f}`));
  if (skill.references?.length) allPaths.push(...skill.references.map(f => `reference/${f}`));
  if (allPaths.length === 0) { el.innerHTML = '<span style="color:var(--text-muted)">暂无附属文件</span>'; return; }
  // 构建树：{ name, children: [...dirs], files: [{name, fullPath}] }
  const tree = { name: '', children: [], files: [] };
  for (const p of allPaths) {
    const parts = p.split('/');
    let node = tree;
    for (let i = 0; i < parts.length - 1; i++) {
      let child = node.children.find(c => c.name === parts[i]);
      if (!child) { child = { name: parts[i], children: [], files: [] }; node.children.push(child); }
      node = child;
    }
    node.files.push({ name: parts[parts.length - 1], fullPath: p });
  }
  const canDelete = skill.category !== 'system';
  function countAll(node) {
    return node.files.length + node.children.reduce((s, c) => s + countAll(c), 0);
  }
  function renderNode(node, depth) {
    let html = '';
    html += renderFiles(node.files, depth);
    for (const dir of node.children) {
      html += `<div class="skill-tree-dir" style="padding-left:${depth * 16}px">` +
        `<span class="skill-tree-arrow">&#9654;</span> <code>${escapeHtml(dir.name)}/</code> <span style="color:var(--text-muted);font-size:11px">(${countAll(dir)})</span></div>`;
      html += `<div class="skill-tree-children" style="display:none">`;
      html += renderNode(dir, depth + 1);
      html += '</div>';
    }
    return html;
  }
  function renderFiles(files, depth) {
    return files.map(f =>
      `<div class="skill-tree-file" style="padding-left:${depth * 16}px">` +
      `<code>${escapeHtml(f.name)}</code>${canDelete ? ` <button class="btn btn-sm btn-danger" style="padding:0 6px;font-size:11px" data-action="delete-file" data-path="${escapeHtml(f.fullPath)}">删除</button>` : ''}</div>`
    ).join('');
  }
  el.innerHTML = renderNode(tree, 0);
  el.onclick = (e) => {
    const dir = e.target.closest('.skill-tree-dir');
    if (dir) {
      const children = dir.nextElementSibling;
      const arrow = dir.querySelector('.skill-tree-arrow');
      const open = children.style.display === 'none';
      children.style.display = open ? 'block' : 'none';
      arrow.style.transform = open ? 'rotate(90deg)' : '';
      return;
    }
    const btn = e.target.closest('[data-action="delete-file"]');
    if (btn) deleteSkillFile(btn.dataset.path);
  };
}

async function uploadSkillFiles() {
  if (!editingSkillName) return;
  const input = document.getElementById('skill-upload-input');
  const subDir = document.getElementById('skill-upload-dir').value;
  const files = input.files;
  if (!files.length) return showToast('请选择文件', true);
  for (const file of files) {
    const reader = new FileReader();
    reader.onload = async () => {
      const base64 = reader.result.split(',')[1];
      try {
        const res = await fetch(`/api/skills/${editingSkillName}/upload`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ filename: file.name, subDir, content: base64 }),
        });
        if (!res.ok) { const e = await res.json(); throw new Error(e.error); }
        showToast(`已上传 ${file.name}`);
        // 刷新文件列表
        const s = await (await fetch(`/api/skills/${editingSkillName}`)).json();
        renderSkillFiles(s);
      } catch (err) {
        showToast('上传失败: ' + err.message, true);
      }
    };
    reader.readAsDataURL(file);
  }
  input.value = '';
}

async function deleteSkillFile(filePath) {
  if (!editingSkillName) return;
  const ok = await showConfirm(`确定删除文件 <strong>${escapeHtml(filePath)}</strong>？`);
  if (!ok) return;
  try {
    const res = await fetch(`/api/skills/${encodeURIComponent(editingSkillName)}/file`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filePath }),
    });
    if (!res.ok) { const e = await res.json(); throw new Error(e.error); }
    showToast('文件已删除');
    const s = await (await fetch(`/api/skills/${editingSkillName}`)).json();
    renderSkillFiles(s);
  } catch (err) {
    showToast('删除失败: ' + err.message, true);
  }
}

function closeSkillModal() {
  hideModal('skill-modal');
  editingSkillName = '';
  skillModalMode = 'upload';
  pendingSkillFiles = null;
}

// 技能文件夹选择预览
document.getElementById('skill-file-input')?.addEventListener('change', async (e) => {
  const files = Array.from(e.target.files);
  const preview = document.getElementById('skill-file-preview');
  if (!files.length) { pendingSkillFiles = null; preview.innerHTML = ''; return; }
  // 找到 SKILL.md（可能在子目录中）
  const skillMd = files.find(f => f.webkitRelativePath.endsWith('/SKILL.md') || f.name === 'SKILL.md');
  if (!skillMd) {
    pendingSkillFiles = null;
    preview.innerHTML = '<div style="color:var(--error);font-size:13px">文件夹中未找到 SKILL.md</div>';
    return;
  }
  // 读取 SKILL.md 解析 frontmatter
  const text = await skillMd.text();
  const fm = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  let name = '', desc = '';
  if (fm) {
    for (const line of fm[1].split('\n')) {
      const nm = line.trim().match(/^name:\s*['"]?(.+?)['"]?\s*$/);
      const dm = line.trim().match(/^description:\s*['"]?(.+?)['"]?\s*$/);
      if (nm) name = nm[1];
      if (dm) desc = dm[1];
    }
  }
  if (!name) {
    pendingSkillFiles = null;
    preview.innerHTML = '<div style="color:var(--error);font-size:13px">SKILL.md 缺少 name 字段</div>';
    return;
  }
  // 读取所有文件为 base64
  const prefix = skillMd.webkitRelativePath.split('/')[0] + '/';
  pendingSkillFiles = await Promise.all(files.map(async f => {
    const buf = await f.arrayBuffer();
    const bytes = new Uint8Array(buf);
    let binary = '';
    for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
    return { path: f.webkitRelativePath.replace(prefix, ''), content: btoa(binary) };
  }));
  // 预览
  const fileList = pendingSkillFiles.map(f => `<code>${escapeHtml(f.path)}</code>`).join(' ');
  preview.innerHTML =
    `<div style="padding:8px 12px;background:var(--bg-elevated);border-radius:6px;font-size:13px">` +
    `<div><strong>名称：</strong>${escapeHtml(name)}</div>` +
    `<div style="color:var(--text-muted)"><strong>描述：</strong>${escapeHtml(desc || '无')}</div>` +
    `<div style="color:var(--text-muted);font-size:12px;margin-top:4px">文件 (${pendingSkillFiles.length})：${fileList}</div></div>`;
});

async function saveSkill() {
  if (skillModalMode === 'create') {
    // 创建模式
    const name = document.getElementById('skill-name').value.trim();
    const description = document.getElementById('skill-description').value.trim();
    const trigger = document.getElementById('skill-trigger').value.trim();
    const content = document.getElementById('skill-content').value.trim();
    if (!name || !content) return showToast('名称和内容不能为空', true);
    try {
      const res = await fetch('/api/skills', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, description, trigger, content }),
      });
      if (!res.ok) { const e = await res.json(); throw new Error(e.error); }
      closeSkillModal();
      await loadSkills();
      showToast('技能已创建');
    } catch (err) {
      showToast('创建失败: ' + err.message, true);
    }
    return;
  }
  if (!editingSkillName) {
    // 上传模式
    if (!pendingSkillFiles) return showToast('请选择技能文件夹', true);
    try {
      const res = await fetch('/api/skills/upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ files: pendingSkillFiles }),
      });
      if (!res.ok) { const e = await res.json(); throw new Error(e.error); }
      closeSkillModal();
      await loadSkills();
      showToast('技能已上传');
    } catch (err) {
      showToast('上传失败: ' + err.message, true);
    }
    return;
  }
  // 编辑模式
  const name = document.getElementById('skill-name').value.trim();
  const description = document.getElementById('skill-description').value.trim();
  const trigger = document.getElementById('skill-trigger').value.trim();
  const content = document.getElementById('skill-content').value.trim();
  if (!name || !content) return showToast('名称和内容不能为空', true);
  try {
    const res = await fetch(`/api/skills/${encodeURIComponent(editingSkillName)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, description, trigger, content }),
    });
    if (!res.ok) { const e = await res.json(); throw new Error(e.error); }
    closeSkillModal();
    await loadSkills();
    showToast('技能已更新');
  } catch (err) {
    showToast('保存失败: ' + err.message, true);
  }
}

function editSkill(name) {
  showSkillModal(name);
}

async function deleteSkill(name) {
  const ok = await showConfirm(`确定删除技能 <strong>${escapeHtml(name)}</strong>？`);
  if (!ok) return;
  try {
    const res = await fetch(`/api/skills/${encodeURIComponent(name)}`, { method: 'DELETE' });
    if (!res.ok) { const e = await res.json(); throw new Error(e.error); }
    await loadSkills();
    showToast('技能已删除');
  } catch (err) {
    showToast('删除失败: ' + err.message, true);
  }
}

async function viewSkill(name) {
  try {
    const res = await fetch(`/api/skills/${encodeURIComponent(name)}`);
    const s = await res.json();
    const catColors = { system: 'var(--error)', preset: 'var(--warning)', user: 'var(--success)' };
    const catLabels = { system: '系统级', preset: '预设', user: '用户' };
    document.getElementById('skill-view-title').textContent = s.name;
    const badge = document.getElementById('skill-view-badge');
    badge.textContent = catLabels[s.category] || s.category;
    badge.style.background = catColors[s.category] || 'var(--text-muted)';
    badge.style.color = '#fff';
    document.getElementById('skill-view-desc').textContent = s.description || '';
    // 显示附属文件
    const filesEl = document.getElementById('skill-view-files');
    const files = [];
    if (s.scripts?.length) files.push(...s.scripts.map(f => `<code>scripts/${escapeHtml(f)}</code>`));
    if (s.references?.length) files.push(...s.references.map(f => `<code>reference/${escapeHtml(f)}</code>`));
    filesEl.innerHTML = files.length > 0 ? `<div style="font-size:12px;color:var(--text-muted)">附属文件: ${files.join(' ')}</div>` : '';
    // 内容（markdown 渲染）
    const rawHtml = typeof marked !== 'undefined' ? marked.parse(s.content) : formatAssistantContent(s.content);
    const contentHtml = typeof DOMPurify !== 'undefined' ? DOMPurify.sanitize(rawHtml) : rawHtml;
    document.getElementById('skill-view-content').innerHTML = contentHtml;
    showModal('skill-view-modal');
  } catch (err) {
    showToast('加载失败: ' + err.message, true);
  }
}

function closeSkillViewModal() {
  hideModal('skill-view-modal');
}

// ==================== Agent 身份管理 ====================

let allAgents = [];
let editingAgentSlug = '';
let agentDomainFilter = '';
let agentCollapsedGroups = { system: false, preset: false, user: false };
let agentCollapsedDomains = {};

async function loadAgents() {
  try {
    const res = await fetch('/api/agents');
    const data = await res.json();
    allAgents = data.agents || [];
    renderAgents();
    const badge = document.getElementById('nav-agent-count');
    if (badge) badge.textContent = allAgents.length;
  } catch (err) {
    showToast('加载代理失败: ' + err.message, true);
  }
}

function renderAgentCard(a, cat) {
  const roleColors = { readonly: '#3B82F6', writer: '#22C55E', full: '#A855F7' };
  const roleLabels = { readonly: '只读', writer: '读写', full: '完全' };
  const canEdit = cat === 'user';
  const canDelete = cat !== 'system';
  const rc = roleColors[a.defaultRole] || '#6B7280';
  const rl = roleLabels[a.defaultRole] || a.defaultRole;
  return `<div class="skill-card" style="border-left:3px solid ${a.color || '#6B7280'}">
    <div class="skill-card-header" style="display:flex;align-items:center;gap:8px">
      <span style="width:10px;height:10px;border-radius:50%;background:${a.color || '#6B7280'};flex-shrink:0"></span>
      <strong>${escapeHtml(a.name)}</strong>
      <span style="background:${rc}20;color:${rc};padding:1px 6px;border-radius:4px;font-size:11px">${rl}</span>
    </div>
    <div class="skill-card-desc">${escapeHtml(a.description || '无描述')}</div>
    <div class="skill-card-actions">
      <button class="btn btn-sm" onclick="viewAgent('${escapeHtml(a.slug)}')">查看</button>
      ${canEdit ? `<button class="btn btn-sm" onclick="editAgent('${escapeHtml(a.slug)}')">编辑</button>` : ''}
      ${canDelete ? `<button class="btn btn-sm btn-danger" onclick="deleteAgent('${escapeHtml(a.slug)}')">删除</button>` : ''}
    </div>
  </div>`;
}

function toggleAgentGroup(group) {
  agentCollapsedGroups[group] = !agentCollapsedGroups[group];
  renderAgents();
}

function toggleAgentDomain(domain) {
  agentCollapsedDomains[domain] = !agentCollapsedDomains[domain];
  renderAgents();
}

function setAgentDomainFilter(domain) {
  agentDomainFilter = domain;
  // 切换筛选时重置折叠状态
  agentCollapsedDomains = {};
  renderAgents();
}

function renderAgents() {
  const container = document.getElementById('agents-container');
  if (!container) return;
  const groups = { system: [], preset: [], user: [] };
  for (const a of allAgents) (groups[a.category] || groups.user).push(a);
  const labels = { system: '系统级', preset: '预设', user: '用户' };
  const catColors = { system: 'var(--error)', preset: 'var(--warning)', user: 'var(--success)' };
  const chevron = collapsed => collapsed ? '▶' : '▼';

  let html = '';
  for (const [cat, items] of Object.entries(groups)) {
    if (items.length === 0) continue;
    const collapsed = agentCollapsedGroups[cat];
    const arrow = chevron(collapsed);

    // 标题栏
    html += `<div style="margin-bottom:20px">
      <div onclick="toggleAgentGroup('${cat}')" style="display:flex;align-items:center;gap:8px;cursor:pointer;padding:8px 0;user-select:none">
        <span style="font-size:11px;color:var(--text-muted);width:14px">${arrow}</span>
        <span class="skill-badge" style="background:${catColors[cat]};color:#fff;padding:2px 8px;border-radius:4px;font-size:12px">${labels[cat]}</span>
        <span style="font-weight:600;font-size:14px">${labels[cat]}代理</span>
        <span style="font-size:12px;color:var(--text-muted)">(${items.length})</span>
      </div>`;

    if (collapsed) {
      html += '</div>';
      continue;
    }

    // 预设分组：领域筛选 + 子分组
    if (cat === 'preset') {
      // 领域 pill 栏
      const domainCounts = {};
      for (const a of items) domainCounts[a.domain] = (domainCounts[a.domain] || 0) + 1;
      const domains = Object.entries(domainCounts).sort((a, b) => b[1] - a[1]);

      html += `<div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:12px;padding-left:22px">
        <button class="btn btn-sm${agentDomainFilter === '' ? ' btn-primary' : ''}" onclick="setAgentDomainFilter('')" style="font-size:11px;padding:2px 8px">全部 ${items.length}</button>`;
      for (const [d, c] of domains) {
        const active = agentDomainFilter === d;
        html += `<button class="btn btn-sm${active ? ' btn-primary' : ''}" onclick="setAgentDomainFilter('${escapeHtml(d)}')" style="font-size:11px;padding:2px 8px">${escapeHtml(d)} ${c}</button>`;
      }
      html += '</div>';

      // 按领域筛选或分组显示
      if (agentDomainFilter) {
        // 筛选模式：只显示选中领域
        const filtered = items.filter(a => a.domain === agentDomainFilter);
        html += `<div class="skills-grid" style="padding-left:22px">`;
        for (const a of filtered) html += renderAgentCard(a, cat);
        html += '</div>';
      } else {
        // 分组模式：按领域折叠子分组
        for (const [domain, count] of domains) {
          const domainCollapsed = agentCollapsedDomains[domain] !== false; // 默认折叠
          const dArrow = chevron(domainCollapsed);
          html += `<div style="margin-bottom:8px">
            <div onclick="toggleAgentDomain('${escapeHtml(domain)}')" style="display:flex;align-items:center;gap:6px;cursor:pointer;padding:4px 0 4px 22px;user-select:none;font-size:13px">
              <span style="font-size:10px;color:var(--text-muted);width:12px">${dArrow}</span>
              <span style="font-weight:500">${escapeHtml(domain)}</span>
              <span style="font-size:11px;color:var(--text-muted)">(${count})</span>
            </div>`;
          if (!domainCollapsed) {
            const domainItems = items.filter(a => a.domain === domain);
            html += '<div class="skills-grid" style="padding-left:34px">';
            for (const a of domainItems) html += renderAgentCard(a, cat);
            html += '</div>';
          }
          html += '</div>';
        }
      }
    } else {
      // 系统级和用户：直接显示卡片网格
      html += '<div class="skills-grid">';
      for (const a of items) html += renderAgentCard(a, cat);
      html += '</div>';
    }

    html += '</div>';
  }
  container.innerHTML = html || '<p style="color:var(--text-muted)">暂无代理</p>';
}


// ==================== 上传代理 ====================
let agentUploadFiles = [];

function showAgentUploadModal() {
  agentUploadFiles = [];
  document.getElementById('agent-upload-input').value = '';
  document.getElementById('agent-upload-preview').style.display = 'none';
  document.getElementById('agent-upload-filelist').innerHTML = '';
  document.getElementById('agent-upload-btn').disabled = true;
  showModal('agent-upload-modal');

  // 拖拽事件
  const drop = document.getElementById('agent-upload-drop');
  drop.ondragover = function(e) { e.preventDefault(); drop.style.borderColor = 'var(--accent)'; drop.style.background = 'var(--accent-subtle)' };
  drop.ondragleave = function(e) { e.preventDefault(); drop.style.borderColor = 'var(--border-default)'; drop.style.background = '' };
  drop.ondrop = function(e) {
    e.preventDefault();
    drop.style.borderColor = 'var(--border-default)'; drop.style.background = '';
    onAgentUploadSelected(e.dataTransfer.files);
  };
}

function closeAgentUploadModal() {
  hideModal('agent-upload-modal');
  agentUploadFiles = [];
}

function onAgentUploadSelected(files) {
  agentUploadFiles = [];
  for (const f of files) {
    if (f.name.endsWith('.md')) agentUploadFiles.push(f);
  }
  const preview = document.getElementById('agent-upload-preview');
  const list = document.getElementById('agent-upload-filelist');
  const btn = document.getElementById('agent-upload-btn');
  if (agentUploadFiles.length === 0) {
    preview.style.display = 'none';
    btn.disabled = true;
    return;
  }
  preview.style.display = 'block';
  btn.disabled = false;
  list.innerHTML = agentUploadFiles.map(f =>
    '<div style="display:flex;align-items:center;gap:8px;padding:6px 8px;border:1px solid var(--border-subtle);border-radius:var(--radius-sm);margin-bottom:4px;font-size:13px">' +
      '<span style="flex:1;color:var(--text-primary)">' + escapeHtml(f.name) + '</span>' +
      '<span style="color:var(--text-muted);font-size:12px">' + (f.size / 1024).toFixed(1) + ' KB</span>' +
    '</div>'
  ).join('');
}

async function uploadAgentFiles() {
  if (agentUploadFiles.length === 0) return;
  const btn = document.getElementById('agent-upload-btn');
  btn.disabled = true;
  btn.textContent = '上传中...';
  try {
    const files = [];
    for (const f of agentUploadFiles) {
      const buf = await f.arrayBuffer();
      const b64 = btoa(String.fromCharCode(...new Uint8Array(buf)));
      files.push({ name: f.name, content: b64 });
    }
    const res = await fetch('/api/agents/upload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ files }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '上传失败');
    closeAgentUploadModal();
    await loadAgents();
    const msg = data.imported > 0 ? '成功导入 ' + data.imported + ' 个代理' : '没有新代理被导入';
    const skipped = (data.results || []).filter(r => r.status === 'skipped').length;
    showToast(skipped > 0 ? msg + '，跳过 ' + skipped + ' 个' : msg);
  } catch (err) {
    showToast('上传失败: ' + err.message, true);
  } finally {
    btn.textContent = '上传';
    btn.disabled = false;
  }
}
function showAgentModal(slug) {
  editingAgentSlug = slug || '';
  const modal = document.getElementById('agent-modal');
  const title = document.getElementById('agent-modal-title');
  const nameInput = document.getElementById('agent-name');

  if (slug) {
    const agent = allAgents.find(a => a.slug === slug);
    if (!agent) return;
    title.textContent = '编辑代理';
    nameInput.value = agent.slug;
    nameInput.disabled = true;
    document.getElementById('agent-display-name').value = agent.name || '';
    document.getElementById('agent-description').value = agent.description || '';
    document.getElementById('agent-color').value = agent.color || '#6B7280';
    document.getElementById('agent-defaultRole').value = agent.defaultRole || 'writer';
    document.getElementById('agent-body').value = agent.body || '';
  } else {
    title.textContent = '创建代理';
    nameInput.value = '';
    nameInput.disabled = false;
    document.getElementById('agent-display-name').value = '';
    document.getElementById('agent-description').value = '';
    document.getElementById('agent-color').value = '#6B7280';
    document.getElementById('agent-defaultRole').value = 'writer';
    document.getElementById('agent-body').value = '';
  }
  showModal('agent-modal');
}

function closeAgentModal() {
  hideModal('agent-modal');
  editingAgentSlug = '';
}

async function saveAgent() {
  const slug = document.getElementById('agent-name').value.trim();
  const displayName = document.getElementById('agent-display-name').value.trim();
  const description = document.getElementById('agent-description').value.trim();
  const color = document.getElementById('agent-color').value;
  const defaultRole = document.getElementById('agent-defaultRole').value;
  const body = document.getElementById('agent-body').value;

  if (!slug) return showToast('请填写代理名称', true);
  if (!body) return showToast('请填写系统提示词', true);

  try {
    const isEdit = !!editingAgentSlug;
    const url = isEdit ? `/api/agents/${editingAgentSlug}` : '/api/agents';
    const method = isEdit ? 'PUT' : 'POST';
    const payload = isEdit
      ? { description, body, color, defaultRole, name: displayName || undefined }
      : { name: slug, description, body, color, defaultRole };
    const res = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || '保存失败');
    }
    closeAgentModal();
    await loadAgents();
    showToast(isEdit ? '代理已更新' : '代理已创建');
  } catch (err) {
    showToast('保存失败: ' + err.message, true);
  }
}

async function editAgent(slug) {
  // 需要获取完整 body
  try {
    const res = await fetch(`/api/agents/${slug}`);
    if (!res.ok) throw new Error('获取代理失败');
    const agent = await res.json();
    // 更新 allAgents 中的 body
    const idx = allAgents.findIndex(a => a.slug === slug);
    if (idx >= 0) allAgents[idx] = { ...allAgents[idx], ...agent };
    showAgentModal(slug);
  } catch (err) {
    showToast('加载失败: ' + err.message, true);
  }
}

async function deleteAgent(slug) {
  if (!confirm(`确定删除代理 "${slug}"？`)) return;
  try {
    const res = await fetch(`/api/agents/${slug}`, { method: 'DELETE' });
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || '删除失败');
    }
    await loadAgents();
    showToast('代理已删除');
  } catch (err) {
    showToast('删除失败: ' + err.message, true);
  }
}

async function viewAgent(slug) {
  try {
    const res = await fetch(`/api/agents/${slug}`);
    if (!res.ok) throw new Error('获取代理失败');
    const agent = await res.json();
    const catLabels = { system: '系统级', preset: '预设', user: '用户' };
    const catColors = { system: 'var(--error)', preset: 'var(--warning)', user: 'var(--success)' };
    const roleLabels = { readonly: '只读', writer: '读写', full: '完全' };

    document.getElementById('agent-view-title').textContent = agent.name;
    document.getElementById('agent-view-color').style.background = agent.color || '#6B7280';
    const badge = document.getElementById('agent-view-badge');
    badge.textContent = catLabels[agent.category] || agent.category;
    badge.style.background = catColors[agent.category] || '#666';
    badge.style.color = '#fff';
    document.getElementById('agent-view-role').textContent = `默认权限: ${roleLabels[agent.defaultRole] || agent.defaultRole} (${agent.defaultRole})`;
    document.getElementById('agent-view-desc').textContent = agent.description || '';

    const rawHtml = typeof marked !== 'undefined' ? marked.parse(agent.body) : formatAssistantContent(agent.body);
    const contentHtml = typeof DOMPurify !== 'undefined' ? DOMPurify.sanitize(rawHtml) : rawHtml;
    document.getElementById('agent-view-body').innerHTML = contentHtml;
    showModal('agent-view-modal');
  } catch (err) {
    showToast('加载失败: ' + err.message, true);
  }
}

function closeAgentViewModal() {
  hideModal('agent-view-modal');
}

async function reloadAgents() {
  try {
    await fetch('/api/agents/reload', { method: 'POST' });
    await loadAgents();
    showToast('代理已重载');
  } catch (err) {
    showToast('重载失败: ' + err.message, true);
  }
}

// ==================== 执行策略 ====================

async function loadExecPolicy() {
  try {
    const statsEl = document.getElementById('exec-policy-stats');
    const rulesEl = document.getElementById('exec-policy-user-rules');
    const listEl = document.getElementById('exec-policy-rules-list');
    if (!statsEl) return;

    const policyRes = await fetch('/api/exec-policy');
    if (!policyRes.ok) { statsEl.textContent = '加载失败'; return; }
    const data = await policyRes.json();
    const d = data.default || {};
    const u = data.user || {};

    const len = arr => (Array.isArray(arr) ? arr : []).length;
    statsEl.innerHTML = `<div style="display:flex;gap:16px;flex-wrap:wrap">
      <span>默认规则: <b>${len(d.allow) + len(d.prompt) + len(d.forbidden)}</b></span>
      <span style="color:var(--success,#22c55e)">Allow: ${len(d.allow)}</span>
      <span style="color:var(--accent)">Prompt: ${len(d.prompt)}</span>
      <span style="color:var(--error,#ef4444)">Forbidden: ${len(d.forbidden)}</span>
    </div>
    <div style="display:flex;gap:16px;flex-wrap:wrap;margin-top:4px">
      <span>自定义规则: <b>${len(u.allow) + len(u.prompt) + len(u.forbidden)}</b></span>
      <span style="color:var(--success,#22c55e)">Allow: ${len(u.allow)}</span>
      <span style="color:var(--accent)">Prompt: ${len(u.prompt)}</span>
      <span style="color:var(--error,#ef4444)">Forbidden: ${len(u.forbidden)}</span>
    </div>`;

    // 显示用户自定义规则
    const userRules = data.user || { allow: [], prompt: [], forbidden: [] };
    const allUserRules = [
      ...userRules.allow.map(r => ({ ...r, category: 'allow' })),
      ...userRules.prompt.map(r => ({ ...r, category: 'prompt' })),
      ...userRules.forbidden.map(r => ({ ...r, category: 'forbidden' })),
    ];

    if (rulesEl && listEl) {
      if (allUserRules.length > 0) {
        rulesEl.style.display = '';
        const catColors = { allow: 'var(--success,#22c55e)', prompt: 'var(--accent)', forbidden: 'var(--error,#ef4444)' };
        listEl.innerHTML = allUserRules.map(r =>
          `<div style="display:flex;align-items:center;justify-content:space-between;padding:6px 12px;border-bottom:1px solid var(--border-subtle);font-size:12px">
            <div style="display:flex;align-items:center;gap:8px;min-width:0">
              <span style="font-size:10px;padding:1px 5px;border-radius:var(--radius-full);background:${catColors[r.category]}20;color:${catColors[r.category]};flex-shrink:0">${r.category}</span>
              <code style="font-family:var(--font-mono);font-size:12px">${escapeHtml(r.pattern)}</code>
              ${r.description ? `<span style="color:var(--text-muted);font-size:11px">${escapeHtml(r.description)}</span>` : ''}
            </div>
            <button class="exec-policy-remove-btn" data-category="${encodeURIComponent(r.category)}" data-pattern="${encodeURIComponent(r.pattern)}" style="background:none;border:none;color:var(--text-muted);cursor:pointer;font-size:14px;padding:2px 6px" title="删除">×</button>
          </div>`
        ).join('');
      } else {
        rulesEl.style.display = 'none';
      }
    }

    // 渲染默认规则列表
    renderDefaultRules(data);
  } catch (err) {
    console.error('loadExecPolicy error:', err);
  }
}

async function testExecPolicy() {
  const input = document.getElementById('exec-policy-test-input');
  const resultEl = document.getElementById('exec-policy-test-result');
  if (!input || !resultEl) return;
  const cmd = input.value.trim();
  if (!cmd) return;

  try {
    const res = await fetch('/api/exec-policy/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command: cmd }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const colors = { allow: 'var(--success,#22c55e)', prompt: 'var(--accent)', forbidden: 'var(--error,#ef4444)' };
    const labels = { allow: 'Allow — 直接执行', prompt: 'Prompt — 需确认', forbidden: 'Forbidden — 禁止' };
    resultEl.style.display = '';
    resultEl.style.background = `${colors[data.decision]}15`;
    resultEl.style.border = `1px solid ${colors[data.decision]}40`;
    resultEl.innerHTML = `<span style="color:${colors[data.decision]};font-weight:600">${labels[data.decision] || data.decision}</span>
      ${data.matchedRule ? `<span style="color:var(--text-muted);margin-left:8px">匹配规则: <code>${escapeHtml(data.matchedRule)}</code></span>` : ''}
      ${data.description ? `<span style="color:var(--text-muted);margin-left:8px">${escapeHtml(data.description)}</span>` : ''}`;
  } catch (err) {
    resultEl.style.display = '';
    resultEl.style.background = 'var(--error,#ef4444)15';
    resultEl.textContent = '测试失败: ' + err.message;
  }
}

async function removeExecPolicyRule(category, pattern) {
  try {
    const res = await fetch('/api/exec-policy/rule', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ category, pattern }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    showToast('规则已删除');
    loadExecPolicy();
  } catch (err) {
    showToast('删除失败: ' + err.message, true);
  }
}

// 事件委托：删除规则按钮
document.addEventListener('click', (e) => {
  const btn = e.target.closest('.exec-policy-remove-btn');
  if (!btn) return;
  const category = decodeURIComponent(btn.dataset.category || '');
  const pattern = decodeURIComponent(btn.dataset.pattern || '');
  if (category && pattern) removeExecPolicyRule(category, pattern);
});

async function addExecPolicyRule() {
  const category = document.getElementById('exec-policy-add-category').value;
  const pattern = document.getElementById('exec-policy-add-pattern').value.trim();
  const desc = document.getElementById('exec-policy-add-desc').value.trim();
  if (!pattern) { showToast('请输入命令模式', true); return; }

  try {
    const res = await fetch('/api/exec-policy/rule', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ category, pattern, description: desc }),
    });
    const data = await res.json();
    if (!res.ok) { throw new Error(data.error || `HTTP ${res.status}`); }
    showToast('规则已添加');
    document.getElementById('exec-policy-add-pattern').value = '';
    document.getElementById('exec-policy-add-desc').value = '';
    loadExecPolicy();
  } catch (err) {
    showToast('添加失败: ' + err.message, true);
  }
}

// 默认规则搜索过滤缓存
let _defaultRulesData = null;

const _catColors = { allow: 'var(--success,#22c55e)', prompt: 'var(--accent)', forbidden: 'var(--error,#ef4444)' };
const _catLabels = { allow: 'Allow', prompt: 'Prompt', forbidden: 'Forbidden' };

function _renderRuleItemsHTML(rules) {
  return rules.map(r =>
    `<div class="exec-policy-default-rule" style="display:flex;align-items:center;gap:8px;padding:4px 12px;border-bottom:1px solid var(--border-subtle);font-size:12px">
      <span style="font-size:10px;padding:1px 5px;border-radius:var(--radius-full);background:${_catColors[r.category]}20;color:${_catColors[r.category]};flex-shrink:0">${_catLabels[r.category]}</span>
      <code style="font-family:var(--font-mono);font-size:12px;white-space:nowrap">${escapeHtml(r.pattern)}</code>
      ${r.description ? `<span style="color:var(--text-muted);font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(r.description)}</span>` : ''}
    </div>`
  ).join('');
}

function renderDefaultRules(data) {
  const container = document.getElementById('exec-policy-default-rules');
  if (!container) return;

  const d = (data && data.default) || {};
  const categories = ['forbidden', 'prompt', 'allow'];
  const allRules = [];
  for (const cat of categories) {
    const rules = Array.isArray(d[cat]) ? d[cat] : [];
    for (const r of rules) {
      allRules.push({ ...r, category: cat });
    }
  }

  _defaultRulesData = allRules;
  container.innerHTML = _renderRuleItemsHTML(allRules);
}

// 默认规则搜索
document.addEventListener('DOMContentLoaded', () => {
  const searchInput = document.getElementById('exec-policy-default-search');
  if (searchInput) {
    searchInput.addEventListener('input', () => {
      if (!_defaultRulesData) return;
      const q = searchInput.value.toLowerCase().trim();
      const filtered = q ? _defaultRulesData.filter(r => r.pattern.toLowerCase().includes(q) || (r.description && r.description.toLowerCase().includes(q))) : _defaultRulesData;
      const container = document.getElementById('exec-policy-default-rules');
      if (!container) return;
      container.innerHTML = _renderRuleItemsHTML(filtered);
    });
  }
});

// ==================== 任务管理 ====================

let tasksData = [];
let taskProgressMap = new Map(); // taskId → { round, lastTool, snippet }

async function loadTasks() {
  try {
    const res = await fetch('/api/tasks');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    tasksData = data.tasks || [];
    filterTasks();
  } catch (err) {
    showToast('加载任务失败: ' + err.message, true);
  }
}

function filterTasks() {
  renderTasks();
}

function getFilteredTasks() {
  const search = (document.getElementById('task-search')?.value || '').toLowerCase();
  const status = document.getElementById('task-status-filter')?.value || '';
  return tasksData.filter(t => {
    if (status && t.status !== status) return false;
    if (search && !t.objective.toLowerCase().includes(search) && !(t.summary || '').toLowerCase().includes(search)) return false;
    return true;
  });
}

function renderTasks() {
  const list = document.getElementById('tasks-list');
  const empty = document.getElementById('tasks-empty');
  const statsEl = document.getElementById('tasks-stats');
  if (!list) return;

  // 统计
  const counts = { running: 0, completed: 0, failed: 0, stopped: 0 };
  tasksData.forEach(t => { if (counts[t.status] !== undefined) counts[t.status]++; });
  const totalDuration = tasksData.filter(t => t.startedAt && t.endedAt)
    .reduce((sum, t) => sum + (t.endedAt - t.startedAt), 0);
  const avgDuration = tasksData.filter(t => t.startedAt && t.endedAt).length > 0
    ? (totalDuration / tasksData.filter(t => t.startedAt && t.endedAt).length / 1000).toFixed(1) + 's'
    : '-';

  if (statsEl) {
    statsEl.innerHTML = [
      { label: '运行中', value: counts.running, color: 'var(--accent)' },
      { label: '已完成', value: counts.completed, color: 'var(--success, #22c55e)' },
      { label: '失败', value: counts.failed, color: 'var(--error, #ef4444)' },
      { label: '平均耗时', value: avgDuration, color: 'var(--text-secondary)' },
    ].map(s => `<div style="background:var(--bg-surface);border:1px solid var(--border-default);border-radius:var(--radius-md);padding:12px 16px;text-align:center">
      <div style="font-size:22px;font-weight:600;color:${s.color}">${s.value}</div>
      <div style="font-size:11px;color:var(--text-muted);margin-top:2px">${s.label}</div>
    </div>`).join('');
  }

  // 更新导航徽标
  const badge = document.getElementById('nav-task-count');
  if (badge) {
    badge.textContent = counts.running;
    badge.style.display = counts.running > 0 ? '' : 'none';
  }

  const filtered = getFilteredTasks();
  if (filtered.length === 0) {
    list.style.display = 'none';
    if (empty) { empty.style.display = ''; empty.textContent = tasksData.length > 0 ? '无匹配任务' : '暂无任务记录'; }
    return;
  }
  list.style.display = '';
  if (empty) empty.style.display = 'none';

  const statusColors = { created: 'var(--text-muted)', running: 'var(--accent)', completed: 'var(--success, #22c55e)', failed: 'var(--error, #ef4444)', stopped: 'var(--text-muted)' };
  const statusLabels = { created: '已创建', running: '运行中', completed: '已完成', failed: '已失败', stopped: '已停止' };

  list.innerHTML = filtered.map(t => {
    const color = statusColors[t.status] || 'var(--text-muted)';
    const label = statusLabels[t.status] || t.status;
    const duration = t.startedAt && t.endedAt ? ((t.endedAt - t.startedAt) / 1000).toFixed(1) + 's' : t.startedAt ? '进行中...' : '-';
    const role = t.role && t.role !== 'full' ? `<span class="task-role-badge">${t.role}</span>` : '';
    const agentBadge = t.agent ? `<span class="task-role-badge" style="background:var(--accent-subtle);color:var(--accent)">${t.agent}</span>` : '';
    const progress = taskProgressMap.get(t.id);
    const progressLine = progress && t.status === 'running'
      ? `<div style="font-size:11px;color:var(--accent);padding-left:16px;font-family:var(--font-mono)">轮次 ${progress.round} · ${progress.lastTool}</div>` : '';
    const timeStr = t.startedAt ? new Date(t.startedAt).toLocaleString('zh-CN', { hour12: false }) : '-';

    return `<div class="task-card" data-task-id="${t.id}" onclick="toggleTaskDetail('${t.id}')">
      <div style="display:flex;align-items:center;gap:8px;min-width:0;flex:1">
        <span style="width:8px;height:8px;border-radius:50%;background:${color};flex-shrink:0${t.status === 'running' ? ';animation:pulse 1.5s infinite' : ''}"></span>
        <span style="font-size:13px;font-weight:500;color:var(--text-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1">${escapeHtml(t.objective)}</span>
        ${role}${agentBadge}
      </div>
      <div style="display:flex;align-items:center;gap:12px;flex-shrink:0;margin-left:8px">
        <span style="font-size:11px;color:${color};white-space:nowrap">${label}</span>
        <span style="font-size:11px;color:var(--text-muted);white-space:nowrap">${duration}</span>
        ${t.status === 'running' ? `<button class="btn btn-secondary" style="font-size:11px;padding:2px 8px" onclick="event.stopPropagation();stopTaskFromList('${t.id}')">停止</button>` : ''}
      </div>
    </div>
    <div class="task-detail task-detail-md" id="task-detail-${t.id}" style="display:none">
      ${t.summary ? `<div style="margin-bottom:8px">${formatAssistantContent(t.summary)}</div>` : ''}
      ${t.error ? `<div style="margin-bottom:8px;padding:8px 10px;background:rgba(239,68,68,0.08);border-radius:var(--radius-sm);border-left:3px solid var(--error, #ef4444)"><div style="font-size:11px;color:var(--error, #ef4444);margin-bottom:4px">错误</div><div style="font-size:12px;color:var(--text-secondary)">${formatAssistantContent(t.error)}</div></div>` : ''}
      ${t.result && t.result !== t.summary ? `<div style="margin-bottom:8px"><div style="font-size:11px;color:var(--text-muted);margin-bottom:4px">详细结果</div><div style="max-height:300px;overflow-y:auto">${formatAssistantContent(t.result.slice(0, 5000))}</div></div>` : ''}
      ${progressLine}
      <div style="display:flex;gap:16px;flex-wrap:wrap;margin-top:4px;padding-top:6px;border-top:1px solid var(--border-subtle)">
        <span style="font-size:11px;color:var(--text-muted)">ID: ${t.id}</span>
        <span style="font-size:11px;color:var(--text-muted)">权限: ${t.role || 'full'}</span>
        ${t.agent ? `<span style="font-size:11px;color:var(--text-muted)">代理: ${escapeHtml(t.agent)}</span>` : ''}
        <span style="font-size:11px;color:var(--text-muted)">创建: ${timeStr}</span>
        <span style="font-size:11px;color:var(--text-muted)">耗时: ${duration}</span>
      </div>
    </div>`;
  }).join('');
}

function toggleTaskDetail(taskId) {
  const el = document.getElementById('task-detail-' + taskId);
  if (el) el.style.display = el.style.display === 'none' ? '' : 'none';
}

async function stopTaskFromList(taskId) {
  try {
    const res = await fetch(`/api/tasks/${taskId}/stop`, { method: 'POST' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    showToast('任务已停止');
    loadTasks();
  } catch (err) {
    showToast('停止失败: ' + err.message, true);
  }
}

async function clearCompletedTasks() {
  const completed = tasksData.filter(t => ['completed', 'failed', 'stopped'].includes(t.status));
  if (completed.length === 0) { showToast('没有可清理的任务'); return; }
  if (!confirm(`确认清理 ${completed.length} 个已完成/失败/停止的任务？`)) return;
  try {
    await Promise.all(completed.map(t => fetch(`/api/tasks/${t.id}`, { method: 'DELETE' }).catch(() => {})));
    showToast(`已清理 ${completed.length} 个任务`);
    loadTasks();
  } catch (err) {
    showToast('清理失败: ' + err.message, true);
  }
}

// 实时更新任务列表（WebSocket）
function onTaskEvent(task) {
  const idx = tasksData.findIndex(t => t.id === task.id);
  if (idx >= 0) {
    tasksData[idx] = { ...tasksData[idx], ...task };
    if (currentPage === 'tasks') renderTasks();
  } else {
    // 新任务加入列表
    tasksData.unshift(task);
    if (currentPage === 'tasks') renderTasks();
  }
  // 更新导航徽标
  const running = tasksData.filter(t => t.status === 'running').length;
  const badge = document.getElementById('nav-task-count');
  if (badge) {
    badge.textContent = running;
    badge.style.display = running > 0 ? '' : 'none';
  }
}

function onTaskProgressEvent(taskId, progress) {
  taskProgressMap.set(taskId, progress);
  if (currentPage === 'tasks') renderTasks();
}

// ==================== MCP 服务管理 ====================

let mcpServersData = [];
let mcpPresetsData = [];
let mcpPresetsCollapsed = true;
let mcpServersListCollapsed = false;
let mcpToolStatsCollapsed = true;
let editingMcpName = '';

async function loadMcpServers() {
  try {
    const res = await fetch('/api/mcp/servers');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    mcpServersData = await res.json();
    renderMcpServers();
    const navBadge = document.getElementById('nav-mcp-count');
    if (navBadge) navBadge.textContent = mcpServersData.length;
  } catch (err) {
    document.getElementById('mcp-servers-container').innerHTML = `<div style="color:var(--error);padding:20px">加载失败: ${escapeHtml(err.message)}</div>`;
  }
  loadMcpPresets();
  loadMcpToolStats();
}

async function loadMcpPresets() {
  try {
    const res = await fetch('/api/mcp/presets');
    if (!res.ok) return;
    mcpPresetsData = await res.json();
    renderMcpPresets();
  } catch {}
}

function renderMcpPresets() {
  const section = document.getElementById('mcp-presets-section');
  const container = document.getElementById('mcp-presets-container');
  if (!section || !container || !mcpPresetsData.length) {
    if (section) section.style.display = 'none';
    return;
  }
  section.style.display = '';
  container.style.display = mcpPresetsCollapsed ? 'none' : '';

  container.innerHTML = `<div class="skills-grid">${mcpPresetsData.map(p => {
    const added = p.added;
    return `<div class="skill-card" style="opacity:${added ? '0.5' : '1'}">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px">
        <strong style="font-size:14px">${escapeHtml(p.name)}</strong>
        ${added ? '<span class="skill-badge" style="background:var(--success-subtle);color:var(--success);font-size:11px;padding:1px 6px">已添加</span>' : ''}
      </div>
      <div style="font-size:12px;color:var(--text-muted);margin-bottom:8px;line-height:1.4">${escapeHtml(p.description)}</div>
      <div style="font-size:11px;color:var(--text-muted);margin-bottom:8px">${escapeHtml((p.args || []).join(' '))}</div>
      ${added ? '' : `<button class="btn btn-sm btn-primary" onclick="addMcpPreset('${escapeAttr(p.name)}')">添加</button>`}
    </div>`;
  }).join('')}</div>`;
}

function toggleMcpPresets() {
  mcpPresetsCollapsed = !mcpPresetsCollapsed;
  const container = document.getElementById('mcp-presets-container');
  const toggle = document.getElementById('mcp-presets-toggle');
  if (container) container.style.display = mcpPresetsCollapsed ? 'none' : '';
  if (toggle) toggle.textContent = mcpPresetsCollapsed ? '▶' : '▼';
}

function toggleMcpServersList() {
  mcpServersListCollapsed = !mcpServersListCollapsed;
  const container = document.getElementById('mcp-servers-container');
  const toggle = document.getElementById('mcp-servers-toggle');
  if (container) container.style.display = mcpServersListCollapsed ? 'none' : '';
  if (toggle) toggle.textContent = mcpServersListCollapsed ? '▶' : '▼';
}

async function addMcpPreset(name) {
  const preset = mcpPresetsData.find(p => p.name === name);
  if (!preset) return;
  try {
    const res = await fetch('/api/mcp/servers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: preset.name,
        command: preset.command,
        args: preset.args,
        env: preset.env,
        enabled: true,
      }),
    });
    if (!res.ok) {
      const data = await res.json();
      alert(data.error || '添加失败');
      return;
    }
    await loadMcpServers();
  } catch (err) {
    alert('添加失败: ' + err.message);
  }
}

async function loadMcpToolStats() {
  try {
    const res = await fetch('/api/mcp/tool-stats');
    if (!res.ok) return;
    renderMcpToolStats(await res.json());
  } catch {}
}

function toggleMcpToolStats() {
  mcpToolStatsCollapsed = !mcpToolStatsCollapsed;
  const container = document.getElementById('mcp-tool-stats-container');
  const toggle = document.getElementById('mcp-tool-stats-toggle');
  if (container) container.style.display = mcpToolStatsCollapsed ? 'none' : '';
  if (toggle) toggle.textContent = mcpToolStatsCollapsed ? '▶' : '▼';
}

function renderMcpToolStats(data) {
  const section = document.getElementById('mcp-tool-stats-section');
  const container = document.getElementById('mcp-tool-stats-container');
  if (!section || !container) return;
  if (!data.total.calls) { section.style.display = 'none'; return; }
  section.style.display = '';
  container.style.display = mcpToolStatsCollapsed ? 'none' : '';

  const t = data.total;
  let html = `<div style="display:flex;gap:24px;margin-bottom:16px;flex-wrap:wrap">
    <div class="panel" style="flex:1;min-width:140px;padding:12px 16px">
      <div style="font-size:12px;color:var(--text-muted)">总调用</div>
      <div style="font-size:20px;font-weight:600">${t.calls}</div>
    </div>
    <div class="panel" style="flex:1;min-width:140px;padding:12px 16px">
      <div style="font-size:12px;color:var(--text-muted)">成功率</div>
      <div style="font-size:20px;font-weight:600;color:${t.successRate >= 90 ? 'var(--success)' : t.successRate >= 70 ? 'var(--warning)' : 'var(--error)'}">${t.successRate}%</div>
    </div>
    <div class="panel" style="flex:1;min-width:140px;padding:12px 16px">
      <div style="font-size:12px;color:var(--text-muted)">平均延迟</div>
      <div style="font-size:20px;font-weight:600">${t.avgLatency}ms</div>
    </div>
    <div class="panel" style="flex:1;min-width:140px;padding:12px 16px">
      <div style="font-size:12px;color:var(--text-muted)">成功 / 失败</div>
      <div style="font-size:20px;font-weight:600"><span style="color:var(--success)">${t.success}</span> / <span style="color:var(--error)">${t.fail}</span></div>
    </div>
  </div>`;

  if (data.byServer.length) {
    html += `<div style="font-size:13px;font-weight:500;margin-bottom:8px;color:var(--text)">按服务器</div>`;
    html += `<table class="table" style="margin-bottom:16px"><thead><tr>
      <th>服务器</th><th>调用次数</th><th>成功率</th><th>平均延迟</th><th>近 24h</th>
    </tr></thead><tbody>`;
    for (const s of data.byServer) {
      html += `<tr>
        <td><code>${escapeHtml(s.server)}</code></td>
        <td class="num">${s.calls}</td>
        <td style="color:${s.successRate >= 90 ? 'var(--success)' : s.successRate >= 70 ? 'var(--warning)' : 'var(--error)'}">${s.successRate}%</td>
        <td class="num">${s.avgLatency}ms</td>
        <td class="num">${s.recentCalls}</td>
      </tr>`;
    }
    html += `</tbody></table>`;
  }

  if (data.byTool.length) {
    html += `<div style="font-size:13px;font-weight:500;margin-bottom:8px;color:var(--text)">按工具 <span style="font-weight:400;color:var(--text-muted)">(Top 20)</span></div>`;
    html += `<table class="table"><thead><tr>
      <th>服务器</th><th>工具</th><th>调用次数</th><th>成功率</th><th>平均延迟</th>
    </tr></thead><tbody>`;
    for (const t of data.byTool.slice(0, 20)) {
      html += `<tr>
        <td><code>${escapeHtml(t.server)}</code></td>
        <td><code style="font-size:12px">${escapeHtml(t.tool)}</code></td>
        <td class="num">${t.calls}</td>
        <td style="color:${t.successRate >= 90 ? 'var(--success)' : t.successRate >= 70 ? 'var(--warning)' : 'var(--error)'}">${t.successRate}%</td>
        <td class="num">${t.avgLatency}ms</td>
      </tr>`;
    }
    html += `</tbody></table>`;
  }

  container.innerHTML = html;
}

function renderMcpServers() {
  const container = document.getElementById('mcp-servers-container');
  if (!mcpServersData.length) {
    container.innerHTML = `<div style="text-align:center;padding:40px;color:var(--text-muted)">
      <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="margin-bottom:12px;opacity:0.4"><path d="M12 22c5.523 0 10-4.477 10-10S17.523 2 12 2 2 6.477 2 12s4.477 10 10 10z"></path><path d="M12 18a6 6 0 1 0 0-12 6 6 0 0 0 0 12z"></path><path d="M12 14a2 2 0 1 0 0-4 2 2 0 0 0 0 4z"></path></svg>
      <p>暂无 MCP 服务配置</p>
      <p style="font-size:13px">点击上方「添加 MCP 服务」开始</p>
    </div>`;
    return;
  }

  container.innerHTML = `<div class="skills-grid">${mcpServersData.map(s => {
    const statusColors = { connected: 'var(--success)', connecting: 'var(--warning)', error: 'var(--error)', disconnected: 'var(--text-muted)' };
    const statusTexts = { connected: '已连接', connecting: '连接中...', error: '错误', disconnected: '已断开' };
    const color = statusColors[s.status] || 'var(--text-muted)';
    const statusText = statusTexts[s.status] || s.status;
    const transportBadge = s.transport === 'http' ? '<span class="skill-badge" style="background:var(--accent-subtle);color:var(--accent);font-size:11px;padding:1px 6px">HTTP</span>' : '<span class="skill-badge" style="background:var(--success-subtle);color:var(--success);font-size:11px;padding:1px 6px">stdio</span>';

    return `<div class="skill-card" data-mcp-name="${escapeHtml(s.name)}">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">
        <div style="display:flex;align-items:center;gap:8px">
          <span style="width:10px;height:10px;border-radius:50%;background:${color};display:inline-block;flex-shrink:0"></span>
          <strong style="font-size:15px">${escapeHtml(s.name)}</strong>
          ${transportBadge}
          ${!s.enabled ? '<span class="skill-badge" style="background:var(--text-muted);color:#fff;font-size:11px;padding:1px 6px">已禁用</span>' : ''}
        </div>
        <span style="font-size:12px;color:${color}">${statusText}</span>
      </div>
      <div style="font-size:12px;color:var(--text-muted);margin-bottom:8px">
        ${s.transport === 'stdio' ? escapeHtml(s.command || '') : escapeHtml(s.url || '')}
        ${s.tools ? ` · ${s.tools.length} 个工具` : ''}
        ${s.lastError ? `<br><span style="color:var(--error)">${escapeHtml(s.lastError)}</span>` : ''}
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        ${s.status === 'connected' ? `<button class="btn btn-sm" onclick="disconnectMcpServer('${escapeAttr(s.name)}')">断开</button>` : `<button class="btn btn-sm btn-primary" onclick="connectMcpServer('${escapeAttr(s.name)}')">连接</button>`}
        ${s.tools && s.tools.length ? `<button class="btn btn-sm" onclick="viewMcpTools('${escapeAttr(s.name)}')">查看工具</button>` : ''}
        <button class="btn btn-sm" onclick="editMcpServer('${escapeAttr(s.name)}')">编辑</button>
        <button class="btn btn-sm" style="color:var(--error)" onclick="deleteMcpServer('${escapeAttr(s.name)}')">删除</button>
      </div>
    </div>`;
  }).join('')}</div>`;
}

function toggleMcpTransport() {
  const val = document.querySelector('input[name="mcp-transport"]:checked').value;
  document.getElementById('mcp-stdio-fields').style.display = val === 'stdio' ? '' : 'none';
  document.getElementById('mcp-http-fields').style.display = val === 'http' ? '' : 'none';
}

function addMcpEnvRow(key, value) {
  const editor = document.getElementById('mcp-env-editor');
  const row = document.createElement('div');
  row.style.cssText = 'display:flex;gap:6px;margin-bottom:4px;align-items:center';
  row.innerHTML = `<input type="text" placeholder="KEY" style="flex:1;font-size:12px;padding:4px 8px" class="mcp-env-key" value="${escapeAttr(key || '')}"> <input type="text" placeholder="value" style="flex:1;font-size:12px;padding:4px 8px" class="mcp-env-val" value="${escapeAttr(value || '')}"> <button class="btn btn-sm" style="color:var(--error);padding:2px 6px" onclick="this.parentElement.remove()">&times;</button>`;
  editor.appendChild(row);
}

function addMcpHeaderRow(key, value) {
  const editor = document.getElementById('mcp-headers-editor');
  const row = document.createElement('div');
  row.style.cssText = 'display:flex;gap:6px;margin-bottom:4px;align-items:center';
  row.innerHTML = `<input type="text" placeholder="Header-Name" style="flex:1;font-size:12px;padding:4px 8px" class="mcp-header-key" value="${escapeAttr(key || '')}"> <input type="text" placeholder="value" style="flex:1;font-size:12px;padding:4px 8px" class="mcp-header-val" value="${escapeAttr(value || '')}"> <button class="btn btn-sm" style="color:var(--error);padding:2px 6px" onclick="this.parentElement.remove()">&times;</button>`;
  editor.appendChild(row);
}

function collectMcpKvPairs(containerId, keyClass, valClass) {
  const result = {};
  document.querySelectorAll(`#${containerId} .${keyClass}`).forEach((input, i) => {
    const key = input.value.trim();
    const val = input.closest('div').querySelector(`.${valClass}`).value;
    if (key) result[key] = val;
  });
  return result;
}

function showMcpModal(name) {
  editingMcpName = name || '';
  document.getElementById('mcp-modal-title').textContent = name ? '编辑 MCP 服务' : '添加 MCP 服务';
  document.getElementById('mcp-name').value = name || '';
  document.getElementById('mcp-name').disabled = !!name;
  document.getElementById('mcp-command').value = '';
  document.getElementById('mcp-args').value = '';
  document.getElementById('mcp-url').value = '';
  document.getElementById('mcp-enabled').checked = true;
  document.getElementById('mcp-env-editor').innerHTML = '';
  document.getElementById('mcp-headers-editor').innerHTML = '';
  document.getElementById('mcp-timeout').value = '';
  document.getElementById('mcp-dangerous').checked = false;
  document.querySelector('input[name="mcp-transport"][value="stdio"]').checked = true;
  toggleMcpTransport();

  if (name) {
    const s = mcpServersData.find(x => x.name === name);
    if (s) {
      document.getElementById('mcp-enabled').checked = s.enabled !== false;
      document.getElementById('mcp-dangerous').checked = !!s.dangerous;
      if (s.transport === 'http') {
        document.querySelector('input[name="mcp-transport"][value="http"]').checked = true;
        toggleMcpTransport();
        // 从 config 获取 url/headers
        fetch(`/api/mcp/servers/${encodeURIComponent(name)}`).then(r => r.json()).then(detail => {
          if (detail.config?.url) document.getElementById('mcp-url').value = detail.config.url;
          if (detail.config?.headers) {
            Object.entries(detail.config.headers).forEach(([k, v]) => addMcpHeaderRow(k, v));
          }
          if (detail.config?.toolCallTimeoutMs) document.getElementById('mcp-timeout').value = Math.round(detail.config.toolCallTimeoutMs / 1000);
        });
      } else {
        fetch(`/api/mcp/servers/${encodeURIComponent(name)}`).then(r => r.json()).then(detail => {
          if (detail.config?.command) document.getElementById('mcp-command').value = detail.config.command;
          if (detail.config?.args) document.getElementById('mcp-args').value = (Array.isArray(detail.config.args) ? detail.config.args : [detail.config.args]).join(' ');
          if (detail.config?.env) {
            Object.entries(detail.config.env).forEach(([k, v]) => addMcpEnvRow(k, v));
          }
          if (detail.config?.toolCallTimeoutMs) document.getElementById('mcp-timeout').value = Math.round(detail.config.toolCallTimeoutMs / 1000);
        });
      }
    }
  }
  showModal('mcp-modal');
}

function closeMcpModal() {
  hideModal('mcp-modal');
  editingMcpName = '';
}

async function saveMcpServer() {
  const name = document.getElementById('mcp-name').value.trim();
  if (!name) return showToast('请输入服务名称', true);
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) return showToast('名称只能包含英文、数字、连字符、下划线', true);

  const transport = document.querySelector('input[name="mcp-transport"]:checked').value;
  const enabled = document.getElementById('mcp-enabled').checked;
  const body = { name, enabled };

  if (transport === 'stdio') {
    body.command = document.getElementById('mcp-command').value.trim();
    if (!body.command) return showToast('请输入命令', true);
    const argsStr = document.getElementById('mcp-args').value.trim();
    if (argsStr) body.args = argsStr.split(/\s+/);
    const env = collectMcpKvPairs('mcp-env-editor', 'mcp-env-key', 'mcp-env-val');
    if (Object.keys(env).length) body.env = env;
  } else {
    body.url = document.getElementById('mcp-url').value.trim();
    if (!body.url) return showToast('请输入 URL', true);
    const headers = collectMcpKvPairs('mcp-headers-editor', 'mcp-header-key', 'mcp-header-val');
    if (Object.keys(headers).length) body.headers = headers;
  }

  const timeoutVal = document.getElementById('mcp-timeout').value.trim();
  if (timeoutVal) body.toolCallTimeoutMs = parseInt(timeoutVal, 10) * 1000;
  body.dangerous = document.getElementById('mcp-dangerous').checked;

  try {
    const url = editingMcpName ? `/api/mcp/servers/${encodeURIComponent(editingMcpName)}` : '/api/mcp/servers';
    const method = editingMcpName ? 'PUT' : 'POST';
    const res = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const data = await res.json();
    if (!res.ok) return showToast(data.error || '操作失败', true);
    showToast(editingMcpName ? '已更新' : '已添加');
    closeMcpModal();
    loadMcpServers();
  } catch (err) {
    showToast('操作失败: ' + err.message, true);
  }
}

async function deleteMcpServer(name) {
  if (!await showConfirm(`确定删除 MCP 服务「${escapeHtml(name)}」？`)) return;
  try {
    const res = await fetch(`/api/mcp/servers/${encodeURIComponent(name)}`, { method: 'DELETE' });
    if (!res.ok) { const d = await res.json(); return showToast(d.error || '删除失败', true); }
    showToast('已删除');
    loadMcpServers();
  } catch (err) {
    showToast('删除失败: ' + err.message, true);
  }
}

async function connectMcpServer(name) {
  try {
    const res = await fetch(`/api/mcp/servers/${encodeURIComponent(name)}/connect`, { method: 'POST' });
    const data = await res.json();
    if (!res.ok) return showToast(data.error || '连接失败', true);
    showToast(`已连接 ${name}`);
    loadMcpServers();
  } catch (err) {
    showToast('连接失败: ' + err.message, true);
  }
}

async function disconnectMcpServer(name) {
  try {
    await fetch(`/api/mcp/servers/${encodeURIComponent(name)}/disconnect`, { method: 'POST' });
    showToast(`已断开 ${name}`);
    loadMcpServers();
  } catch (err) {
    showToast('断开失败: ' + err.message, true);
  }
}

function editMcpServer(name) {
  showMcpModal(name);
}

async function viewMcpTools(name) {
  try {
    const res = await fetch(`/api/mcp/servers/${encodeURIComponent(name)}`);
    const data = await res.json();
    const tools = data.tools || [];
    document.getElementById('mcp-tools-title').textContent = `${name} 的工具列表`;
    const container = document.getElementById('mcp-tools-list');
    if (!tools.length) {
      container.innerHTML = '<div style="color:var(--text-muted);text-align:center;padding:20px">暂无工具</div>';
    } else {
      container.innerHTML = tools.map(t => `<div style="padding:10px;border:1px solid var(--border);border-radius:6px;margin-bottom:8px">
        <div style="font-weight:600;font-size:13px;margin-bottom:4px"><code>mcp__${escapeHtml(sanitizeName(name))}__${escapeHtml(t.name)}</code></div>
        <div style="font-size:12px;color:var(--text-muted)">${escapeHtml(t.description || '')}</div>
      </div>`).join('');
    }
    showModal('mcp-tools-modal');
  } catch (err) {
    showToast('加载工具失败: ' + err.message, true);
  }
}

function closeMcpToolsModal() {
  hideModal('mcp-tools-modal');
}

function sanitizeName(name) {
  return name.replace(/[^a-zA-Z0-9_-]/g, '_').replace(/-/g, '_');
}

function updateMcpServerStatus(serverName, statusData) {
  const idx = mcpServersData.findIndex(s => s.name === serverName);
  if (idx >= 0) {
    Object.assign(mcpServersData[idx], statusData);
    if (currentPage === 'mcp-servers') renderMcpServers();
  }
}

function escapeAttr(str) {
  return String(str).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ==================== Memory Management ====================

let _memoryData = {};
let _memoryEntryMode = null; // 'add' | 'edit'
let _memoryEntryType = null; // 'memory' | 'user'
let _memoryEntryIdx = -1;

function loadMemoryPage() {
  fetch('/api/memory').then(r => r.json()).then(data => {
    _memoryData = data;
    renderSoul(data.soul);
    renderTier1('memory', data.tier1.memory);
    renderTier1('user', data.tier1.user);
    renderEntryList('memory', data.tier2.memory);
    renderEntryList('user', data.tier2.user);
  }).catch(() => showToast('加载记忆失败', true));
}

function renderSoul(content) {
  document.getElementById('soul-editor').value = content || '';
}

function renderTier1(target, content) {
  const viewEl = document.getElementById(target + '-t1-view');
  const editorEl = document.getElementById(target + '-t1-editor');
  const hintEl = document.getElementById(target + '-t1-hint');
  const limits = _memoryData.limits || {};
  const maxChars = target === 'memory' ? (limits.tier1MemoryMaxChars || 1500) : (limits.tier1UserMaxChars || 1000);

  if (viewEl) {
    if (content) {
      viewEl.innerHTML = typeof marked !== 'undefined' && typeof DOMPurify !== 'undefined'
        ? DOMPurify.sanitize(marked.parse(content))
        : '<pre style="white-space:pre-wrap">' + escapeHtml(content) + '</pre>';
    } else {
      viewEl.innerHTML = '<div class="empty-state-sm"><p>暂无一级' + (target === 'memory' ? '经验记忆' : '用户画像') + '</p></div>';
    }
  }
  if (editorEl) editorEl.value = content || '';
  if (hintEl) hintEl.textContent = '已用 ' + (content || '').length + '/' + maxChars + ' 字符';
}

function toggleTier1Edit(target) {
  const viewEl = document.getElementById(target + '-t1-view');
  const editorEl = document.getElementById(target + '-t1-editor');
  const editBtn = document.getElementById(target + '-t1-edit-btn');
  const saveBtn = document.getElementById(target + '-t1-save-btn');
  const isEditing = editorEl.style.display !== 'none';

  if (isEditing) {
    // Switch to view
    viewEl.style.display = '';
    editorEl.style.display = 'none';
    editBtn.textContent = '编辑';
    saveBtn.style.display = 'none';
    // Re-render view
    renderTier1(target, editorEl.value);
  } else {
    // Switch to edit
    viewEl.style.display = 'none';
    editorEl.style.display = '';
    editBtn.textContent = '取消';
    saveBtn.style.display = '';
    editorEl.focus();
  }
}

function saveTier1(target) {
  const content = document.getElementById(target + '-t1-editor').value;
  fetch('/api/memory/tier1/' + target, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content })
  }).then(r => r.json()).then(data => {
    if (data.success) {
      showToast('已保存');
      toggleTier1Edit(target);
    } else {
      showToast(data.error || '保存失败', true);
    }
  }).catch(() => showToast('保存失败', true));
}

function renderEntryList(type, entries) {
  const list = document.getElementById(type + '-list');
  const count = document.getElementById(type + '-count');
  count.textContent = entries.length;
  if (entries.length === 0) {
    list.innerHTML = '<div class="empty-state-sm"><p>暂无二级记忆</p><button class="btn btn-primary btn-sm" onclick="openAddEntryModal(\'' + type + '\')">添加第一条</button></div>';
    return;
  }
  list.innerHTML = entries.map(e => {
    const safeSummary = escapeHtml(e.summary || e.content.split('\n')[0].slice(0, 50));
    return '<div class="entry-card">' +
      '<div class="entry-content">' + safeSummary + '</div>' +
      '<div class="entry-actions">' +
        '<button class="btn btn-sm" onclick="openEditEntryModal(\'' + type + '\', ' + e.idx + ')">编辑</button>' +
        '<button class="btn btn-sm btn-danger" onclick="deleteEntry(\'' + type + '\', ' + e.idx + ')">删除</button>' +
      '</div>' +
    '</div>';
  }).join('');
}

function saveSoul() {
  const content = document.getElementById('soul-editor').value;
  fetch('/api/memory/soul', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content })
  }).then(r => r.json()).then(data => {
    if (data.error) showToast(data.error, true);
    else showToast('已保存');
  }).catch(() => showToast('保存失败', true));
}

function openAddEntryModal(type) {
  _memoryEntryMode = 'add';
  _memoryEntryType = type;
  _memoryEntryIdx = -1;
  document.getElementById('memory-entry-title').textContent = '添加二级' + (type === 'memory' ? '经验记忆' : '用户画像');
  document.getElementById('memory-entry-summary').value = '';
  document.getElementById('memory-entry-content').value = '';
  updateEntryUsage(type);
  showModal('memory-entry-modal');
  document.getElementById('memory-entry-summary').focus();
}

function openEditEntryModal(type, idx) {
  const entries = _memoryData.tier2 ? _memoryData.tier2[type] || [] : [];
  const entry = entries.find(e => e.idx === idx);
  if (!entry) return;
  _memoryEntryMode = 'edit';
  _memoryEntryType = type;
  _memoryEntryIdx = idx;
  document.getElementById('memory-entry-title').textContent = '编辑二级' + (type === 'memory' ? '经验记忆' : '用户画像');
  document.getElementById('memory-entry-summary').value = entry.summary || '';
  document.getElementById('memory-entry-content').value = entry.content;
  updateEntryUsage(type);
  showModal('memory-entry-modal');
  document.getElementById('memory-entry-summary').focus();
}

function updateEntryUsage(type) {
  const entries = _memoryData.tier2 ? _memoryData.tier2[type] || [] : [];
  const limits = _memoryData.limits || {};
  const maxEntries = type === 'memory' ? (limits.tier2MemoryMaxEntries || 20) : (limits.tier2UserMaxEntries || 10);
  document.getElementById('memory-entry-usage').textContent = '二级记忆: ' + entries.length + '/' + maxEntries + ' 条';
}

function closeMemoryEntryModal() {
  hideModal('memory-entry-modal');
}

function saveMemoryEntry() {
  const summary = document.getElementById('memory-entry-summary').value.trim();
  const content = document.getElementById('memory-entry-content').value.trim();
  if (!content) { showToast('内容不能为空', true); return; }
  if (!summary) { showToast('摘要不能为空', true); return; }
  const type = _memoryEntryType;

  if (_memoryEntryMode === 'add') {
    fetch('/api/memory/tier2/' + type, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content, summary })
    }).then(r => r.json()).then(data => {
      if (data.success) { showToast('已添加'); closeMemoryEntryModal(); loadMemoryPage(); }
      else showToast(data.error || '添加失败', true);
    }).catch(() => showToast('添加失败', true));
  } else {
    const entries = _memoryData.tier2 ? _memoryData.tier2[type] || [] : [];
    const entry = entries.find(e => e.idx === _memoryEntryIdx);
    if (!entry) return;
    fetch('/api/memory/tier2/' + type, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ old_text: entry.content, content, summary })
    }).then(r => r.json()).then(data => {
      if (data.success) { showToast('已更新'); closeMemoryEntryModal(); loadMemoryPage(); }
      else showToast(data.error || '更新失败', true);
    }).catch(() => showToast('更新失败', true));
  }
}

function deleteEntry(type, idx) {
  const entries = _memoryData.tier2 ? _memoryData.tier2[type] || [] : [];
  const entry = entries.find(e => e.idx === idx);
  if (!entry) return;
  if (!confirm('确定删除这条记忆？')) return;
  fetch('/api/memory/tier2/' + type, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ old_text: entry.content })
  }).then(r => r.json()).then(data => {
    if (data.success) { showToast('已删除'); loadMemoryPage(); }
    else showToast(data.error || '删除失败', true);
  }).catch(() => showToast('删除失败', true));
}

// Tab switching for memory page
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const tabBar = btn.closest('.tab-bar');
    tabBar.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    const page = tabBar.closest('.page');
    page.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
    const target = page.querySelector('#tab-' + btn.dataset.tab);
    if (target) target.classList.add('active');
  });
});

init();
// ---------- Autostart Toggle ----------
function toggleAutostart(enabled) {
  fetch('/api/autostart', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled }),
  }).then(r => r.json()).then(data => {
    if (!data.success && data.error) {
      showToast('设置失败: ' + data.error, true);
      const cb = document.getElementById('settings-autostart');
      if (cb) cb.checked = !enabled;
    } else {
      showSaveToast();
    }
  }).catch(() => {
    showToast('设置失败', true);
    const cb = document.getElementById('settings-autostart');
    if (cb) cb.checked = !enabled;
  });
}

// ---------- Floating Robot Chat ----------
let floatingConfig = { enabled: false, proxyId: '', providerId: '', model: '', thinkingEffort: '' };
let floatingProxyProviders = [];
let floatingConversationId = '';
let floatingAbortController = null;

function getFloatingProxyId() {
  if (floatingConfig.enabled && floatingConfig.proxyId) return floatingConfig.proxyId;
  return assistantProxyId || savedAssistantProxyId || '';
}
function getFloatingProviderId() {
  if (floatingConfig.enabled && floatingConfig.providerId) return floatingConfig.providerId;
  return assistantProviderId || savedAssistantProviderId || '';
}
function getFloatingModel() {
  if (floatingConfig.enabled && floatingConfig.model) return floatingConfig.model;
  return assistantModel || savedAssistantModel || '';
}
function getFloatingThinkingEffort() {
  if (floatingConfig.enabled && floatingConfig.thinkingEffort) return floatingConfig.thinkingEffort;
  return document.getElementById('assistant-thinking-select')?.value || '';
}

function saveFloatingConfig() {
  floatingConfig.providerId = document.getElementById('floating-provider-select')?.value || '';
  floatingConfig.model = document.getElementById('floating-model-select')?.value || '';
  floatingConfig.thinkingEffort = document.getElementById('floating-thinking-select')?.value || '';
  fetch('/api/settings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ floatingConfig }),
  }).catch(() => {});
}

function onFloatingWindowSizeChange(val) {
  floatingConfig.windowSize = Math.max(1, Math.min(200, parseInt(val) || 20));
  document.getElementById('floating-window-size').value = floatingConfig.windowSize;
  saveFloatingConfig();
}

function onFloatingConfigToggle(enabled) {
  floatingConfig.enabled = enabled;
  document.getElementById('floating-config-fields').style.display = enabled ? '' : 'none';
  saveFloatingConfig();
  updateFloatingProxyHint();
}

function onFloatingProxyChange(proxyId) {
  floatingConfig.proxyId = proxyId;
  floatingConfig.providerId = '';
  floatingConfig.model = '';
  loadFloatingProxyProviders(proxyId);
  saveFloatingConfig();
}

function onFloatingProviderChange(providerId) {
  floatingConfig.providerId = providerId;
  floatingConfig.model = '';
  populateFloatingModelSelect();
  saveFloatingConfig();
}

async function loadFloatingProxyProviders(proxyId) {
  const sel = document.getElementById('floating-provider-select');
  const modelSel = document.getElementById('floating-model-select');
  if (!proxyId) {
    if (sel) sel.innerHTML = '<option value="">自动（跟随代理）</option>';
    if (modelSel) modelSel.innerHTML = '<option value="">自动（跟随代理）</option>';
    floatingProxyProviders = [];
    return;
  }
  try {
    const res = await fetch(`/api/assistant/proxy-providers/${proxyId}`);
    const data = await res.json();
    floatingProxyProviders = data.providers || [];
    if (sel) {
      sel.innerHTML = '<option value="">自动（跟随代理）</option>' +
        floatingProxyProviders.map(p => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.name)} (${escapeHtml(p.protocol)})</option>`).join('');
      if (floatingConfig.providerId && floatingProxyProviders.find(p => p.id === floatingConfig.providerId)) {
        sel.value = floatingConfig.providerId;
      }
    }
    populateFloatingModelSelect();
  } catch {}
}

function populateFloatingModelSelect() {
  const sel = document.getElementById('floating-model-select');
  if (!sel) return;
  const provider = floatingProxyProviders.find(p => p.id === floatingConfig.providerId);
  const models = provider?.models || [];
  sel.innerHTML = '<option value="">自动（跟随代理）</option>' +
    models.map(m => `<option value="${escapeHtml(m.name)}">${escapeHtml(m.name)}</option>`).join('');
  if (floatingConfig.model && models.find(m => m.name === floatingConfig.model)) {
    sel.value = floatingConfig.model;
  }
}

function updateFloatingProxyHint() {
  const hint = document.getElementById('floating-chat-proxy-hint');
  if (!hint) return;
  const pid = getFloatingProxyId();
  hint.style.display = pid ? 'none' : '';
}

function populateFloatingProxySelect() {
  const sel = document.getElementById('floating-proxy-select');
  if (!sel) return;
  sel.innerHTML = '<option value="">选择代理...</option>' +
    proxies.filter(p => p.running).map(p => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.name)} (:${p.port})</option>`).join('');
  if (floatingConfig.proxyId) sel.value = floatingConfig.proxyId;
}

(function initFloatingRobot() {
  const btn = document.getElementById('floating-robot-btn');
  const chat = document.getElementById('floating-chat');
  const chatInput = document.getElementById('floating-chat-input');
  const chatSend = document.getElementById('floating-chat-send');
  const chatMessages = document.getElementById('floating-chat-messages');
  if (!btn || !chat) return;

  let isDragging = false;
  let dragMoved = false;
  let startX, startY, startLeft, startTop;

  // Position button at bottom-right initially
  btn.style.right = '24px';
  btn.style.bottom = '24px';
  btn.style.left = 'auto';
  btn.style.top = 'auto';

  function getBtnRect() { return btn.getBoundingClientRect(); }
  function clamp(val, min, max) { return Math.max(min, Math.min(max, val)); }

  // --- Drag logic ---
  function onPointerDown(e) {
    if (e.button && e.button !== 0) return;
    isDragging = true;
    dragMoved = false;
    btn.classList.add('dragging');
    const rect = getBtnRect();
    startX = (e.touches ? e.touches[0].clientX : e.clientX);
    startY = (e.touches ? e.touches[0].clientY : e.clientY);
    startLeft = rect.left;
    startTop = rect.top;
    btn.style.left = rect.left + 'px';
    btn.style.top = rect.top + 'px';
    btn.style.right = 'auto';
    btn.style.bottom = 'auto';
    e.preventDefault();
  }

  function onPointerMove(e) {
    if (!isDragging) return;
    const cx = e.touches ? e.touches[0].clientX : e.clientX;
    const cy = e.touches ? e.touches[0].clientY : e.clientY;
    const dx = cx - startX;
    const dy = cy - startY;
    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) dragMoved = true;
    const bw = btn.offsetWidth;
    const bh = btn.offsetHeight;
    btn.style.left = clamp(startLeft + dx, 0, window.innerWidth - bw) + 'px';
    btn.style.top = clamp(startTop + dy, 0, window.innerHeight - bh) + 'px';
  }

  function onPointerUp() {
    if (!isDragging) return;
    isDragging = false;
    btn.classList.remove('dragging');
  }

  btn.addEventListener('mousedown', onPointerDown);
  btn.addEventListener('touchstart', onPointerDown, { passive: false });
  document.addEventListener('mousemove', onPointerMove);
  document.addEventListener('touchmove', onPointerMove, { passive: false });
  document.addEventListener('mouseup', onPointerUp);
  document.addEventListener('touchend', onPointerUp);

  // --- Click to toggle chat ---
  btn.addEventListener('click', function() {
    if (dragMoved) return;
    if (chat.style.display === 'none') openFloatingChat();
    else closeFloatingChat();
  });

  function openFloatingChat() {
    const rect = getBtnRect();
    const chatW = 370;
    const chatH = 480;
    let left = rect.right - chatW;
    let top = rect.top - chatH - 10;
    left = clamp(left, 8, window.innerWidth - chatW - 8);
    top = clamp(top, 8, window.innerHeight - chatH - 8);
    if (top < 8) top = rect.bottom + 10;
    chat.style.left = left + 'px';
    chat.style.top = top + 'px';
    chat.style.display = 'flex';
    btn.style.display = 'none';
    updateFloatingProxyHint();
    chatInput.focus();
  }

  window.openFloatingChat = openFloatingChat;
  window.floatingNewConversation = function() {
    if (floatingConversationId) {
      // Sync old conversation into main assistant's history
      if (typeof loadConversations === 'function') loadConversations();
    }
    floatingConversationId = '';
    floatingAttachments = [];
    renderFloatingAttachments();
    stopFloatingVoice();
    chatMessages.innerHTML = '';
    // Re-add welcome
    const welcome = document.createElement('div');
    welcome.className = 'floating-chat-welcome';
    welcome.innerHTML = '<p>已开启新会话</p>';
    chatMessages.appendChild(welcome);
    updateFloatingProxyHint();
    // Persist cleared conversation ID
    fetch('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ floatingConversationId: '' }),
    }).catch(() => {});
  };
  window.closeFloatingChat = function() {
    // Place robot at chat window's current position
    const chatRect = chat.getBoundingClientRect();
    btn.style.left = (chatRect.right - btn.offsetWidth) + 'px';
    btn.style.top = (chatRect.bottom - btn.offsetHeight) + 'px';
    btn.style.right = 'auto';
    btn.style.bottom = 'auto';
    chat.style.display = 'none';
    btn.style.display = '';
  };

  // --- Resize handle ---
  const resizeHandle = document.getElementById('floating-chat-resize');
  if (resizeHandle) {
    let resizing = false, resizeStartX, resizeStartY, resizeStartW, resizeStartH;
    resizeHandle.addEventListener('mousedown', function(e) {
      resizing = true;
      resizeStartX = e.clientX;
      resizeStartY = e.clientY;
      resizeStartW = chat.offsetWidth;
      resizeStartH = chat.offsetHeight;
      e.preventDefault();
      e.stopPropagation();
    });
    document.addEventListener('mousemove', function(e) {
      if (!resizing) return;
      const newW = Math.max(280, Math.min(window.innerWidth * 0.9, resizeStartW + (e.clientX - resizeStartX)));
      const newH = Math.max(320, Math.min(window.innerHeight * 0.9, resizeStartH + (e.clientY - resizeStartY)));
      chat.style.width = newW + 'px';
      chat.style.height = newH + 'px';
    });
    document.addEventListener('mouseup', function() { resizing = false; });
  }

  // --- Drag chat window by header ---
  const chatHeader = chat.querySelector('.floating-chat-header');
  if (chatHeader) {
    let chatDragging = false, chatDragX, chatDragY, chatDragStartLeft, chatDragStartTop;
    chatHeader.addEventListener('mousedown', function(e) {
      if (e.target.closest('.floating-chat-btn')) return;
      chatDragging = true;
      chatDragX = e.clientX;
      chatDragY = e.clientY;
      chatDragStartLeft = chat.offsetLeft;
      chatDragStartTop = chat.offsetTop;
      e.preventDefault();
    });
    document.addEventListener('mousemove', function(e) {
      if (!chatDragging) return;
      const newLeft = clamp(chatDragStartLeft + (e.clientX - chatDragX), 0, window.innerWidth - chat.offsetWidth);
      const newTop = clamp(chatDragStartTop + (e.clientY - chatDragY), 0, window.innerHeight - chat.offsetHeight);
      chat.style.left = newLeft + 'px';
      chat.style.top = newTop + 'px';
    });
    document.addEventListener('mouseup', function() { chatDragging = false; });
  }

  // --- Chat input ---
  const floatingAc = document.getElementById('floating-autocomplete');
  let floatingAcIndex = -1;

  function updateFloatingAutocomplete(text) {
    if (!floatingAc) return;
    const match = text.match(/^\/([a-zA-Z0-9_-]*)$/);
    if (!match) { floatingAc.style.display = 'none'; floatingAcIndex = -1; return; }
    const query = match[1].toLowerCase();
    const cmdItems = SLASH_COMMANDS.filter(c => c.name !== 'compact' && c.name.includes(query)).map(c => ({ name: c.name, description: '[命令] ' + c.description }));
    const skillItems = assistantSkills.filter(s => s.name.toLowerCase().includes(query)).map(s => ({ name: s.name, description: s.description || '' }));
    const filtered = [...cmdItems, ...skillItems];
    if (filtered.length === 0) { floatingAc.style.display = 'none'; floatingAcIndex = -1; return; }
    floatingAcIndex = -1;
    floatingAc.innerHTML = filtered.map((s, i) =>
      `<div class="floating-ac-item" data-name="${escapeHtml(s.name)}" data-index="${i}"><strong>/${escapeHtml(s.name)}</strong><span class="floating-ac-desc">${escapeHtml(s.description)}</span></div>`
    ).join('');
    floatingAc.style.display = 'block';
    floatingAc.onclick = (e) => {
      const item = e.target.closest('[data-name]');
      if (item) selectFloatingAcItem(item.dataset.name);
    };
  }

  function selectFloatingAcItem(name) {
    chatInput.value = '/' + name + ' ';
    chatInput.focus();
    floatingAc.style.display = 'none';
    floatingAcIndex = -1;
  }

  function highlightFloatingAcItem(items, index) {
    items.forEach((item, i) => item.classList.toggle('active', i === index));
    if (items[index]) items[index].scrollIntoView({ block: 'nearest' });
  }

  chatInput.addEventListener('input', function() {
    this.style.height = 'auto';
    this.style.height = Math.min(this.scrollHeight, 80) + 'px';
    chatSend.disabled = (!this.value.trim() && floatingAttachments.length === 0) || !getFloatingProxyId();
    updateFloatingAutocomplete(this.value);
  });

  chatInput.addEventListener('keydown', function(e) {
    const isOpen = floatingAc && floatingAc.style.display === 'block';
    const items = isOpen ? floatingAc.querySelectorAll('.floating-ac-item') : [];

    if (e.key === 'ArrowDown' && isOpen) {
      e.preventDefault();
      floatingAcIndex = floatingAcIndex < items.length - 1 ? floatingAcIndex + 1 : 0;
      highlightFloatingAcItem(items, floatingAcIndex);
    } else if (e.key === 'ArrowUp' && isOpen) {
      e.preventDefault();
      floatingAcIndex = floatingAcIndex > 0 ? floatingAcIndex - 1 : items.length - 1;
      highlightFloatingAcItem(items, floatingAcIndex);
    } else if (e.key === 'Enter' && !e.shiftKey) {
      if (isOpen && floatingAcIndex >= 0 && items[floatingAcIndex]) {
        e.preventDefault();
        selectFloatingAcItem(items[floatingAcIndex].dataset.name);
      } else {
        e.preventDefault();
        const text = this.value.trim();
        if (text.startsWith('/')) {
          sendFloatingChatMessage();
        } else if (!chatSend.disabled) {
          sendFloatingChatMessage();
        }
      }
    } else if (e.key === 'Escape') {
      if (isOpen) {
        floatingAc.style.display = 'none';
        floatingAcIndex = -1;
      }
    }
  });

  // Close autocomplete on outside click
  document.addEventListener('click', function(e) {
    if (floatingAc && !floatingAc.contains(e.target) && e.target !== chatInput) {
      floatingAc.style.display = 'none';
      floatingAcIndex = -1;
    }
  });

  // --- Attachments & Voice ---
  let floatingAttachments = [];
  let floatingVoiceRecorder = null;
  let floatingVoiceChunks = [];
  let floatingIsRecording = false;
  let floatingVoiceAnalyser = null;
  let floatingVoiceAnimId = null;
  const floatingMicBtn = document.getElementById('floating-mic-btn');

  function renderFloatingAttachments() {
    const container = document.getElementById('floating-attachment-preview');
    if (!container) return;
    if (floatingAttachments.length === 0) { container.innerHTML = ''; return; }
    container.innerHTML = floatingAttachments.map((att, i) => {
      if (att.type === 'image_url') {
        return `<div class="floating-att-item"><img src="data:${att.mimeType};base64,${att.data}" alt=""><span class="att-name">${escapeHtml(att.name)}</span><button class="floating-att-remove" onclick="removeFloatingAttachment(${i})">×</button></div>`;
      }
      return `<div class="floating-att-item"><span>🔊</span><span class="att-name">${escapeHtml(att.name)}</span><button class="floating-att-remove" onclick="removeFloatingAttachment(${i})">×</button></div>`;
    }).join('');
  }

  window.removeFloatingAttachment = function(index) {
    floatingAttachments.splice(index, 1);
    renderFloatingAttachments();
    chatSend.disabled = (!chatInput.value.trim() && floatingAttachments.length === 0) || !getFloatingProxyId();
  };

  // Paste image support
  chatInput.addEventListener('paste', function(e) {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (const item of items) {
      if (item.kind === 'file') {
        const file = item.getAsFile();
        if (file && file.type.startsWith('image/')) {
          e.preventDefault();
          const reader = new FileReader();
          reader.onload = (ev) => {
            const base64 = ev.target.result.split(',')[1];
            floatingAttachments.push({ type: 'image_url', mimeType: file.type, name: file.name || 'pasted.png', data: base64 });
            renderFloatingAttachments();
          };
          reader.readAsDataURL(file);
        }
      }
    }
  });

  // Voice recording
  function updateFloatingMicState() {
    if (!floatingMicBtn) return;
    if (floatingIsRecording) {
      floatingMicBtn.innerHTML = buildMicSvg(0);
      floatingMicBtn.title = '点击停止录音';
    } else {
      floatingMicBtn.innerHTML = MIC_SVG_IDLE;
      floatingMicBtn.title = '语音输入';
    }
  }
  updateFloatingMicState();

  window.toggleFloatingVoiceRecording = function() {
    if (floatingIsRecording) stopFloatingVoice();
    else startFloatingVoice();
  };

  async function startFloatingVoice() {
    const proxyId = getFloatingProxyId();
    if (!proxyId) { showToast('请先配置代理后再使用语音', true); return; }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus'
        : MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : '';
      const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const source = audioCtx.createMediaStreamSource(stream);
      floatingVoiceAnalyser = audioCtx.createAnalyser();
      floatingVoiceAnalyser.fftSize = 256;
      source.connect(floatingVoiceAnalyser);
      floatingVoiceRecorder = new MediaRecorder(stream, mimeType ? { mimeType } : {});
      floatingVoiceChunks = [];
      floatingVoiceRecorder.ondataavailable = (e) => { if (e.data.size > 0) floatingVoiceChunks.push(e.data); };
      floatingVoiceRecorder.onstop = async () => {
        const blob = new Blob(floatingVoiceChunks, { type: mimeType || 'audio/webm' });
        const arrayBuffer = await blob.arrayBuffer();
        const ac2 = new (window.AudioContext || window.webkitAudioContext)();
        const audioBuffer = await ac2.decodeAudioData(arrayBuffer);
        const wavBuffer = audioBufferToWav(audioBuffer);
        const base64 = arrayBufferToBase64(wavBuffer);
        const timeStr = new Date().toLocaleTimeString('zh-CN', { hour12: false }).replace(/:/g, '-');
        floatingAttachments.push({ type: 'input_audio', mimeType: 'audio/wav', name: `录音_${timeStr}.wav`, data: base64 });
        renderFloatingAttachments();
        await ac2.close();
        stream.getTracks().forEach(t => t.stop());
        audioCtx.close();
        sendFloatingChatMessage();
      };
      floatingVoiceRecorder.start();
      floatingIsRecording = true;
      updateFloatingMicState();
      // Volume animation
      const micBtn = floatingMicBtn;
      const dataArray = new Uint8Array(floatingVoiceAnalyser.frequencyBinCount);
      let smoothVol = 0;
      function animate() {
        if (!floatingIsRecording) return;
        floatingVoiceAnalyser.getByteFrequencyData(dataArray);
        let sum = 0;
        for (let i = 0; i < dataArray.length; i++) sum += dataArray[i];
        smoothVol += ((sum / dataArray.length) - smoothVol) * 0.3;
        micBtn.innerHTML = buildMicSvg(Math.min(smoothVol / 100, 1));
        floatingVoiceAnimId = requestAnimationFrame(animate);
      }
      floatingVoiceAnimId = requestAnimationFrame(animate);
    } catch (err) {
      showToast('无法访问麦克风: ' + err.message, true);
    }
  }

  function stopFloatingVoice() {
    if (!floatingIsRecording) return;
    floatingIsRecording = false;
    if (floatingVoiceAnimId) { cancelAnimationFrame(floatingVoiceAnimId); floatingVoiceAnimId = null; }
    floatingVoiceAnalyser = null;
    updateFloatingMicState();
    try {
      if (floatingVoiceRecorder && floatingVoiceRecorder.state !== 'inactive') floatingVoiceRecorder.stop();
    } catch {}
  }

  // --- Send message ---
  window.sendFloatingChatMessage = async function() {
    const text = chatInput.value.trim();
    const hasAttachments = floatingAttachments.length > 0;
    if (!text && !hasAttachments) return;
    if (floatingAbortController) return;

    // Slash commands — must run before proxy check so /help etc. always work
    if (text.startsWith('/') && !hasAttachments) {
      const cmdMatch = text.match(/^\/(\w+)(?:\s+(.*))?$/);
      if (cmdMatch) {
        const cmd = cmdMatch[1].toLowerCase();
        const handled = handleFloatingSlashCommand(cmd, cmdMatch[2]);
        if (handled) {
          chatInput.value = '';
          chatInput.style.height = 'auto';
          return;
        }
      }
    }

    const proxyId = getFloatingProxyId();
    if (!proxyId) {
      addFloatingMsg('error', '请先在设置中配置快捷助手代理，或在智控助手页面选择代理');
      return;
    }

    // Remove welcome
    const welcome = chatMessages.querySelector('.floating-chat-welcome');
    if (welcome) welcome.remove();

    // Build multimodal message payload
    let messagePayload = text;
    if (hasAttachments) {
      const content = [];
      if (text) content.push({ type: 'text', text });
      for (const att of floatingAttachments) {
        if (att.type === 'image_url') {
          content.push({ type: 'image_url', image_url: { url: `data:${att.mimeType};base64,${att.data}` } });
        } else if (att.type === 'input_audio') {
          const format = att.mimeType.replace(/^audio\//, '').replace(/;.*$/, '') || 'mp3';
          content.push({ type: 'input_audio', input_audio: { data: att.data, format } });
        }
      }
      messagePayload = content;
    }

    // Display user message
    const displayText = text || (hasAttachments ? floatingAttachments.map(a => a.name).join(', ') : '');
    addFloatingMsg('user', displayText + (hasAttachments && text ? ' 📎' : hasAttachments ? ' 📎' : ''));
    chatInput.value = '';
    chatInput.style.height = 'auto';
    floatingAttachments = [];
    renderFloatingAttachments();
    chatSend.disabled = true;

    const thinkingEl = addFloatingThinking();
    const controller = new AbortController();
    floatingAbortController = controller;

    try {
      const providerVal = getFloatingProviderId();
      const modelVal = getFloatingModel();
      const thinkingVal = getFloatingThinkingEffort();
      const res = await fetch('/api/assistant/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          proxyId,
          conversationId: floatingConversationId || undefined,
          message: messagePayload,
          ...(providerVal && { providerId: providerVal }),
          ...(modelVal && { model: modelVal }),
          permissionLevel: parseInt(document.getElementById('assistant-permission-select')?.value || '3'),
          ...(thinkingVal && { thinkingEffort: thinkingVal }),
          mode: 'sliding',
          windowSize: floatingConfig.enabled ? (floatingConfig.windowSize || 20) : assistantWindowSize,
        }),
        signal: controller.signal,
      });

      if (!res.ok) {
        thinkingEl.remove();
        addFloatingMsg('error', `请求失败: HTTP ${res.status}`);
        return;
      }

      await processFloatingSSE(res, thinkingEl);
    } catch (err) {
      thinkingEl.remove();
      if (err.name !== 'AbortError') {
        addFloatingMsg('error', `请求出错: ${err.message}`);
      }
    } finally {
      if (floatingAbortController === controller) floatingAbortController = null;
      chatSend.disabled = !chatInput.value.trim();
    }
  };

  function handleFloatingSlashCommand(cmd, args) {
    // If it matches a skill name, let it pass through to the backend
    if (assistantSkills.find(s => s.name === cmd)) return false;
    switch (cmd) {
      case 'help': {
        const cmdList = SLASH_COMMANDS.filter(c => c.name !== 'compact').map(c => `- \`/${c.name}\` — ${c.description}`).join('\n');
        const skillList = assistantSkills.length
          ? '\n**技能：**\n' + assistantSkills.map(s => `- \`/${s.name}\` — ${s.description || ''}`).join('\n')
          : '';
        addFloatingMsg('assistant', '**可用命令：**\n' + cmdList + skillList);
        return true;
      }
      case 'clear':
        chatMessages.innerHTML = '';
        floatingConversationId = '';
        return true;
      case 'new':
        floatingConversationId = '';
        chatMessages.innerHTML = '';
        addFloatingMsg('assistant', '已开启新会话。');
        return true;
      case 'model': {
        const pid = getFloatingProxyId();
        const prov = getFloatingProviderId();
        const mdl = getFloatingModel();
        const think = getFloatingThinkingEffort();
        const proxyName = proxies.find(p => p.id === pid)?.name || pid;
        const ws = floatingConfig.enabled ? (floatingConfig.windowSize || 20) : assistantWindowSize;
        addFloatingMsg('assistant',
          `**当前配置：**\n` +
          `- 代理：${proxyName || '未设置'}\n` +
          `- 供应商：${prov || '自动'}\n` +
          `- 模型：${mdl || '自动'}\n` +
          `- 思考深度：${think || '跟随模型'}\n` +
          `- 对话模式：长对话（最近 ${ws} 条）`
        );
        return true;
      }
      default: return false;
    }
  }

  // --- SSE processing ---
  function attachFloatingDeleteBtn(el, backendMsgId) {
    if (!el || !backendMsgId || el.querySelector('.msg-delete-btn')) return;
    el.dataset.backendMsgId = backendMsgId;
    el.style.position = 'relative';
    const delBtn = document.createElement('button');
    delBtn.className = 'msg-delete-btn';
    delBtn.title = '删除该问答对';
    delBtn.innerHTML = '&times;';
    delBtn.onclick = (e) => { e.stopPropagation(); deleteFloatingMsgPair(backendMsgId); };
    el.appendChild(delBtn);
  }

  async function deleteFloatingMsgPair(backendMsgId) {
    if (!backendMsgId || !floatingConversationId) { showToast('消息尚未就绪', true); return; }
    const ok = await showConfirm('确定删除该问答对吗？');
    if (!ok) return;
    try {
      const res = await fetch(`/api/assistant/conversations/${floatingConversationId}/messages/${backendMsgId}`, { method: 'DELETE' });
      if (!res.ok) { showToast('删除失败', true); return; }
      // Remove the message and its pair from DOM
      const allMsgs = chatMessages.querySelectorAll('.floating-msg');
      let found = false;
      for (const msg of allMsgs) {
        if (msg.dataset.backendMsgId === backendMsgId) { found = true; msg.remove(); continue; }
        if (found && !msg.dataset.backendMsgId) break; // reached next pair boundary
        if (found) { msg.remove(); break; } // remove the paired message
      }
      // If nothing matched by data attr, remove the last user + assistant pair
      if (!found) {
        const msgs = [...chatMessages.querySelectorAll('.floating-msg')];
        const lastAssistant = msgs.reverse().find(m => m.classList.contains('assistant'));
        const lastUser = msgs.find(m => m.classList.contains('user'));
        if (lastAssistant) lastAssistant.remove();
        if (lastUser) lastUser.remove();
      }
    } catch (err) {
      showToast('删除失败: ' + err.message, true);
    }
  }

  async function processFloatingSSE(response, thinkingEl) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let fullContent = '';
    let currentEvent = '';
    let contentEl = null;
    let lastUserEl = chatMessages.querySelector('.floating-msg.user:last-of-type');

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        if (trimmed.startsWith('event: ')) { currentEvent = trimmed.slice(7); continue; }
        if (!trimmed.startsWith('data: ')) continue;
        let data;
        try { data = JSON.parse(trimmed.slice(6)); } catch { continue; }

        switch (currentEvent) {
          case 'content':
            if (thinkingEl.parentNode) thinkingEl.remove();
            if (!contentEl) contentEl = addFloatingMsg('assistant', '');
            fullContent += data.delta;
            contentEl.innerHTML = DOMPurify.sanitize(marked.parse(fullContent));
            scrollFloatingChat();
            break;
          case 'conversation':
            floatingConversationId = data.id;
            fetch('/api/settings', {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ floatingConversationId: data.id }),
            }).catch(() => {});
            if (data.userMessageId && lastUserEl) {
              attachFloatingDeleteBtn(lastUserEl, data.userMessageId);
            }
            break;
          case 'done':
            if (thinkingEl.parentNode) thinkingEl.remove();
            if (contentEl && data.reasoning_content && !fullContent.includes('<think>')) {
              fullContent = `<think>${data.reasoning_content}</think>` + fullContent;
              contentEl.innerHTML = DOMPurify.sanitize(marked.parse(fullContent));
            }
            if (data.assistantMessageId && contentEl) {
              attachFloatingDeleteBtn(contentEl, data.assistantMessageId);
            }
            break;
          case 'error':
            if (thinkingEl.parentNode) thinkingEl.remove();
            addFloatingMsg('error', `错误: ${data.message}`);
            break;
        }
      }
    }
    if (thinkingEl.parentNode) thinkingEl.remove();
    scrollFloatingChat();
  }

  // --- DOM helpers ---
  function addFloatingMsg(type, content) {
    const div = document.createElement('div');
    div.className = 'floating-msg ' + type;
    if (type === 'assistant') {
      div.innerHTML = content ? DOMPurify.sanitize(marked.parse(content)) : '';
    } else {
      div.textContent = content;
    }
    chatMessages.appendChild(div);
    scrollFloatingChat();
    return div;
  }

  function addFloatingThinking() {
    const div = document.createElement('div');
    div.className = 'floating-msg-thinking';
    div.innerHTML = '<div class="dot"></div><div class="dot"></div><div class="dot"></div>';
    chatMessages.appendChild(div);
    scrollFloatingChat();
    return div;
  }

  function scrollFloatingChat() {
    chatMessages.scrollTop = chatMessages.scrollHeight;
  }

  // Load skills so /commands work without visiting assistant page
  if (typeof loadAssistantSkills === 'function') loadAssistantSkills();

  // Restore floating config from settings (called after settings load)
  window.initFloatingConfigFromSettings = function(settings) {
    if (settings.floatingConfig) {
      Object.assign(floatingConfig, settings.floatingConfig);
    }
    if (settings.floatingConversationId) {
      floatingConversationId = settings.floatingConversationId;
    }
    const toggle = document.getElementById('floating-custom-config');
    if (toggle) toggle.checked = !!floatingConfig.enabled;
    const fields = document.getElementById('floating-config-fields');
    if (fields) fields.style.display = floatingConfig.enabled ? '' : 'none';
    if (floatingConfig.enabled) {
      populateFloatingProxySelect();
      if (floatingConfig.proxyId) {
        loadFloatingProxyProviders(floatingConfig.proxyId);
      }
    }
    const thinkSel = document.getElementById('floating-thinking-select');
    if (thinkSel && floatingConfig.thinkingEffort) thinkSel.value = floatingConfig.thinkingEffort;
    const wsInput = document.getElementById('floating-window-size');
    if (wsInput && floatingConfig.windowSize) wsInput.value = floatingConfig.windowSize;
  };
})();
