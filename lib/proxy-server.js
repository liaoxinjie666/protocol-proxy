const express = require('express');
const { detectInboundProtocol } = require('./detector');
const o2a = require('./converters/openai-to-anthropic');
const a2o = require('./converters/anthropic-to-openai');
const o2g = require('./converters/openai-to-gemini');
const g2o = require('./converters/gemini-to-openai');
const a2g = require('./converters/anthropic-to-gemini');
const g2a = require('./converters/gemini-to-anthropic');
const r2c = require('./converters/responses-to-chat');
const c2r = require('./converters/chat-to-responses');
const a2r = require('./converters/anthropic-to-responses');
const g2r = require('./converters/gemini-to-responses');
const { getAdapter } = require('./adapters/registry');
const { recordUsage } = require('./stats-store');
const logger = require('./logger');
const requestLog = require('./request-log');

// freeform 工具调试日志（设置 FREEFORM_DEBUG=1 环境变量启用）
if (process.env.FREEFORM_DEBUG) {
  const dbgLog = (...args) => logger.log('[FREEFORM]', ...args);
  if (r2c.setDebugLogger) r2c.setDebugLogger(dbgLog);
  if (c2r.setDebugLogger) c2r.setDebugLogger(dbgLog);
  if (a2r.setDebugLogger) a2r.setDebugLogger(dbgLog);
  if (g2r.setDebugLogger) g2r.setDebugLogger(dbgLog);
}

function uid(prefix) {
  const hex = Date.now().toString(16) + Math.random().toString(16).slice(2, 14);
  return `${prefix}_${hex.padEnd(24, '0').slice(0, 24)}`;
}

