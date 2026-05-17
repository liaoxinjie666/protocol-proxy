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
let assistantMessages = []; // 仅用于 UI 渲染
let assistantProxyId = '';
let assistantProviderId = ''; // 用于级联选择的模型列表
let proxyProviders = []; // 当前代理的候选供应商列表
let savedAssistantProxyId = ''; // 从设置恢复的上次选择
let savedAssistantProviderId = '';
let savedAssistantModel = '';
let assistantAbortController = null;
let assistantConversationId = '';
let contextTokens = 0;
let contextMaxTokens = 200000;
let contextPercent = 0;
let contextMessages = 0;
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
    // 恢复助手选择
    if (settings.assistantProxyId) savedAssistantProxyId = settings.assistantProxyId;
    if (settings.assistantProviderId) savedAssistantProviderId = settings.assistantProviderId;
    if (settings.assistantModel) savedAssistantModel = settings.assistantModel;
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
    stats: '\u7528\u91cf\u7edf\u8ba1',
    'request-logs': '\u8bf7\u6c42\u65e5\u5fd7',
    'system-logs': '\u7cfb\u7edf\u65e5\u5fd7',
    assistant: '\u667a\u63a7\u52a9\u624b',
    skills: '\u6280\u80fd\u7ba1\u7406',
    'mcp-servers': 'MCP \u670d\u52a1',
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
  if (page === 'assistant') { populateAssistantProxySelect(); loadConversations(); loadAssistantSkills(); }
  if (page === 'skills') loadSkills();
  if (page === 'mcp-servers') loadMcpServers();
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
    if (currentPage === 'proxies') renderProxies();
    if (currentPage === 'dashboard') renderDashProxies();
    updateDashStats();
    populateProxyFilterOptions();
  } catch (err) {
    console.error('loadProxies error:', err);
  }
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
    models.map(m => `<option value="${escapeHtml(m)}">${escapeHtml(m)}</option>`).join('');
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
          ${models.map(m => `<option value="${escapeHtml(m)}" ${m === item.model ? 'selected' : ''}>${escapeHtml(m)}</option>`).join('')}
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
      <div class="provider-card">
        <div class="provider-card-header">
          <div class="provider-card-name">${escapeHtml(p.name)}${statusDot}</div>
          <span class="provider-card-protocol">${escapeHtml(p.protocol)}</span>
        </div>
        <div class="provider-card-url">${escapeHtml(p.url)}</div>
        <div class="provider-card-models">
          ${(p.models || []).slice(0, 6).map(m => `<span class="provider-card-model">${escapeHtml(m)}</span>`).join('')}
          ${(p.models || []).length > 6 ? `<span class="provider-card-model">+${p.models.length - 6}</span>` : ''}
        </div>
        <div class="provider-card-keys">${(p.apiKeys || []).length} \u4e2a API Key</div>
        <div class="provider-card-actions">
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

function openProviderModal() {
  editingProviderId = null;
  document.getElementById('provider-modal-title').textContent = '\u65b0\u5efa\u4f9b\u5e94\u5546';
  document.getElementById('provider-edit-id').value = '';
  document.getElementById('provider-name').value = '';
  document.getElementById('provider-protocol').value = 'openai';
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
    <span class="tag">${escapeHtml(tag)}<button type="button" class="tag-remove" onclick="removeModelTag(${i})">&times;</button></span>
  `).join('');
}

function handleModelTagInput(e) {
  if (e.key === 'Enter') {
    e.preventDefault();
    const val = e.target.value.trim();
    if (val && !providerModelTags.includes(val)) {
      providerModelTags.push(val);
      renderModelTags();
      e.target.value = '';
    }
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

async function handleProviderSubmit(e) {
  e.preventDefault();
  const payload = {
    name: document.getElementById('provider-name').value.trim(),
    protocol: document.getElementById('provider-protocol').value,
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
  const btn = el || document.activeElement;
  if (btn) { btn.disabled = true; btn.textContent = '\u83b7\u53d6\u4e2d...'; }
  try {
    const key = providerKeys.find(k => k.key.trim())?.key.trim() || '';
    const payload = { url, protocol, apiKey: key };
    const azureDep = document.getElementById('provider-azure-deployment')?.value?.trim();
    if (azureDep) {
      payload.azureDeployment = azureDep;
      payload.azureApiVersion = document.getElementById('provider-azure-version')?.value?.trim() || '2024-02-01';
    }
    const res = await fetch('/api/providers/available-models', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    const models = data.models || [];
    const existing = new Set(providerModelTags);
    const newModels = models.filter(m => !existing.has(m));
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
      ${r.latency ? `<span style="color:var(--text-muted);font-family:var(--font-mono);font-size:12px">${r.latency}ms</span>` : ''}
      ${r.message ? `<span style="color:var(--error);font-size:12px">${escapeHtml(r.message)}</span>` : ''}
    </div>
  `).join('');
  showModal('test-modal');
}

