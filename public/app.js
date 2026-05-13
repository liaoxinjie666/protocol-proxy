let proxies = [];
let providers = [];
let editingId = null;
let editingProviderId = null;
let importData = null;
let statsRange = 'daily';
let statsProxyId = '';
let providerPoolItems = [];

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

function parseProviderPool(value) {
  const text = (value || '').trim();
  if (!text) return [];
  const seen = new Set();
  const items = [];
  for (const part of text.split(/[\n,]/)) {
    const token = part.trim();
    if (!token) continue;
    const [providerIdRaw, modelRaw, weightRaw] = token.split(':');
    const providerId = (providerIdRaw || '').trim();
    if (!providerId) continue;
    const model = (modelRaw || '').trim();
    const key = `${providerId}\0${model}`;
    if (seen.has(key)) continue;
    seen.add(key);
    items.push({ providerId, model, weight: Math.max(1, parseInt((weightRaw || '1').trim(), 10) || 1) });
  }
  return items;
}

function formatProviderPool(pool) {
  if (!Array.isArray(pool) || pool.length === 0) return '';
  return pool.map(item => {
    const w = Math.max(1, parseInt(item.weight, 10) || 1);
    return item.model ? `${item.providerId}:${item.model}:${w}` : `${item.providerId}::${w}`;
  }).join(', ');
}

function syncSimpleDropdown(dropdownId, value, hiddenInputId) {
  const dropdown = document.getElementById(dropdownId);
  if (!dropdown) return value;
  const hiddenInput = document.getElementById(hiddenInputId || dropdownId.replace('-dropdown', ''));
  const valueEl = dropdown.querySelector('[id$="-dropdown-value"]');
  const options = Array.from(dropdown.querySelectorAll('.model-option'));
  const nextValue = options.some(opt => opt.dataset.value === value)
    ? value
    : (options[0]?.dataset.value || '');
  options.forEach(opt => opt.classList.toggle('selected', opt.dataset.value === nextValue));
  if (hiddenInput) hiddenInput.value = nextValue;
  const selected = options.find(opt => opt.dataset.value === nextValue);
  if (valueEl && selected) {
    valueEl.textContent = selected.querySelector('.model-option-name')?.textContent || valueEl.textContent;
  }
  return nextValue;
}

function syncProviderPoolState(items) {
  providerPoolItems = Array.isArray(items)
    ? items
        .filter(item => item && item.providerId)
        .map(item => ({
          providerId: item.providerId,
          model: typeof item.model === 'string' ? item.model : '',
          weight: Math.max(1, parseInt(item.weight, 10) || 1),
        }))
    : [];
  renderProviderPoolEditor();
}

function addProviderToPool(providerId, model) {
  if (!providerId) return;
  const m = model || '';
  if (providerPoolItems.some(item => item.providerId === providerId && (item.model || '') === m)) return;
  providerPoolItems = [...providerPoolItems, { providerId, model: m, weight: 1 }];
  renderProviderPoolEditor();
}

function removeProviderFromPool(providerId, model) {
  const m = model || '';
  providerPoolItems = providerPoolItems.filter(item => !(item.providerId === providerId && (item.model || '') === m));
  renderProviderPoolEditor();
}

function updateProviderPoolWeight(providerId, model, weight) {
  const m = model || '';
  providerPoolItems = providerPoolItems.map(item => (
    item.providerId === providerId && (item.model || '') === m
      ? { ...item, weight: Math.max(1, parseInt(weight, 10) || 1) }
      : item
  ));
}