function createProxyApp(proxyConfigOrGetter) {
  const getProxyConfig = typeof proxyConfigOrGetter === 'function'
    ? proxyConfigOrGetter
    : () => proxyConfigOrGetter;
  const app = express();
  app.use(express.json({ limit: '50mb' }));

  const reasoningCache = new Map();
  const MAX_CACHE_SIZE = 100;
  const routeState = new Map();
  const FAILURE_THRESHOLD = 3;
  const OPEN_DURATION_MS = 60 * 1000;

  function getReasoningKey(msg) {
    const toolIds = msg.tool_calls?.map(t => t.id).join(',') || '';
    return msg.content + '|' + toolIds;
  }

  function setReasoning(msg, reasoning) {
    if (!msg?.content || !reasoning) return;
    const key = getReasoningKey(msg);
    if (reasoningCache.size >= MAX_CACHE_SIZE) {
      const firstKey = reasoningCache.keys().next().value;
      reasoningCache.delete(firstKey);
    }
    reasoningCache.set(key, reasoning);
  }

  function getReasoning(msg) {
    if (!msg?.content) return undefined;
    return reasoningCache.get(getReasoningKey(msg));
  }

  function estimateTokens(text) {
    if (!text) return 0;
    let tokens = 0;
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i);
      if (code >= 0x4E00 && code <= 0x9FFF) tokens += 1.5;
      else if (code >= 0x3000 && code <= 0x303F) tokens += 1;
      else tokens += 0.25;
    }
    return Math.ceil(tokens);
  }

  function estimateInputTokens(body) {
    if (!body?.messages) return 0;
    let text = '';
    for (const msg of body.messages) {
      if (typeof msg.content === 'string') {
        text += msg.content;
      } else if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block.text) text += block.text;
          if (block.type === 'tool_result' && block.content) {
            text += typeof block.content === 'string' ? block.content : JSON.stringify(block.content);
          }
        }
      }
      if (msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          text += (tc.function?.arguments || '') + (tc.function?.name || '');
        }
      }
    }
    if (body.tools) text += JSON.stringify(body.tools);
    return estimateTokens(text);
  }

  function injectReasoningToMessages(messages) {
    if (!Array.isArray(messages)) return;
    for (const msg of messages) {
      if (msg.role === 'assistant' && (msg.reasoning_content === undefined || msg.reasoning_content === null)) {
        const reasoning = getReasoning(msg);
        if (reasoning) {
          msg.reasoning_content = reasoning;
        } else {
          delete msg.reasoning_content;
        }
      }
    }
  }

  function extractReasoningFromResponse(body) {
    const choice = body.choices?.[0];
    const message = choice?.message;
    if (message?.role === 'assistant' && message.reasoning_content) {
      setReasoning(message, message.reasoning_content);
    }
  }

  // Extract thinking blocks from Anthropic response and cache by assistant text content
  function extractAnthropicThinking(body) {
    const content = body.content;
    if (!Array.isArray(content)) return;
    const thinkingBlocks = content.filter(b => b.type === 'thinking');
    if (thinkingBlocks.length === 0) return;
    const textContent = content.filter(b => b.type === 'text').map(b => b.text).join('');
    if (!textContent) return;
    const msg = { content: textContent, tool_calls: null };
    setReasoning(msg, thinkingBlocks);
  }

  // Inject cached thinking blocks into Anthropic-format assistant messages
  function injectAnthropicThinking(messages) {
    if (!Array.isArray(messages)) return;
    for (const msg of messages) {
      if (msg.role !== 'assistant' || !Array.isArray(msg.content)) continue;
      const hasThinking = msg.content.some(b => b.type === 'thinking');
      if (hasThinking) continue;
      const textContent = msg.content.filter(b => b.type === 'text').map(b => b.text).join('');
      if (!textContent) continue;
      const cached = getReasoning({ content: textContent, tool_calls: null });
      if (cached) {
        msg.content = [...cached, ...msg.content];
      }
    }
  }

  function getRouteState(proxyId) {
    if (!routeState.has(proxyId)) {
      routeState.set(proxyId, { rrIndex: 0, metrics: new Map() });
    }
    return routeState.get(proxyId);
  }

  function getMetrics(proxyId, providerId) {
    const state = getRouteState(proxyId);
    if (!state.metrics.has(providerId)) {
      state.metrics.set(providerId, {
        successCount: 0,
        failureCount: 0,
        avgLatencyMs: null,
        lastErrorAt: 0,
        circuitOpenUntil: 0,
      });
    }
    return state.metrics.get(providerId);
  }

  function isRetryableStatus(status) {
    return status === 401
      || status === 403
      || status === 408
      || status === 409
      || status === 425
      || status === 429
      || status >= 500;
  }

  function isProviderAvailable(metrics) {
    return !metrics.circuitOpenUntil || metrics.circuitOpenUntil <= Date.now();
  }

  function recordSuccess(proxyId, providerId, latencyMs) {
    const metrics = getMetrics(proxyId, providerId);
    metrics.successCount += 1;
    metrics.lastErrorAt = 0;
    metrics.failureCount = 0;
    metrics.circuitOpenUntil = 0;
    metrics.avgLatencyMs = metrics.avgLatencyMs == null
      ? latencyMs
      : Math.round(metrics.avgLatencyMs * 0.7 + latencyMs * 0.3);
  }

  function recordFailure(proxyId, providerId) {
    const metrics = getMetrics(proxyId, providerId);
    metrics.failureCount += 1;
    metrics.lastErrorAt = Date.now();
    if (metrics.failureCount >= FAILURE_THRESHOLD) {
      metrics.circuitOpenUntil = Date.now() + OPEN_DURATION_MS;
    }
  }

  // ==================== API Key 轮转 ====================

  const keyPoolState = new Map();
  const KEY_COOLDOWN_MS = 60 * 1000;

  function getKeyState(providerId, apiKeys) {
    if (!keyPoolState.has(providerId)) {
      keyPoolState.set(providerId, {
        keys: apiKeys || [],
        index: 0,
        cooldowns: new Map(), // key -> cooldownUntil timestamp
      });
    }
    return keyPoolState.get(providerId);
  }

  function selectKey(providerId, apiKeys) {
    if (!apiKeys || apiKeys.length === 0) return '';
    // Filter out disabled keys (enabled defaults to true)
    const enabledKeys = apiKeys.filter(k => (typeof k === 'object' ? k.enabled !== false : true));
    if (enabledKeys.length === 0) return '';
    // Normalize to string array (handle {key, alias} objects)
    const keys = enabledKeys.map(k => typeof k === 'string' ? k : k.key);
    if (keys.length === 1) return keys[0];

    const state = getKeyState(providerId, keys);
    // Sync keys in case they changed
    state.keys = keys;
    const now = Date.now();

    // Clean expired cooldowns
    for (const [key, until] of state.cooldowns) {
      if (until <= now) state.cooldowns.delete(key);
    }

    // Try to find an available key starting from current index
    for (let i = 0; i < keys.length; i++) {
      const idx = (state.index + i) % keys.length;
      const key = keys[idx];
      if (!state.cooldowns.has(key)) {
        state.index = (idx + 1) % keys.length;
        return key;
      }
    }

    // All keys on cooldown — pick the one with shortest remaining cooldown
    let earliest = Infinity;
    let bestKey = keys[0];
    for (const [key, until] of state.cooldowns) {
      if (keys.includes(key) && until < earliest) {
        earliest = until;
        bestKey = key;
      }
    }
    state.index = (keys.indexOf(bestKey) + 1) % keys.length;
    return bestKey;
  }

  function markKeyCooldown(providerId, key) {
    const state = keyPoolState.get(providerId);
    if (state) {
      state.cooldowns.set(key, Date.now() + KEY_COOLDOWN_MS);
      logger.log(`[KeyPool] ${providerId} key ${key.slice(0, 8)}... cooldown 60s`);
    }
  }

  function buildCandidates(proxyConfig) {
    const target = proxyConfig.target;
    if (!target || !Array.isArray(target.providerPool) || target.providerPool.length === 0) return [];
    const pool = target.providerPool;

    const ordered = pool.map((item, index) => ({
      ...item,
      providerId: item.providerId || `provider-${index}`,
      weight: Math.max(1, parseInt(item.weight, 10) || 1),
    }));

    const strategy = target.routingStrategy || 'primary_fallback';
    const proxyId = proxyConfig.id || 'default';

    const byHealth = ordered.filter(item => isProviderAvailable(getMetrics(proxyId, item.providerId)));
    const healthy = byHealth.length > 0 ? byHealth : ordered;

    if (strategy === 'weighted') {
      // 加权随机选择第一个候选，剩余按权重排序作为 fallback
      const totalWeight = healthy.reduce((sum, c) => sum + c.weight, 0);
      let rand = Math.random() * totalWeight;
      let picked = healthy.length - 1;
      for (let i = 0; i < healthy.length; i++) {
        rand -= healthy[i].weight;
        if (rand <= 0) { picked = i; break; }
      }
      const first = healthy[picked];
      const rest = healthy.filter((_, i) => i !== picked).sort((a, b) => b.weight - a.weight);
      return [first, ...rest];
    }

    if (strategy === 'fastest') {
      return healthy.slice().sort((a, b) => {
        const am = getMetrics(proxyId, a.providerId).avgLatencyMs ?? Number.MAX_SAFE_INTEGER;
        const bm = getMetrics(proxyId, b.providerId).avgLatencyMs ?? Number.MAX_SAFE_INTEGER;
        return am - bm;
      });
    }

    if (strategy === 'round_robin') {
      const state = getRouteState(proxyId);
      const start = state.rrIndex % healthy.length;
      state.rrIndex = (state.rrIndex + 1) % healthy.length;
      return healthy.slice(start).concat(healthy.slice(0, start));
    }

    return healthy;
  }

  function hasCapability(candidate, capability) {
    return Array.isArray(candidate?.capabilities) && candidate.capabilities.includes(capability);
  }

  function hasImageInput(body) {
    // Responses API 格式
    const input = body?.input;
    if (Array.isArray(input)) {
      const hasImg = input.some(item => {
        const content = item?.content;
        return Array.isArray(content) && content.some(part => part?.type === 'input_image' || part?.image_url);
      });
      if (hasImg) return true;
    }
    // Chat Completions / Anthropic / Gemini 格式
    const messages = body?.messages;
    if (Array.isArray(messages)) {
      return messages.some(msg => {
        const content = msg?.content;
        if (!Array.isArray(content)) return false;
        return content.some(part => part?.type === 'image_url' || part?.type === 'input_image' || part?.type === 'image');
      });
    }
    return false;
  }

  function routeVisionCandidates(candidates) {
    const visionCandidates = candidates.filter(c => hasCapability(c, 'vision'));
    return visionCandidates.length > 0 ? visionCandidates : candidates;
  }

  // 从请求体中去掉图片/音频内容，保留文本与工具相关块（用于上游不支持多模态时降级重试）
  // 注意：必须保留 tool_use/tool_result/text/thinking 等块，否则会破坏 agentic 的工具历史。
  // anthropic 格式要求 content 必须是块数组，不能降级为字符串，否则上游返回 400。
  function stripImageFromMessages(body, targetProtocol) {
    const isAnthropicTarget = targetProtocol === 'anthropic';
    const stripped = { ...body };
    // Chat Completions / Anthropic 格式（messages 数组，content 可能是块数组）
    if (Array.isArray(stripped.messages)) {
      stripped.messages = stripped.messages.map(msg => {
        if (!Array.isArray(msg.content)) return msg;
        // 保留 text/thinking/tool_use/tool_result，只剥离 image/audio
        const kept = msg.content.filter(p =>
          p.type !== 'image' && p.type !== 'image_url' && p.type !== 'audio'
        );
        if (kept.length === msg.content.length) return msg; // 没有图片/音频，原样返回
        if (kept.length === 0) {
          // 全部被剥离：anthropic 用块数组，chat 可用字符串
          if (isAnthropicTarget) return { ...msg, content: [{ type: 'text', text: '[图片内容已移除]' }] };
          return { ...msg, content: '[图片内容已移除]' };
        }
        // anthropic 目标始终保持块数组；chat 目标单 text 块可降级为字符串
        if (!isAnthropicTarget && kept.length === 1 && kept[0].type === 'text') {
          return { ...msg, content: kept[0].text };
        }
        return { ...msg, content: kept };
      });
    }
    // Responses API 格式（input 数组，item.content 是 part 数组）
    if (Array.isArray(stripped.input)) {
      stripped.input = stripped.input.map(item => {
        if (!Array.isArray(item.content)) return item;
        // 保留文本类 part，剥离 image/file
        const kept = item.content.filter(p =>
          p.type !== 'input_image' && p.type !== 'input_file' && p.type !== 'image' && p.type !== 'image_url'
        );
        if (kept.length === item.content.length) return item;
        if (kept.length === 0) return { ...item, content: [{ type: 'input_text', text: '[图片内容已移除]' }] };
        return { ...item, content: kept };
      });
    }
    return stripped;
  }

  function hasImageGenTool(body) {
    return Array.isArray(body?.tools) && body.tools.some(t => t?.type === 'image_gen');
  }

  function extractImagePrompt(body) {
    const input = body?.input;
    if (typeof input === 'string') return input.trim();
    if (!Array.isArray(input)) return '';
    for (let i = input.length - 1; i >= 0; i--) {
      const item = input[i];
      if (!item || item.role !== 'user') continue;
      const content = item.content;
      if (typeof content === 'string') return content.trim();
      if (Array.isArray(content)) {
        const text = content
          .filter(part => part?.type === 'input_text' || part?.type === 'text')
          .map(part => part.text || '')
          .join(' ')
          .trim();
        if (text) return text;
      }
    }
    return '';
  }

  function getImageGenSize(body) {
    const tool = Array.isArray(body?.tools) ? body.tools.find(t => t?.type === 'image_gen') : null;
    return tool?.size || body?.size || '1024x1024';
  }

  function buildImageGenerationUrl(candidate) {
    const base = candidate.providerUrl.replace(/\/$/, '');
    if (base.endsWith('/v1') || base.endsWith('/api/v3')) return `${base}/images/generations`;
    return `${base}/v1/images/generations`;
  }

  function makeResponsesImageResponse(model, prompt, size, imageOutput) {
    const callId = uid('call');
    return {
      id: uid('resp'),
      object: 'response',
      status: 'completed',
      model: model || '',
      output: [
        {
          id: uid('icall'),
          object: 'realtime.item',
          type: 'image_generation_call',
          call_id: callId,
          prompt,
          size,
          status: 'completed',
        },
        {
          id: uid('icall_out'),
          object: 'realtime.item',
          type: 'image_generation_call_output',
          call_id: callId,
          output: imageOutput,
        },
      ],
      usage: {},
    };
  }

  async function handleResponsesImageGeneration(req, res, candidates, effectiveModel, requestMeta) {
    const imageCandidate = candidates.find(c => c.protocol === 'openai' && hasCapability(c, 'image_gen'));
    if (!imageCandidate) {
      return res.status(400).json({
        error: {
          message: 'No image generation provider configured. Add an OpenAI-compatible provider with image_gen capability.',
          type: 'no_image_gen_provider',
        },
      });
    }

    const prompt = extractImagePrompt(req.body);
    if (!prompt) {
      return res.status(400).json({ error: { message: 'Unable to extract image prompt from Responses input', type: 'invalid_request' } });
    }

    const _im = Array.isArray(imageCandidate.models) ? imageCandidate.models[0] : null;
    const imageModel = imageCandidate.model || (typeof _im === 'string' ? _im : _im?.name) || effectiveModel || req.body.model;
    const size = getImageGenSize(req.body);
    const body = {
      model: imageModel,
      prompt,
      n: 1,
      size,
    };
    for (const key of ['response_format', 'quality', 'style', 'user', 'output_format', 'watermark', 'negative_prompt', 'seed', 'steps', 'guidance_scale', 'cfg_scale']) {
      if (req.body[key] !== undefined) body[key] = req.body[key];
    }

    const adapter = imageCandidate.adapter ? getAdapter(imageCandidate.adapter) : null;
    if (adapter && adapter.preprocessImageGenerationBody) {
      adapter.preprocessImageGenerationBody(body);
    }

    const currentKey = selectKey(imageCandidate.providerId, imageCandidate.apiKeys || []);
    const headers = {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'Authorization': `Bearer ${currentKey}`,
    };
    const url = buildImageGenerationUrl(imageCandidate);
    const startedAt = Date.now();

    try {
      const fetchRes = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(120000),
      });
      const data = await fetchRes.json().catch(async () => ({ error: { message: await fetchRes.text().catch(() => '') } }));
      if (!fetchRes.ok) {
        return res.status(fetchRes.status).json(data);
      }

      const first = Array.isArray(data?.data) ? data.data[0] : null;
      const imageOutput = first?.url || (first?.b64_json ? `data:image/png;base64,${first.b64_json}` : '');
      if (!imageOutput) {
        return res.status(502).json({ error: { message: 'Image generation provider returned no image data', type: 'no_image_data' } });
      }

      recordSuccess(requestMeta.proxyId, imageCandidate.providerId, Date.now() - startedAt);
      requestLog.add({
        id: requestMeta.requestId, proxyId: requestMeta.proxyId, proxyName: requestMeta.proxyName,
        method: req.method, path: req.path, inboundProtocol: 'responses', targetProtocol: 'images',
        providerName: imageCandidate.providerName, model: imageModel || '',
        status: 'success', upstreamStatusCode: fetchRes.status,
        latencyMs: Date.now() - startedAt,
        promptTokens: 0, completionTokens: 0, totalTokens: 0, isEstimated: false,
        stream: false, keyAlias: currentKey ? `…${currentKey.slice(-4)}` : '-', errorMessage: null,
        clientIP: requestMeta.clientIP, requestBody: requestMeta.requestLogBody,
      });
      return res.json(makeResponsesImageResponse(req.body.model || imageModel, prompt, size, imageOutput));
    } catch (err) {
      recordFailure(requestMeta.proxyId, imageCandidate.providerId);
      return res.status(502).json({ error: { message: err.message, type: 'image_gen_failed' } });
    }
  }

  async function handleImageGenerationRequest(req, res) {
    const requestId = `req-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const proxyConfig = getProxyConfig();
    const candidates = buildCandidates(proxyConfig);
    const imageCandidate = candidates.find(c => c.protocol === 'openai' && hasCapability(c, 'image_gen'))
      || candidates.find(c => c.protocol === 'openai');
    if (!imageCandidate) {
      return res.status(500).json({ error: { message: 'No OpenAI-compatible image generation provider configured' } });
    }

    const _im2 = Array.isArray(imageCandidate.models) ? imageCandidate.models[0] : null;
    const imageModel = req.body?.model || imageCandidate.model || (typeof _im2 === 'string' ? _im2 : _im2?.name) || proxyConfig.target?.defaultModel;
    const body = { ...req.body, model: imageModel };
    const adapter = imageCandidate.adapter ? getAdapter(imageCandidate.adapter) : null;
    if (adapter && adapter.preprocessImageGenerationBody) {
      adapter.preprocessImageGenerationBody(body);
    }

    const currentKey = selectKey(imageCandidate.providerId, imageCandidate.apiKeys || []);
    const startedAt = Date.now();
    try {
      const fetchRes = await fetch(buildImageGenerationUrl(imageCandidate), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'Authorization': `Bearer ${currentKey}`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(120000),
      });
      const responseBody = await fetchRes.json().catch(async () => ({ error: { message: await fetchRes.text().catch(() => '') } }));
      if (fetchRes.ok) {
        recordSuccess(proxyConfig.id || 'default', imageCandidate.providerId, Date.now() - startedAt);
      } else {
        recordFailure(proxyConfig.id || 'default', imageCandidate.providerId);
      }
      requestLog.add({
        id: requestId, proxyId: proxyConfig.id || 'default', proxyName: proxyConfig.name || '',
        method: req.method, path: req.path, inboundProtocol: 'images', targetProtocol: 'images',
        providerName: imageCandidate.providerName, model: imageModel || '',
        status: fetchRes.ok ? 'success' : 'failure', upstreamStatusCode: fetchRes.status,
        latencyMs: Date.now() - startedAt,
        promptTokens: 0, completionTokens: 0, totalTokens: 0, isEstimated: false,
        stream: false, keyAlias: currentKey ? `…${currentKey.slice(-4)}` : '-',
        errorMessage: fetchRes.ok ? null : responseBody?.error?.message || `HTTP ${fetchRes.status}`,
        clientIP: req.ip || req.socket?.remoteAddress || '',
        requestBody: req.body ? JSON.stringify(req.body).slice(0, 102400) : null,
      });
      return res.status(fetchRes.status).json(responseBody);
    } catch (err) {
      recordFailure(proxyConfig.id || 'default', imageCandidate.providerId);
      return res.status(502).json({ error: { message: err.message, type: 'image_gen_failed' } });
    }
  }

  function getRoutingHealth(proxyConfig) {
    const proxyId = proxyConfig.id || 'default';
    const target = proxyConfig.target || {};
    const pool = Array.isArray(target.providerPool) && target.providerPool.length > 0
      ? target.providerPool
      : [];
    return pool.map(item => {
      const metrics = getMetrics(proxyId, item.providerId || 'primary');
      return {
        providerId: item.providerId || 'primary',
        providerName: item.providerName || '',
        successCount: metrics.successCount,
        failureCount: metrics.failureCount,
        avgLatencyMs: metrics.avgLatencyMs,
        circuitOpenUntil: metrics.circuitOpenUntil,
        available: isProviderAvailable(metrics),
      };
    });
  }

  app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Api-Key, X-PP-Provider-Id, X-PP-Model, X-PP-Provider-Url, X-PP-Provider-Protocol, X-PP-Provider-Keys, X-PP-Provider-Adapter, X-PP-Provider-Capabilities');
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    next();
  });

  app.use((req, res, next) => {
    const proxyConfig = getProxyConfig();
    if (!proxyConfig.requireAuth || !proxyConfig.authToken) return next();
    const token = req.headers.authorization?.replace('Bearer ', '') || req.headers['x-api-key'];
    if (token !== proxyConfig.authToken) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    next();
  });

  app.post('/v1/chat/completions', handleRequest);
  app.post('/v1/messages', handleRequest);
  app.post('/v1/responses', handleRequest);
  // Alias without /v1 prefix for clients (e.g. Codex) that POST to /responses directly
  app.post('/chat/completions', handleRequest);
  app.post('/messages', handleRequest);
  app.post('/responses', handleRequest);
  app.post('/v1/images/generations', handleImageGenerationRequest);
  app.get('/_internal/routing-health', (req, res) => {
    res.json({
      proxy: getProxyConfig()?.id || null,
      providers: getRoutingHealth(getProxyConfig() || {}),
    });
  });

  async function handleRequest(req, res) {
    const requestId = `req-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const requestStart = Date.now();
    const proxyConfig = getProxyConfig();
    const inboundProtocol = detectInboundProtocol(req, req.body);
    let candidates = buildCandidates(proxyConfig);

    // 请求级供应商/模型覆盖（来自助手 chat 端点的自定义头）
    const overrideProviderId = req.headers['x-pp-provider-id'];
    const overrideModel = req.headers['x-pp-model'];

    if (candidates.length === 0 && !overrideProviderId) {
      return res.status(500).json({ error: 'Proxy target not configured' });
    }

    const isStream = req.body?.stream === true;
    const proxyId = proxyConfig.id || 'default';
    const clientIP = req.ip || req.socket?.remoteAddress || '';
    const proxyName = proxyConfig.name || '';
    const requestLogBody = req.body ? JSON.stringify(req.body).slice(0, 102400) : null;

    // 记录 Responses API 请求的原始工具定义（仅调试模式）
    if (process.env.FREEFORM_DEBUG && req.body?.tools && Array.isArray(req.body.tools)) {
      const apTool = req.body.tools.find(t => t && (t.name === 'apply_patch' || t.function?.name === 'apply_patch'));
      if (apTool) {
        logger.log(`[${requestId}] [FREEFORM] RAW apply_patch tool definition: ${JSON.stringify(apTool).slice(0, 500)}`);
      }
    }

    // 记录 Responses API 的工具定义（包含 js_repl/js 等 BuiltIn 工具）
    if (inboundProtocol === 'responses' && req.body?.tools && Array.isArray(req.body.tools)) {
      const toolNames = req.body.tools.map(t => {
        if (t.type === 'namespace') {
          const children = (t.tools || []).map(c => c.name).join('+');
          return `namespace:${t.namespace||t.name||'?'}[${children}]`;
        }
        return `${t.type}:${t.name}`;
      });
      logger.log(`[${requestId}] [RESPONSES→openai] inbound tools: ${toolNames.join(', ')}`);
      // 特别记录 js_repl/js 工具
      const jsTool = req.body.tools.find(t => t.name === 'js_repl' || t.name === 'js' || (t.tools && t.tools.some(c => c.name === 'js')));
      if (jsTool) {
        logger.log(`[${requestId}] [RESPONSES] js/js_repl tool found: ${JSON.stringify(jsTool).slice(0, 800)}`);
      }
    }
    const inboundModel = req.body?.model;
    let effectiveModel = proxyConfig.target?.defaultModel || inboundModel;

    // 模型覆盖：优先级高于 defaultModel
    if (overrideModel) {
      effectiveModel = overrideModel;
    }
    let baseRequestBody = effectiveModel ? { ...req.body, model: effectiveModel } : { ...req.body };

    // 供应商覆盖：筛选或动态构建候选
    if (overrideProviderId) {
      const filtered = candidates.filter(c => c.providerId === overrideProviderId);
      if (filtered.length > 0) {
        candidates = filtered;
      } else {
        // 不在代理候选池中 → 用附加头动态构建临时候选
        const providerUrl = req.headers['x-pp-provider-url'];
        const providerProtocol = req.headers['x-pp-provider-protocol'];
        const providerKeys = req.headers['x-pp-provider-keys'];
        const providerAdapter = req.headers['x-pp-provider-adapter'];
        const providerCapabilities = req.headers['x-pp-provider-capabilities'];
        const providerName = req.headers['x-pp-provider-name'] ? decodeURIComponent(req.headers['x-pp-provider-name']) : undefined;
        if (providerUrl && providerProtocol) {
          let parsedKeys = [];
          let parsedCaps = [];
          try { parsedKeys = providerKeys ? JSON.parse(providerKeys).map(k => ({ ...k, alias: k.alias ? decodeURIComponent(k.alias) : '' })) : []; } catch { return res.status(400).json({ error: 'x-pp-provider-keys 格式无效' }); }
          try { parsedCaps = providerCapabilities ? JSON.parse(providerCapabilities) : []; } catch { return res.status(400).json({ error: 'x-pp-provider-capabilities 格式无效' }); }
          const tempCandidate = {
            providerId: overrideProviderId,
            providerName: providerName || overrideProviderId,
            providerUrl,
            protocol: providerProtocol,
            apiKeys: parsedKeys,
            models: [],
            azureDeployment: '',
            azureApiVersion: '',
            adapter: providerAdapter || '',
            capabilities: parsedCaps,
            model: '',
            weight: 1,
          };
          candidates = [tempCandidate];
        } else {
          return res.status(400).json({ error: '指定的供应商不在代理候选列表中，且缺少供应商配置' });
        }
      }
    }

    if (inboundProtocol === 'responses') {
      if (hasImageGenTool(baseRequestBody)) {
        return handleResponsesImageGeneration(req, res, candidates, effectiveModel, {
          requestId, proxyId, proxyName, clientIP, requestLogBody,
        });
      }
    }
    if (!overrideProviderId && hasImageInput(baseRequestBody)) {
      candidates = routeVisionCandidates(candidates);
    }

    // Inject cached reasoning for OpenAI inbound (OpenAI protocol lacks reasoning_content)
    if (inboundProtocol === 'openai') {
      injectReasoningToMessages(baseRequestBody.messages);
    }

    // Pre-build request templates for each protocol
    const passthrough = (body, model) => ({ ...body, model: body.model || model });
    const requestTemplates = {};
    requestTemplates.openai = inboundProtocol === 'openai' ? passthrough(baseRequestBody, effectiveModel) :
                              inboundProtocol === 'anthropic' ? a2o.convertRequest(baseRequestBody, effectiveModel) :
                              inboundProtocol === 'gemini' ? g2o.convertRequest(baseRequestBody, effectiveModel) :
                              passthrough(baseRequestBody, effectiveModel);
    // 传入 reasoningCache 以便在转换时正确处理 thinking 块
    requestTemplates.anthropic = inboundProtocol === 'anthropic' ? passthrough(baseRequestBody, effectiveModel) :
                                 inboundProtocol === 'openai' ? o2a.convertRequest(baseRequestBody, effectiveModel, { reasoningCache }) :
                                 inboundProtocol === 'gemini' ? (() => { const r = g2a.convertRequest(baseRequestBody, effectiveModel); return { body: r, nameToId: r.nameToId }; })() :
                                 passthrough(baseRequestBody, effectiveModel);
    requestTemplates.gemini = inboundProtocol === 'gemini' ? passthrough(baseRequestBody, effectiveModel) :
                              inboundProtocol === 'openai' ? o2g.convertRequest(baseRequestBody, effectiveModel) :
                              inboundProtocol === 'anthropic' ? a2g.convertRequest(baseRequestBody, effectiveModel) :
                              passthrough(baseRequestBody, effectiveModel);

    logger.log(`[${requestId}] ${(inboundProtocol || 'unknown').toUpperCase()} -> mixed | path=${req.path}`);

    let lastCandidate = null;
    let lastKeyLabel = '';
    for (const candidate of candidates) {
      lastCandidate = candidate;
      const targetProtocol = candidate.protocol;
      const isAzure = !!candidate.azureDeployment && /azure/i.test(candidate.providerUrl);

      let convertRes;
      let createSSEConv;
      let nameToId = null;
      let targetBody;

      if (inboundProtocol === 'openai' && targetProtocol === 'anthropic') {
        targetBody = { ...requestTemplates.anthropic };
        convertRes = o2a.convertResponse;
        createSSEConv = o2a.createSSEConverter;
      } else if (inboundProtocol === 'anthropic' && targetProtocol === 'openai') {
        targetBody = { ...requestTemplates.openai };
        convertRes = a2o.convertResponse;
        createSSEConv = a2o.createSSEConverter;
      } else if (inboundProtocol === 'openai' && targetProtocol === 'gemini') {
        targetBody = { ...requestTemplates.gemini };
        convertRes = o2g.convertResponse;
        createSSEConv = o2g.createSSEConverter;
      } else if (inboundProtocol === 'gemini' && targetProtocol === 'openai') {
        const result = g2o.convertRequest(baseRequestBody, effectiveModel);
        nameToId = result.nameToId;
        const { nameToId: _, ...bodyOnly } = result;
        targetBody = bodyOnly;
        convertRes = g2o.convertResponse;
        createSSEConv = g2o.createSSEConverter;
      } else if (inboundProtocol === 'anthropic' && targetProtocol === 'gemini') {
        targetBody = { ...requestTemplates.gemini };
        convertRes = a2g.convertResponse;
        createSSEConv = a2g.createSSEConverter;
      } else if (inboundProtocol === 'gemini' && targetProtocol === 'anthropic') {
        const tpl = requestTemplates.anthropic;
        targetBody = { ...tpl.body };
        nameToId = tpl.nameToId;
        convertRes = g2a.convertResponse;
        createSSEConv = () => g2a.createSSEConverter(nameToId);
      } else if (inboundProtocol === 'responses' && targetProtocol === 'openai') {
        targetBody = r2c.convertRequest(baseRequestBody, effectiveModel);
        const freeformTools = targetBody._freeformTools;
        const namespaceMap = targetBody._namespaceMap;
        delete targetBody._freeformTools;
        delete targetBody._namespaceMap;
        if (process.env.FREEFORM_DEBUG && freeformTools && freeformTools.length > 0) {
          logger.log(`[${requestId}] [FREEFORM→openai] freeformTools=${JSON.stringify(freeformTools)}`);
        }
        if (namespaceMap && Object.keys(namespaceMap).length > 0) {
          logger.log(`[${requestId}] [NAMESPACE→openai] namespaceMap=${JSON.stringify(namespaceMap)}`);
        }
        convertRes = (body) => c2r.convertResponse(body, freeformTools, namespaceMap);
        createSSEConv = () => c2r.createSSEConverter(effectiveModel, freeformTools, namespaceMap);
      } else if (inboundProtocol === 'responses' && targetProtocol === 'anthropic') {
        const chatBody = r2c.convertRequest(baseRequestBody, effectiveModel);
        const freeformTools = chatBody._freeformTools;
        const namespaceMap = chatBody._namespaceMap;
        delete chatBody._freeformTools;
        delete chatBody._namespaceMap;
        targetBody = o2a.convertRequest(chatBody, effectiveModel, { reasoningCache });
        if (process.env.FREEFORM_DEBUG && freeformTools && freeformTools.length > 0) {
          logger.log(`[${requestId}] [FREEFORM] freeformTools=${JSON.stringify(freeformTools)}`);
          logger.log(`[${requestId}] [FREEFORM] upstream tools=${JSON.stringify((targetBody.tools || []).map(t => ({ name: t.name, desc: (t.description || '').slice(0, 80), schema: t.input_schema })), null, 0)}`);
        }
        if (namespaceMap && Object.keys(namespaceMap).length > 0) {
          logger.log(`[${requestId}] [NAMESPACE] namespaceMap=${JSON.stringify(namespaceMap)}`);
        }
        // 非流式回流：anthropic 响应 → o2a(anthropic→chat) → c2r(chat→responses)
        // 注意：必须用 o2a.convertResponse（anthropic→chat 方向），而非 a2o.convertResponse（chat→anthropic）。
        // a2o 输出 anthropic message 格式（无 choices），c2r 期望 chat 格式（有 choices），用错会导致 output 恒空。
        convertRes = (body) => c2r.convertResponse(o2a.convertResponse(body), freeformTools, namespaceMap);
        createSSEConv = () => a2r.createSSEConverter(effectiveModel, freeformTools, namespaceMap);
      } else if (inboundProtocol === 'responses' && targetProtocol === 'gemini') {
        const chatBody = r2c.convertRequest(baseRequestBody, effectiveModel);
        const freeformTools = chatBody._freeformTools;
        const namespaceMap = chatBody._namespaceMap;
        delete chatBody._freeformTools;
        delete chatBody._namespaceMap;
        targetBody = o2g.convertRequest(chatBody, effectiveModel);
        if (namespaceMap && Object.keys(namespaceMap).length > 0) {
          logger.log(`[${requestId}] [NAMESPACE→gemini] namespaceMap=${JSON.stringify(namespaceMap)}`);
        }
        convertRes = (body) => c2r.convertResponse(o2g.convertResponse(body), freeformTools, namespaceMap);
        createSSEConv = () => g2r.createSSEConverter(effectiveModel, freeformTools, namespaceMap);
      } else if (targetProtocol === 'responses' && inboundProtocol !== 'responses') {
        // openai/anthropic/gemini → responses：先转 chat，再转 responses
        let chatBody;
        if (inboundProtocol === 'openai') {
          chatBody = baseRequestBody;
        } else if (inboundProtocol === 'anthropic') {
          chatBody = a2o.convertRequest(baseRequestBody, effectiveModel);
        } else if (inboundProtocol === 'gemini') {
          chatBody = g2o.convertRequest(baseRequestBody, effectiveModel);
        } else {
          chatBody = baseRequestBody;
        }
        targetBody = c2r.convertRequest(chatBody, effectiveModel);
        convertRes = c2r.convertResponse;
        createSSEConv = () => c2r.createSSEConverter(effectiveModel);
      } else if (inboundProtocol === 'responses' && targetProtocol === 'responses') {
        // Responses API → Responses API：直接透传
        targetBody = { ...baseRequestBody };
        if (effectiveModel) targetBody.model = effectiveModel;
        convertRes = (body) => body;
        createSSEConv = null;
      } else {
        targetBody = { ...baseRequestBody };
        convertRes = (body) => body;
        createSSEConv = null;
      }

      // If candidate has a specific model override, apply it
      if (candidate.model) {
        targetBody.model = candidate.model;
      }

      const candidateModel = candidate.model || effectiveModel;
      logger.log(`[${requestId}] -> ${candidate.providerName} (${targetProtocol}) | model=${candidateModel || '(default)'}`);
      if (targetBody.thinking) logger.log(`[${requestId}] [DEBUG-THINKING] targetBody.thinking=${JSON.stringify(targetBody.thinking)}, inbound=${inboundProtocol}, adapter=${candidate.adapter || 'none'}`);
      if (targetBody.tools) logger.log(`[${requestId}] tools: ${targetBody.tools.map(t => t.name || t.function?.name || '?').join(',')}`);

      // Provider 适配器预处理
      const providerAdapter = candidate.protocol === 'openai' && candidate.adapter
        ? getAdapter(candidate.adapter)
        : null;
      if (providerAdapter && providerAdapter.preprocessRequestBody) {
        providerAdapter.preprocessRequestBody(targetBody);
      }

      // 安全网：k2.x 系列模型只接受 thinking.type=enabled
      // 如果适配器未处理或请求经过了协议转换，确保不会发送 type=disabled
      const targetModelLower = (targetBody.model || '').toLowerCase();
      if (targetBody.thinking && targetBody.thinking.type !== 'enabled' && targetModelLower.includes('k2')) {
        logger.log(`[${requestId}] [FIX] Correcting thinking.type=${targetBody.thinking.type} -> enabled for model=${targetBody.model}`);
        targetBody.thinking = { type: 'enabled' };
      }

      // stream_options: 有适配器的国产模型跳过，标准 OpenAI 兼容保留（用于精确 token 统计）
      if (isStream && candidate.protocol === 'openai' && !isAzure && !providerAdapter) {
        targetBody.stream_options = { include_usage: true };
      }

      const targetUrl = buildTargetUrl(candidate, req.path, isStream, candidateModel);
      // Forward client headers (preserve anthropic-beta, user-agent, etc.)
      const skipHeaders = new Set(['host', 'connection', 'content-length', 'content-type', 'accept', 'authorization', 'x-api-key', 'anthropic-version', 'x-pp-provider-id', 'x-pp-model', 'x-pp-provider-url', 'x-pp-provider-protocol', 'x-pp-provider-keys', 'x-pp-provider-adapter', 'x-pp-provider-capabilities', 'x-pp-provider-name']);
      const headers = {};
      for (const [key, val] of Object.entries(req.headers)) {
        if (!skipHeaders.has(key.toLowerCase())) headers[key] = val;
      }
      headers['Content-Type'] = 'application/json';
      headers['Accept'] = isStream ? 'text/event-stream' : 'application/json';

      const maxKeyRetries = (candidate.apiKeys || []).filter(k => typeof k === 'object' ? k.enabled !== false : true).length || 1;
      let lastKeyError = null;
      let keyLabel = '';

      for (let keyAttempt = 0; keyAttempt < maxKeyRetries; keyAttempt++) {
        const currentKey = selectKey(candidate.providerId, candidate.apiKeys || []);
        const keyEntry = (candidate.apiKeys || []).find(k => (typeof k === 'string' ? k : k.key) === currentKey);
        const alias = keyEntry && typeof keyEntry === 'object' ? keyEntry.alias : '';
        keyLabel = alias ? `${alias}(…${currentKey.slice(-4)})` : (currentKey ? `…${currentKey.slice(-4)}` : '-');
        const keyHeaders = { ...headers };

        if (candidate.protocol === 'openai' || candidate.protocol === 'responses') {
          if (isAzure) keyHeaders['api-key'] = currentKey;
          else keyHeaders['Authorization'] = `Bearer ${currentKey}`;
        } else if (candidate.protocol === 'gemini') {
          keyHeaders['x-goog-api-key'] = currentKey;
        } else if (candidate.protocol === 'anthropic') {
          keyHeaders['X-Api-Key'] = currentKey;
          keyHeaders['anthropic-version'] = keyHeaders['anthropic-version'] || '2023-06-01';
          keyHeaders['Authorization'] = `Bearer ${currentKey}`;
        }

      const startedAt = Date.now();

      try {
        let fetchRes = await fetch(targetUrl, {
          method: 'POST',
          headers: keyHeaders,
          body: JSON.stringify(targetBody),
          signal: AbortSignal.timeout(120000),  // 2 分钟：仅覆盖连接建立 + 等待首字节，不影响后续流
        });

        // 上游不支持图片：去掉图片内容后自动重试一次
        let errBodyText = null;
        if (!fetchRes.ok) {
          errBodyText = await fetchRes.text();
          if (fetchRes.status === 404 && /image/i.test(errBodyText) && !targetBody.__imageStripped) {
            logger.log(`[${requestId}] 上游不支持图片输入，去掉图片后重试`);
            targetBody = stripImageFromMessages({ ...targetBody, __imageStripped: true }, targetProtocol);
            fetchRes = await fetch(targetUrl, {
              method: 'POST', headers: keyHeaders, body: JSON.stringify(targetBody),
              signal: AbortSignal.timeout(120000),
            });
            errBodyText = null; // 新响应需重新读取
          }
        }

        if (!fetchRes.ok) {
          const errBody = errBodyText || await fetchRes.text();
          const error = Object.assign(new Error(errBody.slice(0, 500) || `HTTP ${fetchRes.status}`), { status: fetchRes.status });
          // 记录详细错误信息用于调试
          logger.log(`[${requestId}] ERROR ${fetchRes.status} from ${candidate.providerName}: ${errBody.slice(0, 1000)}`);
          logger.log(`[${requestId}] ERROR request body: ${JSON.stringify(targetBody).slice(0, 3000)}`);
          // 429: mark key cooldown and retry with next key
          if (fetchRes.status === 429 && maxKeyRetries > 1) {
            markKeyCooldown(candidate.providerId, currentKey);
            lastKeyError = error;
            logger.log(`[${requestId}] 429 on key ${currentKey.slice(0, 8)}..., trying next key`);
            continue;
          }
          if (isRetryableStatus(fetchRes.status)) {
            throw error;
          }
          return res.status(fetchRes.status).json({ error: error.message });
        }

        recordSuccess(proxyId, candidate.providerId, Date.now() - startedAt);
        logger.log(`[${requestId}] ✓ ${candidate.providerName} | model=${candidateModel || '(default)'} key=${keyLabel} (${Date.now() - startedAt}ms)`);

        if (isStream) {
          res.setHeader('Content-Type', 'text/event-stream');
          res.setHeader('Cache-Control', 'no-cache');
          res.setHeader('Connection', 'keep-alive');

          const baseSseConverter = createSSEConv ? createSSEConv(effectiveModel) : null;
          const streamNormalizer = providerAdapter && providerAdapter.transformStreamChunk
            ? createStreamNormalizer(providerAdapter.transformStreamChunk)
            : null;
          const reader = fetchRes.body.getReader();
          const decoder = new TextDecoder();
          let streamUsage = null;
          let responseText = '';
          let reasoningText = '';
          let toolCallCount = 0;

          function handleNormalizedChunk(chunk) {
            if (!chunk) return;
            for (const line of chunk.split('\n')) {
              const trimmed = line.trim();
              if (!trimmed.startsWith('data:') || trimmed === 'data: [DONE]') continue;
              try {
                const d = JSON.parse(trimmed.slice(5).trim());
                if (d.usage) streamUsage = d.usage;
                const delta = d.choices?.[0]?.delta;
                if (delta?.content) responseText += delta.content;
                if (delta?.reasoning_content) reasoningText += delta.reasoning_content;
                if (delta?.tool_calls) {
                  for (const tc of delta.tool_calls) {
                    if (tc.function?.name) {
                      toolCallCount++;
                      logger.log(`[${requestId}] [RESPONSES→openai] upstream tool_call: ${tc.function.name}`);
                    }
                  }
                }
              } catch { /* ignore */ }
            }

            if (baseSseConverter) {
              const converted = baseSseConverter.convertChunk(chunk);
              if (converted) { res.write(converted); res.flush?.(); }
            } else {
              res.write(chunk);
              res.flush?.();
            }
          }

          req.on('close', () => {
            try { reader.cancel(); } catch { /* ignore */ }
          });

          // 空闲超时：每次收到数据重置计时器，超过 idleTimeoutMs 没收到数据才断开
          const idleTimeoutMs = proxyConfig.timeout || 300000;
          let lastChunkAt = Date.now();
          const idleTimer = setInterval(() => {
            if (Date.now() - lastChunkAt > idleTimeoutMs) {
              logger.log(`[${requestId}] 流式空闲超时 (${idleTimeoutMs / 1000}s 未收到数据)`);
              try { reader.cancel(); } catch { /* ignore */ }
            }
          }, 5000);

          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              lastChunkAt = Date.now();  // 每收到数据就重置
              const rawChunk = decoder.decode(value, { stream: true });
              const chunk = streamNormalizer ? streamNormalizer.convertChunk(rawChunk) : rawChunk;
              handleNormalizedChunk(chunk);
            }
            clearInterval(idleTimer);

            const finalRawChunk = decoder.decode();
            if (finalRawChunk) {
              const chunk = streamNormalizer ? streamNormalizer.convertChunk(finalRawChunk) : finalRawChunk;
              handleNormalizedChunk(chunk);
            }

            if (streamNormalizer) {
              handleNormalizedChunk(streamNormalizer.flush());
            }

            // Cache reasoning_content from streaming response for future requests
            // 对于 responses→* 路径，reasoning 由 baseSseConverter（c2r/a2r）内部累积，
            // 这里优先从 converter 取出，保证 responses 入站也能缓存 reasoning
            let convReasoning = '';
            if (baseSseConverter && typeof baseSseConverter.getReasoningText === 'function') {
              convReasoning = baseSseConverter.getReasoningText() || '';
            }
            const effectiveReasoning = convReasoning || reasoningText;
            if (effectiveReasoning && responseText) {
              const msg = { content: responseText, tool_calls: null };
              setReasoning(msg, effectiveReasoning);
            }

            if (streamUsage) {
              recordUsage(proxyConfig.id, candidate.providerName, candidateModel, streamUsage, false);
              requestLog.add({
                id: requestId, proxyId, proxyName, method: req.method, path: req.path,
                inboundProtocol, targetProtocol: candidate.protocol,
                providerName: candidate.providerName, model: candidateModel || '',
                status: 'success', upstreamStatusCode: null,
                latencyMs: Date.now() - startedAt,
                promptTokens: streamUsage.prompt_tokens || streamUsage.input_tokens || 0,
                completionTokens: streamUsage.completion_tokens || streamUsage.output_tokens || 0,
                totalTokens: (streamUsage.prompt_tokens || streamUsage.input_tokens || 0)
                           + (streamUsage.completion_tokens || streamUsage.output_tokens || 0),
                isEstimated: false, stream: true, keyAlias: keyLabel, errorMessage: null, clientIP,
                requestBody: requestLogBody,
              });
            } else if (responseText || toolCallCount > 0) {
              const inputTokens = estimateInputTokens(req.body);
              const outputTokens = estimateTokens(responseText) + toolCallCount * 15;
              recordUsage(proxyConfig.id, candidate.providerName, candidateModel, {
                prompt_tokens: inputTokens,
                completion_tokens: outputTokens,
              }, true);
              requestLog.add({
                id: requestId, proxyId, proxyName, method: req.method, path: req.path,
                inboundProtocol, targetProtocol: candidate.protocol,
                providerName: candidate.providerName, model: candidateModel || '',
                status: 'success', upstreamStatusCode: null,
                latencyMs: Date.now() - startedAt,
                promptTokens: inputTokens, completionTokens: outputTokens,
                totalTokens: inputTokens + outputTokens,
                isEstimated: true, stream: true, keyAlias: keyLabel, errorMessage: null, clientIP,
                requestBody: requestLogBody,
              });
            }

            if (baseSseConverter) {
              // 先注入 proxy 侧已收集的 usage（转换器内部若有自取的 usage 会优先用自己的）
              // 必须在 flush() 之前 setUsage，因为 flush() → finish() 会生成 response.completed（含 usage）
              if (streamUsage && typeof baseSseConverter.setUsage === 'function') {
                const u = streamUsage;
                baseSseConverter.setUsage({
                  input_tokens: u.prompt_tokens || u.input_tokens || 0,
                  output_tokens: u.completion_tokens || u.output_tokens || 0,
                  total_tokens: u.total_tokens || (u.prompt_tokens || u.input_tokens || 0) + (u.completion_tokens || u.output_tokens || 0),
                });
              }
              const flushed = baseSseConverter.flush();
              if (flushed) res.write(flushed);
            }

            res.end();
          } catch (err) {
            clearInterval(idleTimer);
            recordFailure(proxyId, candidate.providerId);
            logger.error(`[${requestId}] Stream error:`, err.message);
            requestLog.add({
              id: requestId, proxyId, proxyName, method: req.method, path: req.path,
              inboundProtocol, targetProtocol: candidate.protocol,
              providerName: candidate.providerName, model: candidateModel || '',
              status: 'failure', upstreamStatusCode: null,
              latencyMs: Date.now() - startedAt,
              promptTokens: 0, completionTokens: 0, totalTokens: 0, isEstimated: false,
              stream: true, keyAlias: keyLabel, errorMessage: err.message, clientIP,
              requestBody: requestLogBody,
            });
            if (!res.writableEnded) {
              try {
                res.write(`data: ${JSON.stringify({ error: { message: err.message, type: 'proxy_error' } })}\n\n`);
              } catch { /* ignore */ }
            }
          } finally {
            res.end();
          }
          return;
        }

        const responseBody = await fetchRes.json().catch(async () => {
          // 上游可能返回 SSE 格式的错误（如 data:{"error":...}），尝试解析
          const text = await fetchRes.text().catch(() => '');
          const sseMatch = text.match(/^data:\s*(.+)/m);
          if (sseMatch) {
            try { return JSON.parse(sseMatch[1].trim()); } catch {}
          }
          try { return JSON.parse(text); } catch {}
          return { error: { message: text || '上游返回非 JSON 响应', type: 'proxy_error' } };
        });
        extractReasoningFromResponse(responseBody);
        extractAnthropicThinking(responseBody);
        // 记录工具调用（Responses API 路径）
        if (inboundProtocol === 'responses' && responseBody.output) {
          for (const item of responseBody.output) {
            if (item.type === 'function_call' || item.type === 'custom_tool_call') {
              logger.log(`[${requestId}] [RESPONSES] upstream response tool_call: ${item.type} name=${item.name}`);
            }
          }
        }
        recordUsage(proxyConfig.id, candidate.providerName, candidateModel, responseBody.usage);
        requestLog.add({
          id: requestId, proxyId, proxyName, method: req.method, path: req.path,
          inboundProtocol, targetProtocol: candidate.protocol,
          providerName: candidate.providerName, model: candidateModel || '',
          status: 'success', upstreamStatusCode: fetchRes.status,
          latencyMs: Date.now() - startedAt,
          promptTokens: responseBody.usage?.prompt_tokens || responseBody.usage?.input_tokens || 0,
          completionTokens: responseBody.usage?.completion_tokens || responseBody.usage?.output_tokens || 0,
          totalTokens: (responseBody.usage?.prompt_tokens || responseBody.usage?.input_tokens || 0)
                     + (responseBody.usage?.completion_tokens || responseBody.usage?.output_tokens || 0),
          isEstimated: false, stream: false, keyAlias: keyLabel, errorMessage: null, clientIP,
          requestBody: requestLogBody,
        });
        if (providerAdapter && providerAdapter.postprocessResponseBody) {
          providerAdapter.postprocessResponseBody(responseBody);
        }
        const convertedBody = convertRes(responseBody);
        return res.json(convertedBody);
      } catch (err) {
        // 429 already handled by key retry loop above
        if (err?.status === 429 && maxKeyRetries > 1) {
          lastKeyError = err;
          continue; // retry with next key
        }
        recordFailure(proxyId, candidate.providerId);
        logger.error(`[${requestId}] ✗ ${candidate.providerName} | model=${candidateModel || '(default)'} - ${err.message}`);
        requestLog.add({
          id: requestId, proxyId, proxyName, method: req.method, path: req.path,
          inboundProtocol, targetProtocol: candidate.protocol,
          providerName: candidate.providerName, model: candidateModel || '',
          status: 'failure', upstreamStatusCode: err?.status || null,
          latencyMs: Date.now() - startedAt,
          promptTokens: 0, completionTokens: 0, totalTokens: 0, isEstimated: false,
          stream: isStream, keyAlias: keyLabel, errorMessage: err.message, clientIP,
          requestBody: requestLogBody,
        });
        if (err?.status && !isRetryableStatus(err.status)) {
          return res.status(err.status).json({ error: err.message });
        }
        break; // break key retry loop, continue to next candidate
      }
      break; // success, exit key retry loop
      } // end key retry loop

      // All keys exhausted with 429 — trigger circuit breaker
      if (lastKeyError) {
        recordFailure(proxyId, candidate.providerId);
        logger.error(`[${requestId}] ✗ ${candidate.providerName} | all keys rate-limited (429)`);
        requestLog.add({
          id: requestId, proxyId, proxyName, method: req.method, path: req.path,
          inboundProtocol, targetProtocol: candidate.protocol,
          providerName: candidate.providerName, model: candidateModel || '',
          status: '429', upstreamStatusCode: 429,
          latencyMs: Date.now() - startedAt,
          promptTokens: 0, completionTokens: 0, totalTokens: 0, isEstimated: false,
          stream: isStream, keyAlias: keyLabel, errorMessage: 'All keys rate-limited', clientIP,
          requestBody: requestLogBody,
        });
      }
      lastKeyLabel = keyLabel;
    } // end candidate loop

    logger.error(`[${requestId}] 所有供应商均失败`);
    requestLog.add({
      id: requestId, proxyId, proxyName, method: req.method, path: req.path,
      inboundProtocol, targetProtocol: lastCandidate?.protocol || '', providerName: lastCandidate?.providerName || 'N/A', model: effectiveModel || '',
      status: 'failure', upstreamStatusCode: null,
      latencyMs: Date.now() - requestStart,
      promptTokens: 0, completionTokens: 0, totalTokens: 0, isEstimated: false,
      stream: isStream, keyAlias: lastKeyLabel || '-', errorMessage: 'All providers failed', clientIP,
      requestBody: requestLogBody,
    });
    return res.status(502).json({ error: 'All providers failed' });
  }

  return app;
}

