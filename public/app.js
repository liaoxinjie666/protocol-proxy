let proxies = [];
let editingId = null;

// ==================== 供应商管理（全局共享） ====================
const PROVIDERS_KEY = 'protocol-proxy-providers';

function loadProviders() {
  try {
    return JSON.parse(localStorage.getItem(PROVIDERS_KEY)) || [];
  } catch { return []; }
}

function saveProviders(providers) {
  localStorage.setItem(PROVIDERS_KEY, JSON.stringify(providers));
}

function addProvider(name, url) {
  const providers = loadProviders();
  if (providers.some(p => p.url === url)) return;
  providers.push({ id: 'p-' + Date.now(), name, url, protocol: detectProtocol(url) });
  saveProviders(providers);
}

function findProviderByUrl(url) {
  return loadProviders().find(p => p.url === url);
}

function getProviderDisplayName(url) {
  const p = findProviderByUrl(url);
  return p ? p.name : url;
}

function detectProtocol(url) {
  return /anthropic/i.test(url) ? 'anthropic' : 'openai';
}

// ==================== Model 管理（按供应商 URL） ====================
function getModelKey(providerUrl) {
  return providerUrl ? `protocol-proxy-models-${providerUrl}` : 'protocol-proxy-models-__new';
}

function loadModelsByProvider(providerUrl) {
  const saved = localStorage.getItem(getModelKey(providerUrl));
  if (saved) {
    try { return JSON.parse(saved); } catch { /* fall through */ }
  }
  return [];
}

function saveModelsByProvider(providerUrl, models) {
  const normalized = Array.from(new Set((models || []).map(m => m.trim()).filter(Boolean)));
  localStorage.setItem(getModelKey(providerUrl), JSON.stringify(normalized));
}

function addModel(providerUrl, name) {
  if (!providerUrl) return;
  const models = loadModelsByProvider(providerUrl);
  if (!models.includes(name)) {
    models.push(name);
    saveModelsByProvider(providerUrl, models);
  }
}

function removeModel(providerUrl, name) {
  const models = loadModelsByProvider(providerUrl).filter(m => m !== name);
  saveModelsByProvider(providerUrl, models);
}

function getCurrentProxyId() {
  return document.getElementById('modal').dataset.proxyId || null;
}

function getSelectedProviderUrl() {
  return document.getElementById('target-url').value || '';
}

// ==================== 供应商下拉框 ====================
function initProviderDropdown() {
  const trigger = document.getElementById('provider-dropdown-trigger');
  const dropdown = document.getElementById('provider-dropdown');
  const addNameInput = document.getElementById('provider-add-name');
  const addUrlInput = document.getElementById('provider-add-url');
  const addBtn = document.getElementById('provider-add-btn');

  trigger.addEventListener('click', (e) => {
    e.stopPropagation();
    dropdown.classList.toggle('open');
    if (dropdown.classList.contains('open')) {
      addNameInput.value = '';
      addUrlInput.value = '';
      renderProviderOptions();
      addNameInput.focus();
    }
  });

  document.addEventListener('click', (e) => {
    if (!dropdown.contains(e.target)) {
      dropdown.classList.remove('open');
    }
  });

  addBtn.addEventListener('click', () => {
    const name = addNameInput.value.trim();
    const url = addUrlInput.value.trim();
    if (!name || !url) {
      showToast('请填写供应商名称和地址', true);
      return;
    }
    addProvider(name, url);
    selectProvider(url);
    dropdown.classList.remove('open');
  });

  addUrlInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      addBtn.click();
    }
    if (e.key === 'Escape') {
      dropdown.classList.remove('open');
    }
  });

  addNameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      dropdown.classList.remove('open');
    }
  });
}

function renderProviderOptions() {
  const container = document.getElementById('provider-dropdown-options');
  const providers = loadProviders();
  const currentUrl = getSelectedProviderUrl();

  container.innerHTML = providers.map(p => `
    <div class="model-option${p.url === currentUrl ? ' selected' : ''}" data-url="${escapeHtml(p.url)}">
      <span class="model-option-name">${escapeHtml(p.name)}</span>
      <span style="color:#64748b;font-size:12px;margin-left:4px">${escapeHtml(p.url)}</span>
      <button type="button" class="model-option-delete" data-delete-url="${escapeHtml(p.url)}" title="删除此供应商">&times;</button>
    </div>
  `).join('');

  if (providers.length === 0) {
    container.innerHTML = '<div style="padding:8px 12px;color:#64748b;font-size:13px">暂无供应商，请在下方添加</div>';
  }

  container.querySelectorAll('.model-option').forEach(opt => {
    opt.addEventListener('click', (e) => {
      if (e.target.closest('.model-option-delete')) return;
      selectProvider(opt.dataset.url);
      document.getElementById('provider-dropdown').classList.remove('open');
    });
  });

  container.querySelectorAll('.model-option-delete').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const url = btn.dataset.deleteUrl;
      const p = findProviderByUrl(url);
      const ok = await showConfirm(`确定要删除供应商 <strong>${escapeHtml(p?.name || url)}</strong> 吗？`);
      if (!ok) return;
      const providers = loadProviders().filter(pr => pr.url !== url);
      saveProviders(providers);
      if (getSelectedProviderUrl() === url) {
        selectProvider('');
      }
      renderProviderOptions();
    });
  });
}