function renderProviderPoolEditor() {
  const container = document.getElementById('provider-pool-list');
  const select = document.getElementById('provider-pool-dropdown-options');
  const valueEl = document.getElementById('provider-pool-dropdown-value');
  const dropdown = document.getElementById('provider-pool-dropdown');
  if (!container || !select || !valueEl || !dropdown) return;

  const primaryId = document.getElementById('provider-id').value;
  const defaultModel = document.getElementById('target-model').value;
  // All providers available (including primary, for different models)
  const available = providers.filter(p => p.id);

  // Build dropdown: show providers, each expandable to models
  select.innerHTML = available.length === 0
    ? '<div class="model-option"><span class="model-option-name">暂无可添加供应商</span></div>'
    : available.map(p => {
        const models = p.models || [];
        const isPrimary = p.id === primaryId;
        // Filter out already-added provider+model combos
        const usedModels = new Set(
          providerPoolItems
            .filter(item => item.providerId === p.id)
            .map(item => item.model || '')
        );
        // For primary provider, also exclude its default model (already in use)
        if (isPrimary && defaultModel) usedModels.add(defaultModel);
        const availModels = models.filter(m => !usedModels.has(m));
        // "any model" not available for primary (already covered by defaultModel)
        const anyModelUsed = usedModels.has('');
        const showAnyModel = !isPrimary && !anyModelUsed;
        return `
          <div class="pool-provider-group" data-pool-provider="${escapeHtml(p.id)}">
            <div class="model-option pool-provider-trigger" data-pool-provider-id="${escapeHtml(p.id)}">
              <span class="model-option-name">${escapeHtml(p.name)}</span>
              ${p.url ? `<span style="color:#64748b;font-size:12px;margin-left:4px">${escapeHtml(p.url)}</span>` : ''}
              <span class="pool-provider-arrow">&#9656;</span>
            </div>
            <div class="pool-model-sublist" data-pool-models-for="${escapeHtml(p.id)}">
              ${showAnyModel ? `<div class="model-option pool-model-option" data-pool-provider-id="${escapeHtml(p.id)}" data-pool-model=""><span class="model-option-name">不指定模型（使用请求模型）</span></div>` : ''}
              ${availModels.map(m => `<div class="model-option pool-model-option" data-pool-provider-id="${escapeHtml(p.id)}" data-pool-model="${escapeHtml(m)}"><span class="model-option-name">${escapeHtml(m)}</span></div>`).join('')}
              ${availModels.length === 0 && !showAnyModel ? '<div class="model-option"><span class="model-option-name">该供应商所有模型已添加</span></div>' : ''}
            </div>
          </div>
        `;
      }).join('');

  valueEl.textContent = available.length === 0 ? '暂无可添加供应商' : '从供应商列表添加';

  // Provider click → toggle model sub-list
  select.querySelectorAll('.pool-provider-trigger').forEach(trigger => {
    trigger.addEventListener('click', (e) => {
      e.stopPropagation();
      const group = trigger.closest('.pool-provider-group');
      const wasOpen = group.classList.contains('open');
      // Close all other sub-lists
      select.querySelectorAll('.pool-provider-group').forEach(g => g.classList.remove('open'));
      if (!wasOpen) group.classList.add('open');
    });
  });

  // Model click → add to pool
  select.querySelectorAll('.pool-model-option').forEach(opt => {
    opt.addEventListener('click', () => {
      addProviderToPool(opt.dataset.poolProviderId, opt.dataset.poolModel || '');
      dropdown.classList.remove('open');
      select.querySelectorAll('.pool-provider-group').forEach(g => g.classList.remove('open'));
    });
  });

  // Render pool items
  container.innerHTML = providerPoolItems.length === 0
    ? '<div class="provider-pool-empty">暂无备选供应商，使用上方下拉框添加</div>'
    : providerPoolItems.map(item => {
        const provider = providers.find(p => p.id === item.providerId);
        const modelLabel = item.model || '使用请求模型';
        return `
          <div class="provider-pool-item">
            <div class="provider-pool-main">
              <div class="provider-pool-name">${escapeHtml(provider?.name || item.providerId)}</div>
              <div class="provider-pool-meta">${escapeHtml(provider?.url || '')}</div>
            </div>
            <div class="provider-pool-model">
              <label>模型</label>
              <span class="provider-pool-model-value">${escapeHtml(modelLabel)}</span>
            </div>
            <div class="provider-pool-weight">
              <label>权重</label>
              <input type="number" min="1" step="1" value="${Math.max(1, parseInt(item.weight, 10) || 1)}" data-weight-provider="${escapeHtml(item.providerId)}" data-weight-model="${escapeHtml(item.model || '')}">
            </div>
            <button type="button" class="provider-pool-remove" data-remove-provider="${escapeHtml(item.providerId)}" data-remove-model="${escapeHtml(item.model || '')}">移除</button>
          </div>
        `;
      }).join('');

  container.querySelectorAll('[data-weight-provider]').forEach(input => {
    const handler = () => updateProviderPoolWeight(input.dataset.weightProvider, input.dataset.weightModel, input.value);
    input.addEventListener('change', handler);
    input.addEventListener('input', handler);
  });

  container.querySelectorAll('[data-remove-provider]').forEach(btn => {
    btn.addEventListener('click', () => removeProviderFromPool(btn.dataset.removeProvider, btn.dataset.removeModel));
  });
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
      editingProviderId = null;
      addNameInput.value = '';
      addUrlInput.value = '';
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
          body: JSON.stringify({ name }),
        });
      } else {
        // 新增模式
        res = await fetch('/api/providers', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, url }),
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