function buildTargetUrl(target, originalPath, isStream, effectiveModel) {
  const base = (target.providerUrl || '').replace(/\/$/, '');
  if (!base) return '';
  // Support any version suffix (/v1, /v2, /v3, etc.)
  const hasVersionSuffix = /\/v\d+$/.test(base);
  const baseUrl = hasVersionSuffix ? base.replace(/\/v\d+$/, '') : base;

  if (target.protocol === 'openai') {
    if (target.azureDeployment) {
      const ver = target.azureApiVersion || '2024-02-01';
      return `${base}/openai/deployments/${target.azureDeployment}/chat/completions?api-version=${ver}`;
    }
    if (hasVersionSuffix) return `${base}/chat/completions`;
    return `${baseUrl}/v1/chat/completions`;
  }

  if (target.protocol === 'anthropic') {
    if (hasVersionSuffix) return `${base}/messages`;
    return `${baseUrl}/v1/messages`;
  }

  if (target.protocol === 'gemini') {
    const model = effectiveModel || 'gemini-pro';
    const action = isStream ? 'streamGenerateContent?alt=sse' : 'generateContent';
    return `${baseUrl}/v1beta/models/${model}:${action}`;
  }

  if (target.protocol === 'responses') {
    if (hasVersionSuffix) return `${base}/responses`;
    return `${baseUrl}/v1/responses`;
  }

  return base + originalPath;
}

function createStreamNormalizer(transformStreamChunk) {
  let buffer = '';

  return {
    convertChunk(text) {
      buffer += text;
      const lastNewline = buffer.lastIndexOf('\n');
      if (lastNewline < 0) return '';

      const complete = buffer.slice(0, lastNewline + 1);
      buffer = buffer.slice(lastNewline + 1);
      return transformStreamChunk(complete);
    },

    flush() {
      if (!buffer) return '';
      const remaining = buffer;
      buffer = '';
      return transformStreamChunk(remaining);
    },
  };
}

module.exports = { createProxyApp };