function selectProvider(url) {
  document.getElementById('target-url').value = url || '';
  const provider = findProviderByUrl(url);
  document.getElementById('target-protocol').value = url ? (provider?.protocol || detectProtocol(url)) : '';
  document.getElementById('provider-dropdown-value').textContent = url
    ? (provider ? `${provider.name} - ${url}` : url)
    : '选择供应商...';
  // 切换供应商后刷新模型列表
  renderModelOptions();
  updateModelAddState();
}

// ==================== Model 下拉框 ====================
function initModelDropdown() {
  const trigger = document.getElementById('model-dropdown-trigger');
  const dropdown = document.getElementById('model-dropdown');
  const addInput = document.getElementById('model-add-input');
  const addBtn = document.getElementById('model-add-btn');

  trigger.addEventListener('click', (e) => {
    e.stopPropagation();
    dropdown.classList.toggle('open');
    if (dropdown.classList.contains('open')) {
      addInput.value = '';
      addInput.focus();
    }
  });

  document.addEventListener('click', (e) => {
    if (!dropdown.contains(e.target)) {
      dropdown.classList.remove('open');
    }
  });

  addBtn.addEventListener('click', () => {
    const providerUrl = getSelectedProviderUrl();
    if (!providerUrl) {
      showToast('请先选择供应商地址', true);
      return;
    }
    const name = addInput.value.trim();
    if (!name) return;
    addModel(providerUrl, name);
    selectModel(name);
    renderModelOptions();
    addInput.value = '';
    addInput.focus();
  });

  addInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      addBtn.click();
    }
    if (e.key === 'Escape') {
      dropdown.classList.remove('open');
    }
  });
}

function renderModelOptions() {
  const container = document.getElementById('model-dropdown-options');
  const providerUrl = getSelectedProviderUrl();
  const models = providerUrl ? loadModelsByProvider(providerUrl) : [];
  const current = document.getElementById('target-model').value;

  container.innerHTML = models.map(m => `
    <div class="model-option${m === current ? ' selected' : ''}" data-model="${escapeHtml(m)}">
      <span class="model-option-name">${escapeHtml(m)}</span>
      <button type="button" class="model-option-delete" data-delete="${escapeHtml(m)}" title="删除此模型">&times;</button>
    </div>
  `).join('');

  if (!providerUrl) {
    container.innerHTML = '<div style="padding:8px 12px;color:#64748b;font-size:13px">请先选择供应商</div>';
  } else if (models.length === 0) {
    container.innerHTML = '<div style="padding:8px 12px;color:#64748b;font-size:13px">暂无模型，请在下方添加</div>';
  }

  container.querySelectorAll('.model-option').forEach(opt => {
    opt.addEventListener('click', (e) => {
      if (e.target.closest('.model-option-delete')) return;
      selectModel(opt.dataset.model);
      document.getElementById('model-dropdown').classList.remove('open');
    });
  });

  container.querySelectorAll('.model-option-delete').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const name = btn.dataset.delete;
      const ok = await showConfirm(`确定要删除模型 <strong>${escapeHtml(name)}</strong> 吗？`);
      if (!ok) return;
      removeModel(getSelectedProviderUrl(), name);
      if (document.getElementById('target-model').value === name) {
        selectModel('');
      }
      renderModelOptions();
    });
  });
}

function selectModel(value) {
  document.getElementById('target-model').value = value || '';
  document.getElementById('model-dropdown-value').textContent = value || '选择模型...';
  renderModelOptions();
}

function updateModelAddState() {
  const section = document.getElementById('model-add-section');
  const providerUrl = getSelectedProviderUrl();
  const addInput = document.getElementById('model-add-input');
  const addBtn = document.getElementById('model-add-btn');
  if (providerUrl) {
    addInput.disabled = false;
    addBtn.disabled = false;
    addInput.placeholder = '输入模型名称';
  } else {
    addInput.disabled = true;
    addBtn.disabled = true;
    addInput.placeholder = '请先选择供应商';
  }
}

function getSelectedModels() {
  const providerUrl = getSelectedProviderUrl();
  const models = providerUrl ? [...loadModelsByProvider(providerUrl)] : [];
  const current = document.getElementById('target-model').value.trim();
  if (current && !models.includes(current)) {
    models.unshift(current);
  }
  return Array.from(new Set(models));
}