function attachMaskedKeyClick(span) {
  span.style.cursor = 'pointer';
  span.title = '点击修改 API Key';
  span.addEventListener('click', () => {
    const row = span.closest('.api-key-entry');
    const group = span.parentElement;
    const input = document.createElement('input');
    input.type = 'password';
    input.className = 'api-key-input';
    input.placeholder = '输入新的 API Key...';
    group.replaceChild(input, span);
    input.focus();
    input.addEventListener('blur', async () => {
      const val = input.value.trim();
      if (!val) {
        restoreMaskedSpan(group, input, row);
        return;
      }
      if (await showConfirm('确认修改此 API Key？<br>取消将恢复为 ****', '确认修改')) {
        row.dataset.masked = 'false';
      } else {
        row.dataset.masked = 'true';
        restoreMaskedSpan(group, input, row);
      }
    });
  });
}

function restoreMaskedSpan(group, input, row) {
  const restored = document.createElement('span');
  restored.className = 'api-key-display';
  restored.textContent = '****';
  group.replaceChild(restored, input);
  attachMaskedKeyClick(restored);
}

function renderApiKeys(provider) {
  const container = document.getElementById('api-keys-list');
  if (!container) return;
  const keys = provider?.apiKeys || [];
  const hasKeys = keys.length > 0;
  const items = hasKeys ? keys : [{ alias: '', masked: false, key: '', index: 0 }];
  container.innerHTML = items.map((k, i) => `
    <div class="form-row api-key-entry" data-index="${k.index ?? i}" data-masked="${k.masked ? 'true' : 'false'}" ${!hasKeys ? 'data-new="true"' : ''}>
      <div class="form-group">
        <label>别名</label>
        <input type="text" class="api-key-alias" value="${escapeHtml(k.alias || '')}" placeholder="可选">
      </div>
      <div class="form-group">
        <label>API Key</label>
        ${k.masked
          ? `<span class="api-key-display">****</span>`
          : `<input type="password" class="api-key-input" value="${escapeHtml(k.key || '')}" placeholder="sk-...">`
        }
      </div>
      <label class="toggle-switch" title="${k.enabled !== false ? '已启用' : '已禁用'}">
        <input type="checkbox" class="api-key-enabled" ${k.enabled !== false ? 'checked' : ''}>
        <span class="toggle-slider"></span>
      </label>
      <button type="button" class="api-key-remove" title="移除">&times;</button>
    </div>
  `).join('');

  container.querySelectorAll('.api-key-display').forEach(span => {
    attachMaskedKeyClick(span);
  });

  container.querySelectorAll('.api-key-remove').forEach(btn => {
    btn.addEventListener('click', () => {
      btn.closest('.api-key-entry').remove();
      if (container.children.length === 0) renderApiKeys(null);
    });
  });
}

function collectApiKeys() {
  const rows = document.querySelectorAll('#api-keys-list .api-key-entry');
  return Array.from(rows).map(row => {
    const alias = row.querySelector('.api-key-alias')?.value.trim() || '';
    const enabled = row.querySelector('.api-key-enabled')?.checked !== false;
    const isMasked = row.dataset.masked === 'true';
    if (isMasked) {
      return { alias, masked: true, index: parseInt(row.dataset.index, 10), enabled };
    }
    const key = row.querySelector('.api-key-input')?.value.trim() || '';
    if (!key) return null;
    return { key, alias, enabled };
  }).filter(Boolean);
}

