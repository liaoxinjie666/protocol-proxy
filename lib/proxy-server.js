const express = require('express');
const { detectInboundProtocol } = require('./detector');
const o2a = require('./converters/openai-to-anthropic');
const a2o = require('./converters/anthropic-to-openai');
const o2g = require('./converters/openai-to-gemini');
const g2o = require('./converters/gemini-to-openai');
const a2g = require('./converters/anthropic-to-gemini');
const g2a = require('./converters/gemini-to-anthropic');
const { recordUsage } = require('./stats-store');

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
      // CJK 字符 ~1.5 token/字
      if (code >= 0x4E00 && code <= 0x9FFF) tokens += 1.5;
      // 全角标点等 ~1 token
      else if (code >= 0x3000 && code <= 0x303F) tokens += 1;
      // 其他（ASCII 字母、数字、标点、空格）~0.25 token
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
    if (body.tools) {
      text += JSON.stringify(body.tools);
    }
    return estimateTokens(text);
  }

  function injectReasoningToMessages(messages) {
    if (!Array.isArray(messages)) return;
    for (const msg of messages) {
      if (msg.role === 'assistant' && msg.reasoning_content === undefined) {
        const reasoning = getReasoning(msg);
        // DeepSeek 等 reasoning model 要求 assistant message 必须包含 reasoning_content 字段
        msg.reasoning_content = reasoning || '';
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

      console.log(`[${requestId}] ⬅️  ${(inboundProtocol || 'unknown').toUpperCase()} → ${targetProtocol.toUpperCase()} | path=${req.path}`);

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
      } else if (inboundProtocol === 'openai' && targetProtocol === 'gemini') {
        convertReq = o2g.convertRequest;
        convertRes = o2g.convertResponse;
        createSSEConv = o2g.createSSEConverter;
      } else if (inboundProtocol === 'gemini' && targetProtocol === 'openai') {
        convertReq = g2o.convertRequest;
        convertRes = g2o.convertResponse;
        createSSEConv = g2o.createSSEConverter;
      } else if (inboundProtocol === 'anthropic' && targetProtocol === 'gemini') {
        convertReq = a2g.convertRequest;
        convertRes = a2g.convertResponse;
        createSSEConv = a2g.createSSEConverter;
      } else if (inboundProtocol === 'gemini' && targetProtocol === 'anthropic') {
        convertReq = g2a.convertRequest;
        convertRes = g2a.convertResponse;
        createSSEConv = g2a.createSSEConverter;
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

      const isAzure = !!target.azureDeployment && /azure/i.test(target.providerUrl);

      // 流式请求时注入 stream_options 以获取 usage 统计（Azure 不支持）
      if (isStream && targetProtocol === 'openai' && !isAzure) {
        targetBody.stream_options = { include_usage: true };
      }

      // 注入 reasoning_content（针对 DeepSeek 等 reasoning model）
      injectReasoningToMessages(targetBody.messages);

      // 构建目标 URL
      const targetUrl = buildTargetUrl(target, req.path, isStream, effectiveModel);
      console.log(`[${requestId}] 🔗 ${targetUrl} | model=${effectiveModel}`);

      // 构建请求头
      const headers = {
        'Content-Type': 'application/json',
        'Accept': isStream ? 'text/event-stream' : 'application/json',
      };

      if (targetProtocol === 'openai') {
        if (isAzure) {
          headers['api-key'] = target.apiKey;
        } else {
          headers['Authorization'] = `Bearer ${target.apiKey}`;
        }
      } else if (targetProtocol === 'gemini') {
        headers['x-goog-api-key'] = target.apiKey;
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

      // 流式响应（以客户端请求意图为准，不依赖上游 Content-Type）
      if (isStream) {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');

        const sseConverter = createSSEConv ? createSSEConv(effectiveModel) : null;
        const reader = fetchRes.body.getReader();
        const decoder = new TextDecoder();
        let streamUsage = null;
        let responseText = '';
        let toolCallCount = 0;

        req.on('close', () => {
          try { reader.cancel(); } catch (err) { /* ignore */ }
        });

        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            const chunk = decoder.decode(value, { stream: true });
            // 从流中提取 usage 和响应内容
            const lines = chunk.split('\n');
            for (const line of lines) {
              const trimmed = line.trim();
              if (!trimmed.startsWith('data:') || trimmed === 'data: [DONE]') continue;
              try {
                const d = JSON.parse(trimmed.slice(5).trim());
                if (d.usage) streamUsage = d.usage;
                const delta = d.choices?.[0]?.delta;
                if (delta?.content) responseText += delta.content;
                if (delta?.tool_calls) {
                  for (const tc of delta.tool_calls) {
                    if (tc.function?.name) toolCallCount++;
                  }
                }
              } catch { /* ignore */ }
            }
            if (sseConverter) {
              const converted = sseConverter.convertChunk(chunk);
              if (converted) res.write(converted);
            } else {
              res.write(chunk);
            }
          }

          if (streamUsage) {
            recordUsage(proxyConfig.id, proxyConfig.target?.providerName, req.body?.model, streamUsage, false);
          } else if (responseText || toolCallCount > 0) {
            // 上游未返回 usage，从响应内容估算
            const inputTokens = estimateInputTokens(req.body);
            const outputTokens = estimateTokens(responseText) + toolCallCount * 15;
            recordUsage(proxyConfig.id, proxyConfig.target?.providerName, req.body?.model, {
              prompt_tokens: inputTokens,
              completion_tokens: outputTokens,
            }, true);
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
      recordUsage(proxyConfig.id, proxyConfig.target?.providerName, req.body?.model, responseBody.usage);
      const convertedBody = convertRes(responseBody);
      res.json(convertedBody);

    } catch (err) {
      console.error(`[${requestId}] ❌ Proxy error:`, err.message);
      res.status(500).json({ error: 'Proxy error', message: err.message });
    }
  }

  return app;
}

function buildTargetUrl(target, originalPath, isStream, effectiveModel) {
  const base = target.providerUrl.replace(/\/$/, '');
  const hasV1Suffix = base.endsWith('/v1');

  if (target.protocol === 'openai') {
    // Azure OpenAI
    if (target.azureDeployment) {
      const ver = target.azureApiVersion || '2024-02-01';
      return `${base}/openai/deployments/${target.azureDeployment}/chat/completions?api-version=${ver}`;
    }
    if (hasV1Suffix) return `${base}/chat/completions`;
    return `${base}/v1/chat/completions`;
  }

  if (target.protocol === 'anthropic') {
    if (hasV1Suffix) return `${base}/messages`;
    return `${base}/v1/messages`;
  }

  if (target.protocol === 'gemini') {
    const model = effectiveModel || 'gemini-pro';
    const action = isStream ? 'streamGenerateContent?alt=sse' : 'generateContent';
    return `${base}/v1beta/models/${model}:${action}`;
  }

  return base + originalPath;
}

module.exports = { createProxyApp };