// ==================== 初始化 ====================
function generateToken() {
  const arr = new Uint8Array(24);
  crypto.getRandomValues(arr);
  return Array.from(arr, b => b.toString(16).padStart(2, '0')).join('');
}

async function init() {
  await loadProxies();
  initProviderDropdown();
  initModelDropdown();
  document.getElementById('proxy-auth').addEventListener('change', (e) => {
    const enabled = e.target.value === 'true';
    document.getElementById('auth-token-group').style.display = enabled ? 'block' : 'none';
    if (enabled && !document.getElementById('proxy-auth-token').value) {
      document.getElementById('proxy-auth-token').value = generateToken();
    }
  });
}

async function loadProxies() {
  try {
    const res = await fetch('/api/proxies');
    proxies = await res.json();
    renderProxies();
    updateStats();
  } catch (err) {
    console.error('加载代理失败:', err);
    document.getElementById('proxy-list').innerHTML =
      '<div class="empty">加载失败，请刷新重试</div>';
  }
}

function updateStats() {
  document.getElementById('stat-total').textContent = proxies.length;
  document.getElementById('stat-running').textContent =
    proxies.filter(p => p.running).length;
}

// ==================== 代理地址复制 ====================
function getProxyUrl(port) {
  return `http://localhost:${port}`;
}

function copyProxyUrl(port, btn) {
  const url = getProxyUrl(port);
  navigator.clipboard.writeText(url).then(() => {
    showToast('代理地址已复制');
    const orig = btn.innerHTML;
    btn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 6L9 17l-5-5"/></svg> 已复制';
    setTimeout(() => { btn.innerHTML = orig; }, 1500);
  }).catch(() => {
    showToast('复制失败，请手动复制', true);
  });
}

function showConfirm(text) {
  return new Promise(resolve => {
    const modal = document.getElementById('confirm-modal');
    document.getElementById('confirm-text').innerHTML = text;
    modal.classList.add('active');

    const okBtn = document.getElementById('confirm-ok');
    const cancelBtn = document.getElementById('confirm-cancel');

    function cleanup(result) {
      modal.classList.remove('active');
      okBtn.removeEventListener('click', onOk);
      cancelBtn.removeEventListener('click', onCancel);
      resolve(result);
    }
    function onOk() { cleanup(true); }
    function onCancel() { cleanup(false); }

    okBtn.addEventListener('click', onOk);
    cancelBtn.addEventListener('click', onCancel);
  });
}

function showToast(msg, isError) {
  const existing = document.querySelector('.toast');
  if (existing) existing.remove();
  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.textContent = msg;
  if (isError) toast.style.background = '#ef4444';
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 2000);
}

// ==================== 渲染代理列表 ====================
function renderProxies() {
  const container = document.getElementById('proxy-list');
  if (proxies.length === 0) {
    container.innerHTML = '<div class="empty">暂无代理配置，点击右上角创建</div>';
    return;
  }

  container.innerHTML = proxies.map(p => {
    const t = p.target || {};
    const providerName = getProviderDisplayName(t.providerUrl || '');
    return `
    <div class="proxy-item">
      <div class="proxy-header">
        <div class="proxy-title">
          <h3>${escapeHtml(p.name)}</h3>
          <span class="badge ${p.running ? 'badge-running' : 'badge-stopped'}">
            ${p.running ? '运行中' : '已停止'}
          </span>
        </div>
      </div>
      <div class="proxy-meta">
        <span>端口: <strong>${p.port}</strong></span>
        <span>认证: ${p.requireAuth ? '已启用' : '未启用'}</span>
      </div>
      <div class="proxy-address">
        <code>${escapeHtml(getProxyUrl(p.port))}</code>
        <button class="copy-btn" onclick="copyProxyUrl(${p.port}, this)">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>
          复制
        </button>
      </div>
      <table class="target-table">
        <thead>
          <tr>
            <th>供应商</th>
            <th>协议</th>
            <th>默认 Model</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>${escapeHtml(providerName)}${providerName !== t.providerUrl ? ` <span style="color:#64748b;font-size:12px">(${escapeHtml(t.providerUrl)})</span>` : ''}</td>
            <td>
              <span class="badge" style="background:${t.protocol==='openai'?'#0c4a6e':'#581c87'};color:${t.protocol==='openai'?'#7dd3fc':'#e9d5ff'}">
                ${t.protocol || '-'}
              </span>
            </td>
            <td><code>${escapeHtml(t.defaultModel) || '-'}</code></td>
          </tr>
        </tbody>
      </table>
      <div class="proxy-actions">
        ${p.running
          ? `<button class="btn btn-danger" onclick="stopProxy('${p.id}')">停止</button>`
          : `<button class="btn btn-success" onclick="startProxy('${p.id}')">启动</button>`
        }
        <button class="btn" onclick="editProxy('${p.id}')">编辑</button>
        <button class="btn btn-danger" onclick="deleteProxy('${p.id}')">删除</button>
      </div>
    </div>
  `}).join('');
}