function initApiKeyAddBtn() {
  const btn = document.getElementById('api-key-add-btn');
  if (!btn) return;
  btn.addEventListener('click', () => {
    const container = document.getElementById('api-keys-list');
    const row = document.createElement('div');
    row.className = 'form-row api-key-entry';
    row.dataset.new = 'true';
    row.innerHTML = `
      <div class="form-group"><label>别名</label><input type="text" class="api-key-alias" placeholder="可选"></div>
      <div class="form-group"><label>API Key</label><input type="password" class="api-key-input" placeholder="sk-..."></div>
      <label class="toggle-switch" title="已启用"><input type="checkbox" class="api-key-enabled" checked><span class="toggle-slider"></span></label>
      <button type="button" class="api-key-remove" title="移除">&times;</button>
    `;
    container.appendChild(row);
    row.querySelector('.api-key-alias').focus();
    row.querySelector('.api-key-remove').addEventListener('click', () => {
      row.remove();
      if (container.children.length === 0) renderApiKeys(null);
    });
  });
}

function hasUnsavedMaskedKeyEdits() {
  return !!document.querySelector('#api-keys-list .api-key-entry[data-index][data-masked="false"]');
}

async function selectProvider(id) {
  if (hasUnsavedMaskedKeyEdits() && !await showConfirm('当前有未保存的 API Key 修改，切换供应商将丢失，确认切换？', '确认切换')) return;
  const provider = providers.find(p => p.id === id);
  document.getElementById('provider-id').value = id || '';
  const protocol = provider ? provider.protocol : '';
  document.getElementById('target-protocol').value = protocol;
  // 同步协议自定义下拉框
  document.querySelectorAll('#protocol-dropdown .model-option').forEach(o => o.classList.remove('selected'));
  const protoOpt = document.querySelector(`#protocol-dropdown .model-option[data-value="${protocol}"]`);
  if (protoOpt) {
    protoOpt.classList.add('selected');
    document.getElementById('protocol-dropdown-value').textContent = protoOpt.querySelector('.model-option-name').textContent;
  } else {
    document.getElementById('protocol-dropdown-value').textContent = '选择协议...';
  }
  document.getElementById('provider-dropdown-value').textContent = provider
    ? (provider.name !== provider.url ? `${provider.name} - ${provider.url}` : provider.url)
    : '选择供应商...';
  // 切换供应商后模型自动选为该供应商模型列表的第一个
  const models = provider?.models || [];
  selectModel(models[0] || '');
  updateModelAddState();
  // 同步 API Keys
  renderApiKeys(provider);
  // 同步 Azure 字段
  document.getElementById('target-azure-deployment').value = provider?.azureDeployment || '';
  document.getElementById('target-azure-version').value = provider?.azureApiVersion || '';
  document.getElementById('azure-fields').style.display = protocol === 'openai' ? '' : 'none';
  // Only remove pool entries matching this provider's default model (allow other models)
  const currentModel = models[0] || '';
  providerPoolItems = providerPoolItems.filter(item => !(item.providerId === id && (!item.model || item.model === currentModel)));
  renderProviderPoolEditor();
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

// ==================== 配置导入/导出 ====================

async function exportConfig() {
  try {
    const res = await fetch('/api/config/export');
    const data = await res.json();
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    a.href = url;
    a.download = `config-backup-${date}.json`;
    a.click();
    URL.revokeObjectURL(url);
    showToast('配置已导出');
  } catch (err) {
    showToast('导出失败: ' + err.message, true);
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
        showToast('配置格式错误：需要 providers 和 proxies 数组', true);
        return;
      }
      importData = data;
      document.getElementById('import-providers-count').textContent = data.providers.length;
      document.getElementById('import-proxies-count').textContent = data.proxies.length;
      document.getElementById('import-modal').classList.add('active');
    } catch (err) {
      showToast('文件解析失败: ' + err.message, true);
    }
  };
  reader.readAsText(file);
}

function closeImportModal() {
  document.getElementById('import-modal').classList.remove('active');
  importData = null;
}

async function confirmImport() {
  if (!importData) return;
  const mode = document.querySelector('input[name="import-mode"]:checked')?.value || 'merge';

  if (mode === 'overwrite') {
    const ok = await showConfirm('确认<strong>覆盖</strong>现有配置？此操作不可撤销。');
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
      showToast(result.error || '导入失败', true);
      return;
    }

    closeImportModal();
    await Promise.all([loadProxies(), loadProviders()]);

    const added = result.added;
    let msg = `导入成功（${mode === 'overwrite' ? '覆盖' : '合并'}）`;
    if (added) msg += `：新增 ${added.providers} 供应商、${added.proxies} 代理`;

    const restart = await showConfirm(`${msg}。<br><br>运行中的代理需要重启才能应用变更，新增的代理需要手动启动。<br><br>是否立即重启所有代理？`);
    if (restart) {
      await restartAllProxies();
    }
  } catch (err) {
    showToast('导入失败: ' + err.message, true);
  }
}

