let proxies = [];
let providers = [];
let editingId = null;

// ==================== 数据加载 ====================

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

async function loadProviders() {
  try {
    const res = await fetch('/api/providers');
    providers = await res.json();
  } catch (err) {
    console.error('加载供应商失败:', err);
    providers = [];
  }
}

function updateStats() {
  document.getElementById('stat-total').textContent = proxies.length;
  document.getElementById('stat-running').textContent =
    proxies.filter(p => p.running).length;
}

// ==================== 供应商下拉框 ====================

function initProviderDropdown() {
  const trigger = document.getElementById('provider-dropdown-trigger');
  const dropdown = document.getElementById('provider-dropdown');
  const addNameInput = document.getElementById('provider-add-name');
  const addUrlInput = document.getElementById('provider-add-url');
  const addKeyInput = document.getElementById('provider-add-key');
  const addBtn = document.getElementById('provider-add-btn');

  trigger.addEventListener('click', (e) => {
    e.stopPropagation();
    dropdown.classList.toggle('open');
    if (dropdown.classList.contains('open')) {
      editingProviderId = null;
      addNameInput.value = '';
      addUrlInput.value = '';
      addKeyInput.value = '';
      addUrlInput.disabled = false;
      addBtn.textContent = '添加';
      renderProviderOptions();
      addNameInput.focus();
    }
  });

  document.addEventListener('click', (e) => {
    if (!dropdown.contains(e.target)) {
      dropdown.classList.remove('open');
    }
  });

  addBtn.addEventListener('click', async () => {
    const name = addNameInput.value.trim();
    const url = addUrlInput.value.trim();
    const apiKey = addKeyInput.value.trim();
    if (!name || !url) {
      showToast('请填写供应商名称和地址', true);
      return;
    }
    try {
      let res;
      if (editingProviderId) {
        // 更新模式
        res = await fetch(`/api/providers/${editingProviderId}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, apiKey }),
        });
      } else {
        // 新增模式
        res = await fetch('/api/providers', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, url, apiKey }),
        });
      }
      if (!res.ok) {
        const err = await res.json();
        showToast(err.error || '操作失败', true);
        return;
      }
      const provider = await res.json();
      editingProviderId = null;
      addUrlInput.disabled = false;
      addBtn.textContent = '添加';
      addNameInput.value = '';
      addUrlInput.value = '';
      addKeyInput.value = '';
      await loadProviders();
      selectProvider(provider.id);
      renderProviderOptions();
    } catch (err) {
      showToast('操作失败: ' + err.message, true);
    }
  });

  addUrlInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); addBtn.click(); }
    if (e.key === 'Escape') dropdown.classList.remove('open');
  });
  addNameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') dropdown.classList.remove('open');
  });
}

let editingProviderId = null;

function renderProviderOptions() {
  const container = document.getElementById('provider-dropdown-options');
  const currentId = document.getElementById('provider-id').value;

  container.innerHTML = providers.map(p => `
    <div class="model-option${p.id === currentId ? ' selected' : ''}" data-id="${escapeHtml(p.id)}">
      <span class="model-option-name">${escapeHtml(p.name)}</span>
      ${p.name !== p.url ? `<span style="color:#64748b;font-size:12px;margin-left:4px">${escapeHtml(p.url)}</span>` : ''}
      <span style="margin-left:auto;display:flex;gap:4px">
        <button type="button" class="model-option-delete" data-edit-id="${escapeHtml(p.id)}" title="编辑此供应商" style="color:#60a5fa;font-size:14px">&#9998;</button>
        <button type="button" class="model-option-delete" data-delete-id="${escapeHtml(p.id)}" title="删除此供应商">&times;</button>
      </span>
    </div>
  `).join('');

  if (providers.length === 0) {
    container.innerHTML = '<div style="padding:8px 12px;color:#64748b;font-size:13px">暂无供应商，请在下方添加</div>';
  }

  container.querySelectorAll('.model-option').forEach(opt => {
    opt.addEventListener('click', (e) => {
      if (e.target.closest('.model-option-delete')) return;
      selectProvider(opt.dataset.id);
      document.getElementById('provider-dropdown').classList.remove('open');
    });
  });

  // 编辑供应商
  container.querySelectorAll('[data-edit-id]').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const id = btn.dataset.editId;
      try {
        const res = await fetch(`/api/providers/${id}`);
        if (!res.ok) throw new Error('加载失败');
        const p = await res.json();
        editingProviderId = id;
        document.getElementById('provider-add-name').value = p.name;
        document.getElementById('provider-add-url').value = p.url;
        document.getElementById('provider-add-key').value = p.apiKey || '';
        document.getElementById('provider-add-url').disabled = true;
        document.getElementById('provider-add-btn').textContent = '更新';
      } catch (err) {
        showToast('加载供应商失败: ' + err.message, true);
      }
    });
  });

  // 删除供应商
  container.querySelectorAll('[data-delete-id]').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const id = btn.dataset.deleteId;
      const p = providers.find(pr => pr.id === id);
      const ok = await showConfirm(`确定要删除供应商 <strong>${escapeHtml(p?.name || '')}</strong> 吗？`);
      if (!ok) return;
      try {
        const res = await fetch(`/api/providers/${id}`, { method: 'DELETE' });
        if (!res.ok) {
          const err = await res.json();
          showToast(err.error || '删除失败', true);
          return;
        }
        await loadProviders();
        if (document.getElementById('provider-id').value === id) {
          selectProvider('');
        }
        renderProviderOptions();
      } catch (err) {
        showToast('删除失败: ' + err.message, true);
      }
    });
  });
}

function selectProvider(id) {
  const provider = providers.find(p => p.id === id);
  document.getElementById('provider-id').value = id || '';
  document.getElementById('target-protocol').value = provider ? provider.protocol : '';
  document.getElementById('provider-dropdown-value').textContent = provider
    ? (provider.name !== provider.url ? `${provider.name} - ${provider.url}` : provider.url)
    : '选择供应商...';
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

  addBtn.addEventListener('click', async () => {
    const providerId = document.getElementById('provider-id').value;
    if (!providerId) {
      showToast('请先选择供应商', true);
      return;
    }
    const name = addInput.value.trim();
    if (!name) return;
    const provider = providers.find(p => p.id === providerId);
    if (!provider) return;
    const models = [...(provider.models || []), name];
    try {
      await fetch(`/api/providers/${providerId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ models }),
      });
      await loadProviders();
      selectModel(name);
      renderModelOptions();
      addInput.value = '';
      addInput.focus();
    } catch (err) {
      showToast('添加模型失败: ' + err.message, true);
    }
  });

  addInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); addBtn.click(); }
    if (e.key === 'Escape') dropdown.classList.remove('open');
  });
}