// ==================== 弹窗操作 ====================
function openModal(id = null) {
  editingId = id;
  document.getElementById('modal').dataset.proxyId = id || '';
  document.getElementById('modal-title').textContent = id ? '编辑代理' : '新建代理';
  document.getElementById('proxy-form').reset();

  if (id) {
    const p = proxies.find(x => x.id === id);
    if (!p) return;
    const t = p.target || {};
    document.getElementById('proxy-id').value = p.id;
    document.getElementById('proxy-name').value = p.name;
    document.getElementById('proxy-port').value = p.port;
    document.getElementById('proxy-auth').value = p.requireAuth ? 'true' : 'false';
    document.getElementById('proxy-auth-token').value = p.authToken || '';
    document.getElementById('auth-token-group').style.display = p.requireAuth ? 'block' : 'none';
    document.getElementById('target-key').value = t.apiKey || '';

    // 自动注册供应商到全局列表
    if (t.providerUrl && !findProviderByUrl(t.providerUrl)) {
      addProvider(getProviderDisplayName(t.providerUrl), t.providerUrl);
    }
    selectProvider(t.providerUrl || '');
    selectModel(t.defaultModel || '');
  } else {
    document.getElementById('proxy-id').value = '';
    document.getElementById('auth-token-group').style.display = 'none';
    selectProvider('');
    selectModel('');
  }

  updateModelAddState();
  document.getElementById('modal').classList.add('active');
}

function closeModal() {
  document.getElementById('modal').classList.remove('active');
  document.getElementById('model-dropdown').classList.remove('open');
  document.getElementById('provider-dropdown').classList.remove('open');
  editingId = null;
}

async function handleSubmit(e) {
  e.preventDefault();

  const providerUrl = getSelectedProviderUrl();
  if (!providerUrl) {
    showToast('请选择供应商地址', true);
    return;
  }

  const port = parseInt(document.getElementById('proxy-port').value);

  // 前端端口冲突校验
  const conflict = proxies.find(p => p.id !== editingId && p.port === port);
  if (conflict) {
    showToast(`端口 ${port} 已被代理「${conflict.name}」占用`, true);
    return;
  }

  const target = {
    providerUrl,
    protocol: detectProtocol(providerUrl),
    defaultModel: document.getElementById('target-model').value.trim() || undefined,
    models: getSelectedModels(),
    apiKey: document.getElementById('target-key').value.trim(),
  };

  const payload = {
    name: document.getElementById('proxy-name').value.trim(),
    port,
    requireAuth: document.getElementById('proxy-auth').value === 'true',
    authToken: document.getElementById('proxy-auth-token').value.trim() || null,
    target,
  };

  try {
    const url = editingId ? `/api/proxies/${editingId}` : '/api/proxies';
    const method = editingId ? 'PUT' : 'POST';
    const res = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    const result = await res.json();

    if (!res.ok) {
      showToast(result.error || '操作失败', true);
      await loadProxies();
      return;
    }

    closeModal();
    await loadProxies();
  } catch (err) {
    showToast('网络错误: ' + err.message, true);
    await loadProxies();
  }
}

// ==================== 代理操作 ====================
async function startProxy(id) {
  try {
    await fetch(`/api/proxies/${id}/start`, { method: 'POST' });
    await loadProxies();
  } catch (err) {
    alert('启动失败: ' + err.message);
  }
}

async function stopProxy(id) {
  try {
    await fetch(`/api/proxies/${id}/stop`, { method: 'POST' });
    await loadProxies();
  } catch (err) {
    alert('停止失败: ' + err.message);
  }
}

async function deleteProxy(id) {
  const p = proxies.find(x => x.id === id);
  const ok = await showConfirm(`确定要删除代理配置 <strong>${escapeHtml(p?.name || '')}</strong> 吗？`);
  if (!ok) return;
  try {
    await fetch(`/api/proxies/${id}`, { method: 'DELETE' });
    await loadProxies();
  } catch (err) {
    showToast('删除失败: ' + err.message, true);
  }
}

async function editProxy(id) {
  try {
    const res = await fetch(`/api/proxies/${id}`);
    if (!res.ok) throw new Error('加载失败');
    const full = await res.json();
    const idx = proxies.findIndex(p => p.id === id);
    if (idx !== -1) proxies[idx] = { ...proxies[idx], ...full };
    openModal(id);
  } catch (err) {
    showToast('加载代理配置失败: ' + err.message, true);
  }
}

// ==================== 工具函数 ====================
function escapeHtml(text) {
  if (!text) return '';
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

init();