async function restartAllProxies() {
  try {
    // 先停掉所有运行中的代理（不管 ID 是否匹配新配置）
    const statusRes = await fetch('/api/status');
    const status = await statusRes.json();
    const runningIds = (status.running || []).map(r => r.id);
    for (const id of runningIds) {
      await fetch(`/api/proxies/${id}/stop`, { method: 'POST' });
    }
    // 重新加载配置
    await loadProxies();
    // 按新配置启动所有代理
    for (const p of proxies) {
      await fetch(`/api/proxies/${p.id}/start`, { method: 'POST' });
    }
    await loadProxies();
    showToast('所有代理已重启');
  } catch (err) {
    showToast('重启失败: ' + err.message, true);
  }
}

// ==================== 初始化 ====================

// ==================== Token 用量统计 ====================

async function loadStats() {
  try {
    const params = new URLSearchParams({ range: statsRange });
    if (statsProxyId) params.set('proxyId', statsProxyId);
    const startDate = document.getElementById('stats-start-date')?.value;
    const endDate = document.getElementById('stats-end-date')?.value;
    if (startDate) params.set('startDate', startDate);
    if (endDate) params.set('endDate', endDate);
    const res = await fetch('/api/stats?' + params);
    const data = await res.json();
    renderStatsSummary(data.summary);
    renderStatsBreakdown(data);
    renderStatsProxyOptions(data.proxies || []);
  } catch (err) {
    console.error('加载统计失败:', err);
  }
}

function renderStatsSummary(summary) {
  document.getElementById('stats-total-tokens').textContent = formatTokens(summary.total);
  document.getElementById('stats-prompt-tokens').textContent = formatTokens(summary.prompt);
  document.getElementById('stats-completion-tokens').textContent = formatTokens(summary.completion);
  document.getElementById('stats-total-requests').textContent = summary.requests.toLocaleString();
  const badge = document.getElementById('stats-estimated-badge');
  if (badge) badge.style.display = summary.hasEstimated ? 'inline' : 'none';
}

function formatTokens(n) {
  if (!n || n === 0) return '0';
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
  return n.toLocaleString();
}

function renderStatsBreakdown(data) {
  const container = document.getElementById('stats-breakdown');
  const { byProvider, byModel, summary } = data;

  if (!byProvider || byProvider.length === 0) {
    container.innerHTML = '<div class="empty">暂无数据</div>';
    return;
  }

  let html = '<table class="stats-table"><thead><tr>';
  html += '<th>供应商</th><th>模型</th><th style="text-align:right">请求数</th>';
  html += '<th style="text-align:right">输入 Token</th><th style="text-align:right">输出 Token</th>';
  html += '<th style="text-align:right">合计</th>';
  html += '</tr></thead><tbody>';

  for (const item of byModel) {
    const prefix = item.hasEstimated ? '~' : '';
    html += '<tr>';
    html += `<td class="provider-cell">${escapeHtml(item.provider)}</td>`;
    html += `<td class="model-cell"><code>${escapeHtml(item.model)}</code></td>`;
    html += `<td class="num">${item.requests.toLocaleString()}</td>`;
    html += `<td class="num">${prefix ? `<span class="num-estimated" title="估算值">~</span>` : ''}${formatTokens(item.prompt)}</td>`;
    html += `<td class="num">${prefix ? `<span class="num-estimated" title="估算值">~</span>` : ''}${formatTokens(item.completion)}</td>`;
    html += `<td class="num">${prefix ? `<span class="num-estimated" title="估算值">~</span>` : ''}${formatTokens(item.total)}</td>`;
    html += '</tr>';
  }

  html += '</tbody>';
  html += '<tfoot><tr>';
  html += '<td colspan="2">合计</td>';
  html += `<td class="num">${summary.requests.toLocaleString()}</td>`;
  html += `<td class="num">${formatTokens(summary.prompt)}</td>`;
  html += `<td class="num">${formatTokens(summary.completion)}</td>`;
  html += `<td class="num">${formatTokens(summary.total)}</td>`;
  html += '</tr></tfoot></table>';

  container.innerHTML = html;
}