function closeTestModal() {
  hideModal('test-modal');
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
  const avgLatency = total > 0 ? Math.round(filtered.reduce((a, r) => a + (r.latency || 0), 0) / total) : 0;
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
  </div></td>`;
  row.after(detailRow);
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
        <td><code>${escapeHtml(r.protocol || '-')}</code></td>
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
      <td><code>${escapeHtml(r.protocol || '-')}</code></td>
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
async function openHistoryModal() {
  try {
    const res = await fetch('/api/config/history');
    const data = await res.json();
    const list = document.getElementById('history-list');
    const snapshots = data.snapshots || [];
    if (snapshots.length === 0) {
      list.innerHTML = '<div class="empty-sm">\u6682\u65e0\u5386\u53f2\u8bb0\u5f55</div>';
    } else {
      list.innerHTML = snapshots.map(s => `
        <div class="history-item">
          <div class="history-meta">
            <div class="history-name">${escapeHtml(s.file)}</div>
            <div class="history-reason">${escapeHtml(s.reason)} \u00b7 ${new Date(s.timestamp).toLocaleString('zh-CN')}</div>
          </div>
          <div class="history-actions">
            <button class="btn btn-sm history-rollback-btn" data-file="${escapeHtml(s.file)}">\u56de\u6eda</button>
          </div>
        </div>
      `).join('');
      list.querySelectorAll('.history-rollback-btn').forEach(btn => {
        btn.addEventListener('click', () => rollbackConfig(btn.dataset.file));
      });
    }
    showModal('history-modal');
  } catch (err) {
    showToast('\u52a0\u8f7d\u5386\u53f2\u5931\u8d25: ' + err.message, true);
  }
}

function closeHistoryModal() {
  hideModal('history-modal');
}

async function rollbackConfig(file) {
  const ok = await showConfirm(`\u786e\u5b9a\u56de\u6eda\u5230 <strong>${escapeHtml(file)}</strong>\uff1f`);
  if (!ok) return;
  try {
    await fetch('/api/config/rollback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file }),
    });
    closeHistoryModal();
    await Promise.all([loadProxies(), loadProviders()]);
    showToast('\u5df2\u56de\u6eda\u5230\u9009\u5b9a\u7248\u672c');
  } catch (err) {
    showToast('\u56de\u6eda\u5931\u8d25: ' + err.message, true);
  }
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
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
  return n.toLocaleString();
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

  await Promise.all([loadProxies(), loadProviders(), loadKeyHealth()]);
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

  // Assistant textarea auto-resize + skill autocomplete
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
        } else if (assistantAbortController) {
          assistantAbortController.abort();
        }
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
  const select = document.getElementById('assistant-proxy-select');
  if (!select) return;
  const running = proxies.filter(p => p.running);
  const current = select.value;
  select.innerHTML = '<option value="">选择后端代理...</option>' +
    running.map(p => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.name)} (:${p.port})</option>`).join('');
  const preferredId = (current && running.find(p => p.id === current)) ? current
    : (savedAssistantProxyId && running.find(p => p.id === savedAssistantProxyId)) ? savedAssistantProxyId
    : running.length > 0 ? running[0].id : '';
  if (preferredId) {
    select.value = preferredId;
    assistantProxyId = preferredId;
    document.getElementById('assistant-send-btn').disabled = false;
    loadProxyProviders(preferredId);
  } else {
    assistantProxyId = '';
    document.getElementById('assistant-send-btn').disabled = true;
  }
}

function setSendBtnState(running) {
  const btn = document.getElementById('assistant-send-btn');
  if (!btn) return;
  if (running) {
    btn.textContent = '停止';
    btn.classList.add('btn-stop');
    btn.onclick = () => { if (assistantAbortController) assistantAbortController.abort(); };
  } else {
    btn.textContent = '发送';
    btn.classList.remove('btn-stop');
    btn.onclick = sendAssistantMessage;
  }
}

