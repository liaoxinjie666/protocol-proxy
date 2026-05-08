const express = require('express');
const { detectInboundProtocol } = require('./detector');
const o2a = require('./converters/openai-to-anthropic');
const a2o = require('./converters/anthropic-to-openai');

function createProxyApp(proxyConfigOrGetter) {
  const getProxyConfig = typeof proxyConfigOrGetter === 'function'
    ? proxyConfigOrGetter
    : () => proxyConfigOrGetter;
  const app = express();
  app.use(express.json({ limit: '50mb' }));

  // reasoning_content 缓存（用于 DeepSeek 等 reasoning model）
  // key: assistant message content, value: reasoning_content
  const reasoningCache = new Map();
  const MAX_CACHE_SIZE = 100;

  function setReasoning(content, reasoning) {
    if (!content || !reasoning) return;
    if (reasoningCache.size >= MAX_CACHE_SIZE) {
      const firstKey = reasoningCache.keys().next().value;
      reasoningCache.delete(firstKey);
    }
    reasoningCache.set(content, reasoning);
  }

  function getReasoning(content) {
    return reasoningCache.get(content);
  }

  function injectReasoningToMessages(messages) {
    if (!Array.isArray(messages)) return;
    for (const msg of messages) {
      if (msg.role === 'assistant') {
        const reasoning = getReasoning(msg.content);
        // DeepSeek 等 reasoning model 要求 assistant message 必须包含 reasoning_content 字段
        msg.reasoning_content = reasoning || '';
      }
    }
  }

  function extractReasoningFromResponse(body) {
    const choice = body.choices?.[0];
    const message = choice?.message;
    if (message?.role === 'assistant' && message.reasoning_content) {
      setReasoning(message.content, message.reasoning_content);
    }
  }

  app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Api-Key');
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    next();
  });

  app.use((req, res, next) => {
    const proxyConfig = getProxyConfig();
    if (!proxyConfig.requireAuth || !proxyConfig.authToken) {
      return next();
    }

    const token = req.headers.authorization?.replace('Bearer ', '') || req.headers['x-api-key'];
    if (token !== proxyConfig.authToken) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    next();
  });

  app.post('/v1/chat/completions', handleRequest);
  app.post('/v1/messages', handleRequest);

  async function handleRequest(req, res) {
    const requestId = `req-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    try {
      const proxyConfig = getProxyConfig();
      const inboundProtocol = detectInboundProtocol(req, req.body);
      const target = proxyConfig.target;

      if (!target) {
        return res.status(500).json({ error: 'Proxy target not configured' });
      }

      const targetProtocol = target.protocol;
      const isStream = req.body?.stream === true;

      console.log(`[${requestId}] ⬅️  ${inboundProtocol.toUpperCase()} → ${targetProtocol.toUpperCase()} | path=${req.path}`);

      // 决定转换方向
      let convertReq, convertRes, createSSEConv;
      if (inboundProtocol === 'openai' && targetProtocol === 'anthropic') {
        convertReq = o2a.convertRequest;
        convertRes = o2a.convertResponse;
        createSSEConv = o2a.createSSEConverter;
      } else if (inboundProtocol === 'anthropic' && targetProtocol === 'openai') {
        convertReq = a2o.convertRequest;
        convertRes = a2o.convertResponse;
        createSSEConv = a2o.createSSEConverter;
      } else {
        convertReq = (body, model) => ({ ...body, model: body.model || model });
        convertRes = (body) => body;
        createSSEConv = null;
      }

      // 如果请求没有 model，注入默认 model
      const inboundModel = req.body?.model;
      const effectiveModel = target.defaultModel || inboundModel;
      if (effectiveModel) {
        req.body = { ...req.body, model: effectiveModel };
      }

      const targetBody = convertReq(req.body, effectiveModel);

      // 注入 reasoning_content（针对 DeepSeek 等 reasoning model）
      injectReasoningToMessages(targetBody.messages);

      // 构建目标 URL
      const targetUrl = buildTargetUrl(target.providerUrl, targetProtocol, req.path);
      console.log(`[${requestId}] 🔗 ${targetUrl} | model=${effectiveModel}`);

      // 构建请求头
      const headers = {
        'Content-Type': 'application/json',
        'Accept': isStream ? 'text/event-stream' : 'application/json',
      };

      if (targetProtocol === 'openai') {
        headers['Authorization'] = `Bearer ${target.apiKey}`;
      } else if (targetProtocol === 'anthropic') {
        headers['X-Api-Key'] = target.apiKey;
        headers['Anthropic-Version'] = '2023-06-01';
        headers['Authorization'] = `Bearer ${target.apiKey}`;
      }

      const fetchRes = await fetch(targetUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(targetBody),
        signal: AbortSignal.timeout(120000),
      });

      if (!fetchRes.ok) {
        const errBody = await fetchRes.text();
        console.log(`[${requestId}] ❌ Target error: HTTP ${fetchRes.status} | ${errBody.slice(0, 500)}`);
        res.status(fetchRes.status);
        res.set('Content-Type', fetchRes.headers.get('content-type') || 'application/json');
        return res.send(errBody);
      }

      // 流式响应
      if (isStream && fetchRes.headers.get('content-type')?.includes('text/event-stream')) {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');

        const sseConverter = createSSEConv ? createSSEConv(effectiveModel) : null;
        const reader = fetchRes.body.getReader();
        const decoder = new TextDecoder();

        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            const chunk = decoder.decode(value, { stream: true });
            if (sseConverter) {
              const converted = sseConverter.convertChunk(chunk);
              if (converted) res.write(converted);
            } else {
              res.write(chunk);
            }
          }
          if (sseConverter) {
            const flushed = sseConverter.flush();
            if (flushed) res.write(flushed);
          }
        } catch (err) {
          console.error(`[${requestId}] Stream error:`, err.message);
        } finally {
          res.end();
        }
        return;
      }

      const responseBody = await fetchRes.json();
      extractReasoningFromResponse(responseBody);
      const convertedBody = convertRes(responseBody);
      res.json(convertedBody);

    } catch (err) {
      console.error(`[${requestId}] ❌ Proxy error:`, err.message);
      res.status(500).json({ error: 'Proxy error', message: err.message });
    }
  }

  return app;
}

function buildTargetUrl(providerUrl, targetProtocol, originalPath) {
  const base = providerUrl.replace(/\/$/, '');
  const hasV1Suffix = base.endsWith('/v1');

  if (targetProtocol === 'openai') {
    if (hasV1Suffix) return `${base}/chat/completions`;
    return `${base}/v1/chat/completions`;
  }

  if (targetProtocol === 'anthropic') {
    if (hasV1Suffix) return `${base}/messages`;
    return `${base}/v1/messages`;
  }

  return base + originalPath;
}

module.exports = { createProxyApp };
