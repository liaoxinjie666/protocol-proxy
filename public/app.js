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

// ---------- Theme ----------
const THEMES = [
  { id: 'dark', icon: '\u263E', label: '\u6df1\u8272' },
  { id: 'light', icon: '\u2600', label: '\u6d45\u8272' },
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

init();