async function sendAssistantMessage() {
  if (assistantAbortController) return; // 已有请求进行中，防连点
  const input = document.getElementById('assistant-input');
  const text = input.value.trim();
  if (!text) return;

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

  addAssistantMessage('user', text);
  input.value = '';
  input.style.height = 'auto';

  const proxy = proxies.find(p => p.id === assistantProxyId);
  if (!proxy) {
    addAssistantMessage('assistant', '所选代理不存在或已停止，请重新选择。');
    return;
  }

  const thinkingId = addAssistantMessage('thinking', '');
  const myController = new AbortController();
  assistantAbortController = myController;
  setSendBtnState(true);

  try {
    const providerVal = document.getElementById('assistant-provider-select')?.value || '';
    const modelVal = document.getElementById('assistant-model-select')?.value || '';
    const res = await fetch('/api/assistant/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        proxyId: proxy.id, conversationId: assistantConversationId, message: text,
        ...(providerVal && { providerId: providerVal }),
        ...(modelVal && { model: modelVal }),
      }),
      signal: assistantAbortController.signal,
    });

    if (!res.ok) {
      const err = await res.text().catch(() => 'Unknown error');
      removeAssistantMessage(thinkingId);
      addAssistantMessage('assistant', `请求失败: HTTP ${res.status}\n\n${err}`);
      return;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let fullContent = '';
    let currentEvent = '';
    let msgId = null;
    let thinkingRemoved = false;

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
              msgId = addAssistantMessage('assistant', '');

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
            addAssistantMessage('tool-calls', callHtml);
            break;
          }

          case 'tool_result': {
            const resultStr = JSON.stringify(data.result, null, 2);
            addAssistantMessage('tool-result', { name: data.name, result: resultStr, tool_call_id: data.tool_call_id, is_error: data.is_error });
            break;
          }

          case 'done': {
            if (!thinkingRemoved) { removeAssistantMessage(thinkingId); thinkingRemoved = true; }
            if (msgId) {
              const msgObj = assistantMessages.find(m => m.id === msgId);
              if (msgObj) {
                // 将 reasoning_content 包装为 <think> 标签以便统一渲染
                if (data.reasoning_content && !fullContent.includes('<think>')) {
                  fullContent = `<think>${data.reasoning_content}</think>` + fullContent;
                }
                msgObj.content = fullContent;
                updateAssistantMessage(msgId, fullContent);
              }
            }
            break;
          }

          case 'error': {
            if (!thinkingRemoved) { removeAssistantMessage(thinkingId); thinkingRemoved = true; }
            addAssistantMessage('assistant', `错误: ${data.message}`);
            break;
          }

          case 'context': {
            contextTokens = data.tokens;
            contextMaxTokens = data.maxTokens || contextMaxTokens;
            contextPercent = data.percent;
            contextMessages = data.messages;
            updateContextBar();
            break;
          }

          case 'compressed': {
            if (data.summary) applyCompression(data);
            break;
          }

          case 'compressing': {
            break;
          }

          case 'conversation': {
            assistantConversationId = data.id;
            loadConversations();
            break;
          }
        }
      }
    }

    // 流结束时确保 thinking 点被移除
    if (!thinkingRemoved) removeAssistantMessage(thinkingId);

    // 流结束但没有收到 done 事件时，确保最终内容被保存
    if (msgId && fullContent) {
      const msgObj = assistantMessages.find(m => m.id === msgId);
      if (msgObj && !msgObj.content) msgObj.content = fullContent;
    }

  } catch (err) {
    removeAssistantMessage(thinkingId);
    if (err.name === 'AbortError') {
      addAssistantMessage('assistant', '已取消');
    } else {
      addAssistantMessage('assistant', `请求出错: ${err.message}`);
    }
  } finally {
    if (assistantAbortController === myController) assistantAbortController = null;
    setSendBtnState(false);
  }
}

