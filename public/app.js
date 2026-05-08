let proxies = [];
let editingId = null;

// ==================== Model 管理（按代理独立） ====================
function getLegacyModelKey(proxyId) {
  return `protocol-proxy-models-${proxyId || '__new'}`;
}

function getModelKey(proxyId) {
  return getLegacyModelKey(proxyId);
}

function loadLegacyModels(proxyId) {
  const saved = localStorage.getItem(getLegacyModelKey(proxyId));
  if (saved) {
    try { return JSON.parse(saved); } catch { /* fall through */ }
  }
  return [];
}

function loadModels(proxyId) {
  const proxy = proxyId ? proxies.find(p => p.id === proxyId) : null;
  const serverModels = proxy?.target?.models;
  if (Array.isArray(serverModels)) {
    return serverModels.filter(Boolean);
  }

  return loadLegacyModels(proxyId);
}

function saveModels(proxyId, models) {
  const normalized = Array.from(new Set((models || []).map(m => m.trim()).filter(Boolean)));
  if (proxyId) {
    const proxy = proxies.find(p => p.id === proxyId);
    if (proxy) {
      proxy.target = proxy.target || {};
      proxy.target.models = normalized;
    }
    return;
  }
  localStorage.setItem(getLegacyModelKey(proxyId), JSON.stringify(normalized));
}

function addModel(proxyId, name) {
  const models = loadModels(proxyId);
  if (!models.includes(name)) {
    models.push(name);
    saveModels(proxyId, models);
  }
}

function removeModel(proxyId, name) {
  const models = loadModels(proxyId).filter(m => m !== name);
  saveModels(proxyId, models);
}

function getCurrentProxyId() {
  return document.getElementById('modal').dataset.proxyId || null;
}

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
    const name = addInput.value.trim();
    if (!name) return;
    const proxyId = getCurrentProxyId();
    addModel(proxyId, name);
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
  const proxyId = getCurrentProxyId();
  const models = loadModels(proxyId);
  const current = document.getElementById('target-model').value;

  container.innerHTML = models.map(m => `
    <div class="model-option${m === current ? ' selected' : ''}" data-model="${escapeHtml(m)}">
      <span class="model-option-name">${escapeHtml(m)}</span>
      <button type="button" class="model-option-delete" data-delete="${escapeHtml(m)}" title="删除此模型">&times;</button>
    </div>
  `).join('');

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
      const pid = getCurrentProxyId();
      removeModel(pid, name);
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

function getSelectedModels() {
  const proxyId = getCurrentProxyId();
  const models = [...loadModels(proxyId), ...loadLegacyModels(proxyId)];
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
            <th>供应商地址</th>
            <th>协议</th>
            <th>默认 Model</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>${escapeHtml(t.providerUrl)}</td>
            <td>
              <span class="badge" style="background:${t.protocol==='openai'?'#0c4a6e':'#581c87'};color:${t.protocol==='openai'?'#7dd3fc':'#e9d5ff'}">
                ${t.protocol}
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
    document.getElementById('target-url').value = t.providerUrl || '';
    document.getElementById('target-protocol').value = t.protocol || 'openai';
    document.getElementById('target-key').value = t.apiKey || '';
    if ((!Array.isArray(t.models) || t.models.length === 0)) {
      const legacyModels = loadModels(id);
      if (legacyModels.length > 0) {
        p.target = p.target || {};
        p.target.models = legacyModels;
      }
    }
    selectModel(t.defaultModel || '');
  } else {
    document.getElementById('proxy-id').value = '';
    document.getElementById('auth-token-group').style.display = 'none';
    const models = loadModels(null);
    selectModel(models[0] || '');
  }

  document.getElementById('modal').classList.add('active');
}

function closeModal() {
  document.getElementById('modal').classList.remove('active');
  document.getElementById('model-dropdown').classList.remove('open');
  editingId = null;
}

async function handleSubmit(e) {
  e.preventDefault();

  const port = parseInt(document.getElementById('proxy-port').value);

  // 前端端口冲突校验
  const conflict = proxies.find(p => p.id !== editingId && p.port === port);
  if (conflict) {
    showToast(`端口 ${port} 已被代理「${conflict.name}」占用`, true);
    return;
  }

  const target = {
    providerUrl: document.getElementById('target-url').value.trim(),
    protocol: document.getElementById('target-protocol').value,
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

    // 新建代理后，将临时模型列表迁移到真实 ID 下
    if (!editingId && result.id) {
      const tempModels = loadModels(null);
      if (tempModels.length > 0) {
        saveModels(result.id, tempModels);
      }
      localStorage.removeItem(getModelKey(null));
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
    localStorage.removeItem(getModelKey(id));
    await loadProxies();
  } catch (err) {
    showToast('删除失败: ' + err.message, true);
  }
}

function editProxy(id) {
  openModal(id);
}

// ==================== 工具函数 ====================
function escapeHtml(text) {
  if (!text) return '';
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

init();