function renderStatsProxyOptions(proxyList) {
  const container = document.getElementById('stats-proxy-dropdown-options');
  container.innerHTML = `<div class="model-option${!statsProxyId ? ' selected' : ''}" data-proxy-id="">
    <span class="model-option-name">全部代理</span>
  </div>` + proxyList.map(p => `
    <div class="model-option${p.id === statsProxyId ? ' selected' : ''}" data-proxy-id="${escapeHtml(p.id)}">
      <span class="model-option-name">${escapeHtml(p.name)}</span>
      ${p.providerName ? `<span style="color:#64748b;font-size:12px;margin-left:4px">${escapeHtml(p.providerName)}</span>` : ''}
    </div>
  `).join('');

  container.querySelectorAll('.model-option').forEach(opt => {
    opt.addEventListener('click', () => {
      statsProxyId = opt.dataset.proxyId;
      document.getElementById('stats-proxy-dropdown-value').textContent =
        statsProxyId ? (proxyList.find(p => p.id === statsProxyId)?.name || '全部代理') : '全部代理';
      document.getElementById('stats-proxy-dropdown').classList.remove('open');
      container.querySelectorAll('.model-option').forEach(o => o.classList.remove('selected'));
      opt.classList.add('selected');
      loadStats();
    });
  });
}

function initStatsDropdown() {
  const trigger = document.getElementById('stats-proxy-dropdown-trigger');
  const dropdown = document.getElementById('stats-proxy-dropdown');

  trigger.addEventListener('click', (e) => {
    e.stopPropagation();
    dropdown.classList.toggle('open');
  });

  document.addEventListener('click', (e) => {
    if (!dropdown.contains(e.target)) {
      dropdown.classList.remove('open');
    }
  });
}

function initStatsRangeBtns() {
  document.querySelectorAll('.stats-range-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.stats-range-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      statsRange = btn.dataset.range;
      // 清空日期选择器，显示全部数据
      document.getElementById('stats-start-date').value = '';
      document.getElementById('stats-end-date').value = '';
      loadStats();
    });
  });
  // 日期选择器变化时自动加载
  document.getElementById('stats-start-date').addEventListener('change', loadStats);
  document.getElementById('stats-end-date').addEventListener('change', loadStats);
}

function generateToken() {
  const arr = new Uint8Array(24);
  crypto.getRandomValues(arr);
  return Array.from(arr, b => b.toString(16).padStart(2, '0')).join('');
}

function initSimpleDropdown(dropdownId, onChange, hiddenInputId) {
  const dropdown = document.getElementById(dropdownId);
  const trigger = dropdown.querySelector('.model-dropdown-trigger');
  const valueEl = dropdown.querySelector('[id$="-dropdown-value"]');
  const hiddenInput = document.getElementById(hiddenInputId || dropdownId.replace('-dropdown', ''));
  const opts = dropdown.querySelectorAll('.model-option');

  trigger.addEventListener('click', (e) => {
    e.stopPropagation();
    dropdown.classList.toggle('open');
  });

  document.addEventListener('click', (e) => {
    if (!dropdown.contains(e.target)) {
      dropdown.classList.remove('open');
    }
  });

  opts.forEach(opt => {
    opt.addEventListener('click', () => {
      const val = syncSimpleDropdown(dropdownId, opt.dataset.value, hiddenInput?.id);
      onChange?.(val);
      dropdown.classList.remove('open');
    });
  });

  syncSimpleDropdown(dropdownId, hiddenInput?.value || opts[0]?.dataset.value || '', hiddenInput?.id);
}

function initProviderPoolDropdown() {
  const dropdown = document.getElementById('provider-pool-dropdown');
  const trigger = document.getElementById('provider-pool-dropdown-trigger');
  if (!dropdown || !trigger) return;

  trigger.addEventListener('click', (e) => {
    e.stopPropagation();
    renderProviderPoolEditor();
    dropdown.classList.toggle('open');
  });

  document.addEventListener('click', (e) => {
    if (!dropdown.contains(e.target)) dropdown.classList.remove('open');
  });
}