function addAssistantMessage(role, content) {
  const id = 'msg-' + Date.now() + '-' + Math.random().toString(36).slice(2);
  assistantMessages.push({ id, role, content });

  const chat = document.getElementById('assistant-chat');
  if (!chat) return id;

  const displayRoles = ['user', 'assistant', 'tool', 'tool-calls', 'tool-result'];
  if (assistantMessages.filter(m => displayRoles.includes(m.role)).length === 1 && role === 'user') {
    chat.innerHTML = '';
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
    // content 是 {name, result, tool_call_id, is_error}
    const toolData = typeof content === 'object' ? content : { name: 'unknown', result: content };
    const resultId = 'result-' + id;
    if (toolData.is_error) div.classList.add('tool-error');
    div.innerHTML = `
      <div class="tool-result-header" onclick="document.getElementById('${resultId}').classList.toggle('expanded')">
        <span class="tool-result-name">${toolData.is_error ? '⚠ ' : ''}${escapeHtml(toolData.name)}</span>
        <span class="tool-result-toggle">${toolData.is_error ? '错误详情 ▾' : '展开结果 ▾'}</span>
      </div>
      <div class="tool-result-body" id="${resultId}">
        <pre>${escapeHtml(toolData.result)}</pre>
      </div>`;
    // 保存 tool_call_id 到消息对象
    const msgObj = assistantMessages.find(m => m.id === id);
    if (msgObj) {
      msgObj.tool_call_id = toolData.tool_call_id;
      msgObj.tool_name = toolData.name;
      msgObj.content = toolData.result;
    }
  } else if (role === 'assistant') {
    div.innerHTML = formatAssistantContent(content);
  } else {
    div.textContent = content;
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
}

function removeAssistantMessage(id) {
  const div = document.getElementById(id);
  if (div) div.remove();
  assistantMessages = assistantMessages.filter(m => m.id !== id);
}

function formatAssistantContent(text) {
  if (!text) return '';
  // 将 <think>...</think> 渲染为可折叠的思考块（在 escapeHtml 之前提取）
  const thinkBlocks = [];
  let processed = text.replace(/<think>([\s\S]*?)<\/think>/g, (_, think) => {
    const idx = thinkBlocks.length;
    thinkBlocks.push(think.trim());
    return `\x00THINK_${idx}\x00`;
  });
  let html = escapeHtml(processed);
  // 还原思考块为 HTML
  html = html.replace(/\x00THINK_(\d+)\x00/g, (_, idx) => {
    const thinkId = 'think-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6);
    return `<details class="think-block"><summary>思考过程</summary><div class="think-content" id="${thinkId}">${escapeHtml(thinkBlocks[parseInt(idx)])}</div></details>`;
  });
  // 代码块
  html = html.replace(/```([\s\S]*?)```/g, '<pre><code>$1</code></pre>');
  // 行内代码
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
  // 段落
  const paragraphs = html.split(/\n{2,}/);
  html = paragraphs.map(p => {
    p = p.trim();
    if (!p) return '';
    // 如果已经是 pre，不包 p
    if (p.startsWith('<pre>')) return p;
    // 列表项
    if (p.startsWith('- ') || p.startsWith('* ')) {
      const items = p.split('\n').filter(l => l.trim().startsWith('- ') || l.trim().startsWith('* '));
      return '<ul>' + items.map(i => `<li>${i.trim().slice(2)}</li>`).join('') + '</ul>';
    }
    // 数字列表
    if (/^\d+\./.test(p)) {
      const items = p.split('\n').filter(l => /^\d+\./.test(l.trim()));
      return '<ol>' + items.map(i => `<li>${i.trim().replace(/^\d+\.\s*/, '')}</li>`).join('') + '</ol>';
    }
    return '<p>' + p.replace(/\n/g, '<br>') + '</p>';
  }).join('');
  return html;
}

function clearAssistantChat() {
  assistantMessages = [];
  assistantConversationId = '';
  const trigger = document.getElementById('conversation-dropdown-trigger');
  if (trigger) trigger.textContent = '新会话';
  const savedModel = document.getElementById('assistant-model-select')?.value || '';
  populateProviderSelect();
  populateModelSelect();
  if (savedModel) {
    const modelSelect = document.getElementById('assistant-model-select');
    if (modelSelect && modelSelect.querySelector(`option[value="${savedModel}"]`)) {
      modelSelect.value = savedModel;
    }
  }
  contextTokens = 0;
  contextPercent = 0;
  contextMessages = 0;
  updateContextBar();
  const chat = document.getElementById('assistant-chat');
  if (!chat) return;
  chat.innerHTML = `
    <div class="assistant-welcome">
      <div class="assistant-welcome-icon">
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path></svg>
      </div>
      <h3>智控助手</h3>
      <p>我是你的 Protocol Proxy 智能助手，可以帮你：</p>
      <ul>
        <li>查询代理和供应商运行状态</li>
        <li>分析日志，定位异常原因</li>
        <li>解读配置并给出优化建议</li>
        <li>自然语言排障与问答</li>
      </ul>
      <p class="assistant-hint">请先选择一个运行中的代理作为对话后端</p>
    </div>
  `;
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

function updateMaxContext(value) {
  const v = Math.max(10000, parseInt(value) || 200000);
  contextMaxTokens = v;
  fetch('/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ maxContext: v }) }).catch(() => {});
  if (contextTokens > 0) {
    contextPercent = Math.round(contextTokens / contextMaxTokens * 1000) / 10;
    updateContextBar();
  }
}

function updateMaxRounds(value) {
  const v = Math.max(1, Math.min(100, parseInt(value) || 10));
  assistantMaxRounds = v;
  fetch('/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ maxRounds: v }) }).catch(() => {});
}

function updateMaxConversations(value) {
  const v = Math.max(0, parseInt(value) || 0);
  fetch('/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ maxConversations: v }) }).catch(() => {});
}

function toggleConversationDropdown() {
  const menu = document.getElementById('conversation-dropdown-menu');
  if (!menu) return;
  menu.classList.toggle('open');
}

function updateConversationTriggerLabel() {
  const trigger = document.getElementById('conversation-dropdown-trigger');
  if (!trigger) return;
  if (assistantConversationId) {
    const item = document.querySelector(`.conversation-dropdown-item[data-id="${assistantConversationId}"] .conversation-dropdown-item-label`);
    trigger.textContent = item ? item.textContent : assistantConversationId;
  } else {
    trigger.textContent = '新会话';
  }
}

async function deleteConversationById(convId, event) {
  event.stopPropagation();
  const ok = await showConfirm('确定删除该会话？');
  if (!ok) return;
  try {
    await fetch(`/api/assistant/conversations/${convId}`, { method: 'DELETE' });
    if (assistantConversationId === convId) clearAssistantChat();
    await loadConversations();
    showToast('会话已删除');
  } catch (err) {
    showToast('删除失败: ' + err.message, true);
  }
}

async function loadConversations() {
  try {
    const res = await fetch('/api/assistant/conversations');
    const data = await res.json();
    const menu = document.getElementById('conversation-dropdown-menu');
    if (!menu) return;
    const sorted = (data.conversations || []).slice().reverse();
    menu.innerHTML = '';
    for (const c of sorted) {
      const date = new Date(c.lastActivity).toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
      const label = (c.preview || '空会话').slice(0, 30) + ' — ' + date;
      const item = document.createElement('div');
      item.className = 'conversation-dropdown-item' + (c.id === assistantConversationId ? ' active' : '');
      item.dataset.id = c.id;
      item.innerHTML = `<span class="conversation-dropdown-item-label">${escapeHtml(label)}</span><button class="conversation-dropdown-item-delete" title="删除">×</button>`;
      item.querySelector('.conversation-dropdown-item-label').onclick = () => {
        menu.classList.remove('open');
        document.getElementById('conversation-dropdown-trigger').textContent = label;
        switchConversation(c.id);
      };
      item.querySelector('.conversation-dropdown-item-delete').onclick = (e) => deleteConversationById(c.id, e);
      menu.appendChild(item);
    }
    updateConversationTriggerLabel();
  } catch (err) {
    showToast('加载会话列表失败: ' + err.message, true);
  }
}

async function switchConversation(convId) {
  // 中断进行中的请求，避免旧流的 DOM 更新与新会话冲突
  if (assistantAbortController) {
    assistantAbortController.abort();
    assistantAbortController = null;
  }
  if (!convId) {
    // 选择"新会话"
    clearAssistantChat();
    return;
  }
  assistantConversationId = convId;
  assistantMessages = [];
  const chat = document.getElementById('assistant-chat');
  if (chat) chat.innerHTML = '';

  // 重置上下文栏，避免显示前一个会话的 token 统计
  contextTokens = 0;
  contextPercent = 0;
  contextMessages = 0;
  updateContextBar();

  try {
    const res = await fetch(`/api/assistant/conversations/${convId}/messages`);
    const data = await res.json();
    if (data.proxyId) {
      // 自动选中对应的代理
      const select = document.getElementById('assistant-proxy-select');
      if (select && select.querySelector(`option[value="${data.proxyId}"]`)) {
        select.value = data.proxyId;
        assistantProxyId = data.proxyId;
        document.getElementById('assistant-send-btn').disabled = false;
      }
      loadProxyProviders(data.proxyId);
    }
    // 渲染压缩摘要（如果有）
    if (data.compressionSummary) {
      const chatEl = document.getElementById('assistant-chat');
      if (chatEl) {
        const details = document.createElement('details');
        details.className = 'compression-summary';
        details.innerHTML = `<summary>之前的对话已被压缩</summary><div class="compression-summary-content">${escapeHtml(data.compressionSummary)}</div>`;
        chatEl.appendChild(details);
      }
    }
    // 渲染历史消息
    for (const m of (data.messages || [])) {
      if (m.role === 'user') {
        addAssistantMessage('user', m.content);
      } else if (m.role === 'assistant') {
        addAssistantMessage('assistant', m.content || '');
      }
    }
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
        ...(document.getElementById('assistant-provider-select')?.value && { providerId: document.getElementById('assistant-provider-select').value }),
        ...(document.getElementById('assistant-model-select')?.value && { model: document.getElementById('assistant-model-select').value }),
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
        ...(document.getElementById('assistant-provider-select')?.value && { providerId: document.getElementById('assistant-provider-select').value }),
        ...(document.getElementById('assistant-model-select')?.value && { model: document.getElementById('assistant-model-select').value }),
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
  const select = document.getElementById('assistant-model-select');
  if (!select || select.options.length === 0) {
    addAssistantMessage('assistant', '当前无可用模型。请先选择代理和供应商。');
    return;
  }
  const currentVal = select.value;
  const models = Array.from(select.options).map(o => ({
    value: o.value, label: o.textContent, selected: o.value === currentVal,
  }));
  const pickerId = addAssistantMessage('assistant', '');
  const items = models.map((m, i) =>
    `<div class="model-pick-item${m.selected ? ' selected' : ''}" data-model="${escapeHtml(m.value)}" data-index="${i}">${escapeHtml(m.label)}${m.selected ? ' (当前)' : ''}</div>`
  ).join('');
  const el = document.getElementById(pickerId);
  if (!el) return;

  el.innerHTML = `<strong>选择模型</strong><div class="model-picker" tabindex="0">${items}</div>`;
  const picker = el.querySelector('.model-picker');
  let activeIdx = models.findIndex(m => m.selected);
  if (activeIdx < 0) activeIdx = 0;

  function highlight(idx) {
    const all = picker.querySelectorAll('.model-pick-item');
    all.forEach((item, i) => item.classList.toggle('active', i === idx));
    if (all[idx]) all[idx].scrollIntoView({ block: 'nearest' });
  }

  function choose(idx) {
    const model = models[idx]?.value;
    if (!model) return;
    select.value = model;
    saveAssistantSelection();
    const label = models[idx].label;
    el.innerHTML = `已切换到 <strong>${escapeHtml(label)}</strong>`;
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
async function loadProxyProviders(proxyId) {
  // 保存用户当前选择，加载后恢复
  const prevProviderId = assistantProviderId;
  const prevModel = document.getElementById('assistant-model-select')?.value || '';

  assistantProviderId = '';
  proxyProviders = [];
  populateProviderSelect();
  populateModelSelect();
  if (!proxyId) return;
  try {
    const res = await fetch(`/api/assistant/proxy-providers/${proxyId}`);
    const data = await res.json();
    proxyProviders = data.providers || [];
    // 优先恢复初始化时保存的选择（页面加载一次性）
    if (savedAssistantProviderId && proxyProviders.find(p => p.id === savedAssistantProviderId)) {
      assistantProviderId = savedAssistantProviderId;
      savedAssistantProviderId = '';
    } else if (prevProviderId && proxyProviders.find(p => p.id === prevProviderId)) {
      // 恢复用户之前的选择
      assistantProviderId = prevProviderId;
    }
    populateProviderSelect();
    populateModelSelect();
    // 恢复模型选择
    const targetModel = savedAssistantModel || prevModel;
    if (targetModel) {
      const modelSelect = document.getElementById('assistant-model-select');
      if (modelSelect && modelSelect.querySelector(`option[value="${targetModel}"]`)) {
        modelSelect.value = targetModel;
      }
      if (savedAssistantModel) savedAssistantModel = '';
    }
  } catch (err) {
    console.warn('[assistant] 加载供应商列表失败:', err.message);
  }
}

function populateProviderSelect() {
  const select = document.getElementById('assistant-provider-select');
  if (!select) return;
  select.innerHTML = '<option value="">自动（跟随代理）</option>' +
    proxyProviders.map(p => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.name)} (${escapeHtml(p.protocol)})</option>`).join('');
  select.value = assistantProviderId;
}

function populateModelSelect() {
  const select = document.getElementById('assistant-model-select');
  if (!select) return;
  const provider = proxyProviders.find(p => p.id === assistantProviderId);
  const models = provider?.models || [];
  select.innerHTML = '<option value="">自动（跟随代理）</option>' +
    models.map(m => `<option value="${escapeHtml(m)}">${escapeHtml(m)}</option>`).join('');
}

// eslint-disable-next-line no-unused-vars
function onAssistantProviderChange(value) {
  assistantProviderId = value;
  populateModelSelect();
  saveAssistantSelection();
}

function saveAssistantSelection() {
  const modelVal = document.getElementById('assistant-model-select')?.value || '';
  fetch('/api/settings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ assistantProxyId, assistantProviderId, assistantModel: modelVal }),
  }).catch(() => {});
}

// 监听代理选择
(function() {
  const select = document.getElementById('assistant-proxy-select');
  if (select) {
    select.addEventListener('change', function() {
      assistantProxyId = this.value;
      const btn = document.getElementById('assistant-send-btn');
      if (btn) btn.disabled = !this.value;
      loadProxyProviders(this.value);
      saveAssistantSelection();
    });
  }
  // 监听模型选择
  const modelSelect = document.getElementById('assistant-model-select');
  if (modelSelect) {
    modelSelect.addEventListener('change', function() {
      saveAssistantSelection();
    });
  }
})();

// 点击外部关闭会话下拉
document.addEventListener('click', (e) => {
  const dropdown = document.getElementById('conversation-dropdown');
  if (dropdown && !dropdown.contains(e.target)) {
    document.getElementById('conversation-dropdown-menu')?.classList.remove('open');
  }
});

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
let pendingSkillFiles = null; // 待上传的文件夹 [{path, content(base64)}]

function reloadSkills() {
  fetch('/api/skills/reload', { method: 'POST' })
    .then(r => r.json())
    .then(() => loadSkills())
    .catch(() => loadSkills());
}

async function loadSkills() {
  try {
    const res = await fetch('/api/skills');
    const data = await res.json();
    allSkills = data.skills || [];
    renderSkills();
    const badge = document.getElementById('nav-skill-count');
    if (badge) badge.textContent = allSkills.length;
  } catch (err) {
    showToast('加载技能失败: ' + err.message, true);
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
      html += `<div class="skill-card">
        <div class="skill-card-header"><strong>${escapeHtml(s.name)}</strong></div>
        <div class="skill-card-desc">${escapeHtml(s.description || '无描述')}</div>
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
  };
}

function showSkillModal(name) {
  editingSkillName = name || '';
  pendingSkillFile = null;
  const isEdit = !!name;
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

// ==================== MCP 服务管理 ====================

let mcpServersData = [];
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
  document.querySelector('input[name="mcp-transport"][value="stdio"]').checked = true;
  toggleMcpTransport();

  if (name) {
    const s = mcpServersData.find(x => x.name === name);
    if (s) {
      document.getElementById('mcp-enabled').checked = s.enabled !== false;
      if (s.transport === 'http') {
        document.querySelector('input[name="mcp-transport"][value="http"]').checked = true;
        toggleMcpTransport();
        // 从 config 获取 url/headers
        fetch(`/api/mcp/servers/${encodeURIComponent(name)}`).then(r => r.json()).then(detail => {
          if (detail.config?.url) document.getElementById('mcp-url').value = detail.config.url;
          if (detail.config?.headers) {
            Object.entries(detail.config.headers).forEach(([k, v]) => addMcpHeaderRow(k, v));
          }
        });
      } else {
        fetch(`/api/mcp/servers/${encodeURIComponent(name)}`).then(r => r.json()).then(detail => {
          if (detail.config?.command) document.getElementById('mcp-command').value = detail.config.command;
          if (detail.config?.args) document.getElementById('mcp-args').value = (Array.isArray(detail.config.args) ? detail.config.args : [detail.config.args]).join(' ');
          if (detail.config?.env) {
            Object.entries(detail.config.env).forEach(([k, v]) => addMcpEnvRow(k, v));
          }
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

init();