function renderModelOptions() {
  const container = document.getElementById('model-dropdown-options');
  const providerId = document.getElementById('provider-id').value;
  const provider = providers.find(p => p.id === providerId);
  const models = provider?.models || [];
  const current = document.getElementById('target-model').value;

  if (!providerId) {
    container.innerHTML = '<div style="padding:8px 12px;color:#64748b;font-size:13px">请先选择供应商</div>';
  } else if (models.length === 0) {
    container.innerHTML = '<div style="padding:8px 12px;color:#64748b;font-size:13px">暂无模型，请在下方添加</div>';
  } else {
    container.innerHTML = models.map(m => `
      <div class="model-option${m === current ? ' selected' : ''}" data-model="${escapeHtml(m)}">
        <span class="model-option-name">${escapeHtml(m)}</span>
        <button type="button" class="model-option-delete" data-delete="${escapeHtml(m)}" title="删除此模型">&times;</button>
      </div>
    `).join('');
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
      const provider = providers.find(p => p.id === providerId);
      if (!provider) return;
      const models = (provider.models || []).filter(m => m !== name);
      try {
        await fetch(`/api/providers/${providerId}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ models }),
        });
        await loadProviders();
        if (document.getElementById('target-model').value === name) {
          selectModel('');
        }
        renderModelOptions();
      } catch (err) {
        showToast('删除模型失败: ' + err.message, true);
      }
    });
  });
}

function selectModel(value) {
  document.getElementById('target-model').value = value || '';
  document.getElementById('model-dropdown-value').textContent = value || '选择模型...';
  renderModelOptions();
}

function updateModelAddState() {
  const providerId = document.getElementById('provider-id').value;
  const addInput = document.getElementById('model-add-input');
  const addBtn = document.getElementById('model-add-btn');
  if (providerId) {
    addInput.disabled = false;
    addBtn.disabled = false;
    addInput.placeholder = '输入模型名称';
  } else {
    addInput.disabled = true;
    addBtn.disabled = true;
    addInput.placeholder = '请先选择供应商';
  }
}

// ==================== 初始化 ====================

function generateToken() {
  const arr = new Uint8Array(24);
  crypto.getRandomValues(arr);
  return Array.from(arr, b => b.toString(16).padStart(2, '0')).join('');
}

async function init() {
  await Promise.all([loadProxies(), loadProviders()]);
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
            <td>${escapeHtml(p.providerName || p.providerUrl || '-')}</td>
            <td>
              <span class="badge" style="background:${p.protocol==='openai'?'#0c4a6e':'#581c87'};color:${p.protocol==='openai'?'#7dd3fc':'#e9d5ff'}">
                ${p.protocol || '-'}
              </span>
            </td>
            <td><code>${escapeHtml(p.defaultModel) || '-'}</code></td>
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
    document.getElementById('proxy-id').value = p.id;
    document.getElementById('proxy-name').value = p.name;
    document.getElementById('proxy-port').value = p.port;
    document.getElementById('proxy-auth').value = p.requireAuth ? 'true' : 'false';
    document.getElementById('proxy-auth-token').value = p.authToken || '';
    document.getElementById('auth-token-group').style.display = p.requireAuth ? 'block' : 'none';
    selectProvider(p.providerId || '');
    selectModel(p.defaultModel || '');
    // 加载供应商的 API Key
    if (p.providerId) {
      fetch(`/api/providers/${p.providerId}`).then(r => r.json()).then(provider => {
        document.getElementById('target-key').value = provider.apiKey || '';
      }).catch(() => {});
    }
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

  const providerId = document.getElementById('provider-id').value;
  if (!providerId) {
    showToast('请选择供应商', true);
    return;
  }

  const port = parseInt(document.getElementById('proxy-port').value);

  const conflict = proxies.find(p => p.id !== editingId && p.port === port);
  if (conflict) {
    showToast(`端口 ${port} 已被代理「${conflict.name}」占用`, true);
    return;
  }

  const apiKey = document.getElementById('target-key').value.trim();
  const protocol = document.getElementById('target-protocol').value;
  const defaultModel = document.getElementById('target-model').value.trim() || '';

  // 同步更新供应商配置
  const providerUpdates = {};
  if (apiKey) providerUpdates.apiKey = apiKey;
  if (protocol) providerUpdates.protocol = protocol;
  const selectedModels = [];
  const modelDropdown = document.getElementById('model-dropdown-value').textContent;
  if (defaultModel) selectedModels.push(defaultModel);
  if (Object.keys(providerUpdates).length > 0 || selectedModels.length > 0) {
    try {
      await fetch(`/api/providers/${providerId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(providerUpdates),
      });
      await loadProviders();
    } catch {}
  }

  const payload = {
    name: document.getElementById('proxy-name').value.trim(),
    port,
    requireAuth: document.getElementById('proxy-auth').value === 'true',
    authToken: document.getElementById('proxy-auth-token').value.trim() || null,
    providerId,
    defaultModel,
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