async function init() {
  await Promise.all([loadProxies(), loadProviders(), loadStats()]);
  renderProxies();
  initProviderDropdown();
  initModelDropdown();
  initStatsDropdown();
  initStatsRangeBtns();
  initProviderPoolDropdown();
  initApiKeyAddBtn();
  initSimpleDropdown('auth-dropdown', (val) => {
    const enabled = val === 'true';
    document.getElementById('auth-token-group').style.display = enabled ? 'block' : 'none';
    if (enabled && !document.getElementById('proxy-auth-token').value) {
      document.getElementById('proxy-auth-token').value = generateToken();
    }
  });
  initSimpleDropdown('protocol-dropdown', (val) => {
    document.getElementById('azure-fields').style.display = val === 'openai' ? '' : 'none';
  }, 'target-protocol');
  initSimpleDropdown('routing-dropdown', (val) => {
    document.getElementById('routing-strategy').value = val;
  }, 'routing-strategy');
  renderProviderPoolEditor();
  // 初始状态：根据当前协议值决定 Azure 字段显示
  const initProto = document.getElementById('target-protocol').value;
  document.getElementById('azure-fields').style.display = initProto === 'openai' ? '' : 'none';
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

function showConfirm(text, okText = '删除') {
  return new Promise(resolve => {
    const modal = document.getElementById('confirm-modal');
    document.getElementById('confirm-text').innerHTML = text;
    const okBtn = document.getElementById('confirm-ok');
    const cancelBtn = document.getElementById('confirm-cancel');
    okBtn.textContent = okText;
    modal.classList.add('active');

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

const ROUTING_LABELS = {
  primary_fallback: '主备切换',
  round_robin: '轮询',
  weighted: '加权',
  fastest: '最快优先',
};

function renderProxies() {
  const container = document.getElementById('proxy-list');
  if (proxies.length === 0) {
    container.innerHTML = '<div class="empty">暂无代理配置，点击右上角创建</div>';
    return;
  }

  container.innerHTML = proxies.map(p => {
    // Build unified provider rows: primary first, then pool entries
    const primaryRow = {
      name: p.providerName || p.providerUrl || '-',
      tag: '',
      protocol: p.protocol || '-',
      model: p.defaultModel || '-',
      weight: Math.max(1, parseInt(p.providerWeight, 10) || 1),
    };
    const poolRows = (p.providerPool || []).map(item => {
      const prov = providers.find(pr => pr.id === item.providerId);
      return {
        name: prov?.name || item.providerId,
        tag: '备选',
        protocol: prov?.protocol || p.protocol || '-',
        model: item.model || '-',
        weight: Math.max(1, parseInt(item.weight, 10) || 1),
      };
    });
    const allRows = [primaryRow, ...poolRows];
    const strategy = ROUTING_LABELS[p.routingStrategy] || p.routingStrategy;

    return `
    <div class="proxy-item">
      <div class="proxy-header">
        <div class="proxy-title">
          <h3>${escapeHtml(p.name)}</h3>
          <span class="badge ${p.running ? 'badge-running' : 'badge-stopped'}">
            ${p.running ? '运行中' : '已停止'}
          </span>
        </div>
        <span class="proxy-routing-badge">${escapeHtml(strategy)}</span>
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
            <th>模型</th>
            <th>权重</th>
          </tr>
        </thead>
        <tbody>
          ${allRows.map(r => `
          <tr>
            <td>${escapeHtml(r.name)}${r.tag ? `<span class="provider-tag">${r.tag}</span>` : ''}</td>
            <td>
              <span class="badge" style="background:${r.protocol==='openai'?'#0c4a6e':r.protocol==='anthropic'?'#581c87':'#064e3b'};color:${r.protocol==='openai'?'#7dd3fc':r.protocol==='anthropic'?'#e9d5ff':'#6ee7b7'}">
                ${r.protocol}
              </span>
            </td>
            <td><code>${escapeHtml(r.model)}</code></td>
            <td>${r.weight}</td>
          </tr>`).join('')}
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
    // 同步认证下拉框
    const authVal = p.requireAuth ? 'true' : 'false';
    document.getElementById('proxy-auth').value = authVal;
    document.querySelectorAll('#auth-dropdown .model-option').forEach(o => o.classList.remove('selected'));
    const authOpt = document.querySelector(`#auth-dropdown .model-option[data-value="${authVal}"]`);
    if (authOpt) {
      authOpt.classList.add('selected');
      document.getElementById('auth-dropdown-value').textContent = authOpt.querySelector('.model-option-name').textContent;
    }
    document.getElementById('proxy-auth-token').value = p.authToken || '';
    document.getElementById('auth-token-group').style.display = p.requireAuth ? 'block' : 'none';
    selectProvider(p.providerId || '');
    selectModel(p.defaultModel || '');
    renderApiKeys(providers.find(pr => pr.id === p.providerId));
    // Azure 字段从供应商配置读取
    const provider = providers.find(pr => pr.id === p.providerId);
    document.getElementById('target-azure-deployment').value = provider?.azureDeployment || '';
    document.getElementById('target-azure-version').value = provider?.azureApiVersion || '';
    document.getElementById('azure-fields').style.display = p.protocol === 'openai' ? '' : 'none';
    document.getElementById('provider-weight').value = Math.max(1, parseInt(p.providerWeight, 10) || 1);
    syncSimpleDropdown('routing-dropdown', p.routingStrategy || 'primary_fallback', 'routing-strategy');
    syncProviderPoolState(p.providerPool || []);
  } else {
    document.getElementById('proxy-id').value = '';
    // 重置认证下拉框
    document.getElementById('proxy-auth').value = 'false';
    document.querySelectorAll('#auth-dropdown .model-option').forEach(o => o.classList.remove('selected'));
    document.querySelector('#auth-dropdown .model-option[data-value="false"]').classList.add('selected');
    document.getElementById('auth-dropdown-value').textContent = '不启用';
    document.getElementById('auth-token-group').style.display = 'none';
    selectProvider('');
    selectModel('');
    renderApiKeys(null);
    document.getElementById('target-azure-deployment').value = '';
    document.getElementById('target-azure-version').value = '';
    document.getElementById('azure-fields').style.display = 'none';
    document.getElementById('provider-weight').value = 1;
    syncSimpleDropdown('routing-dropdown', 'primary_fallback', 'routing-strategy');
    syncProviderPoolState([]);
  }

  updateModelAddState();
  document.getElementById('modal').classList.add('active');
}

function closeModal() {
  document.getElementById('modal').classList.remove('active');
  document.getElementById('model-dropdown').classList.remove('open');
  document.getElementById('provider-dropdown').classList.remove('open');
  document.getElementById('auth-dropdown').classList.remove('open');
  document.getElementById('protocol-dropdown').classList.remove('open');
  editingId = null;
  editingProviderId = null;
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

  const apiKeys = collectApiKeys();
  const protocol = document.getElementById('target-protocol').value;
  const defaultModel = document.getElementById('target-model').value.trim() || '';

  // 同步更新供应商配置
  const providerUpdates = {};
  providerUpdates.apiKeys = apiKeys;
  if (protocol) providerUpdates.protocol = protocol;
  const azureDeployment = document.getElementById('target-azure-deployment').value.trim();
  const azureApiVersion = document.getElementById('target-azure-version').value.trim();
  providerUpdates.azureDeployment = azureDeployment || '';
  providerUpdates.azureApiVersion = azureApiVersion || '';
  if (Object.keys(providerUpdates).length > 0) {
    try {
      const res = await fetch(`/api/providers/${providerId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(providerUpdates),
      });
      if (!res.ok) {
        const err = await res.json();
        showToast('供应商配置保存失败: ' + (err.error || '未知错误'), true);
      }
      await loadProviders();
    } catch (err) {
      showToast('供应商配置保存失败: ' + err.message, true);
    }
  }

  const payload = {
    name: document.getElementById('proxy-name').value.trim(),
    port,
    requireAuth: document.getElementById('proxy-auth').value === 'true',
    authToken: document.getElementById('proxy-auth-token').value.trim() || null,
    providerId,
    defaultModel,
    providerWeight: Math.max(1, parseInt(document.getElementById('provider-weight').value, 10) || 1),
    routingStrategy: document.getElementById('routing-strategy').value || 'primary_fallback',
    providerPool: providerPoolItems,
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
    showToast('启动失败: ' + err.message, true);
  }
}

async function stopProxy(id) {
  try {
    await fetch(`/api/proxies/${id}/stop`, { method: 'POST' });
    await loadProxies();
  } catch (err) {
    showToast('停止失败: ' + err.message, true);
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
