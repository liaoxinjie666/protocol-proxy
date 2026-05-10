/**
 * OpenAI → Gemini 协议转换
 */

const { encodeOpenAIEvent, encodeOpenAIDone } = require('./sse-helpers');

// ==================== 请求转换 ====================

function generateCallId() {
  return 'call_' + Math.random().toString(36).slice(2, 14);
}

function convertRequest(body, targetModel) {
  const contents = [];
  let systemInstruction = null;

  for (const msg of (body.messages || [])) {
    if (msg.role === 'system') {
      // 多段 system 合并为一个
      const text = typeof msg.content === 'string' ? msg.content : '';
      if (!systemInstruction) {
        systemInstruction = { parts: [{ text }] };
      } else {
        systemInstruction.parts[0].text += '\n' + text;
      }
      continue;
    }

    // tool role → functionResponse
    if (msg.role === 'tool') {
      contents.push({
        role: 'user',
        parts: [{
          functionResponse: {
            name: msg.tool_call_id || 'unknown',
            response: typeof msg.content === 'string' ? { result: msg.content } : msg.content || {},
          },
        }],
      });
      continue;
    }

    // assistant with tool_calls → functionCall
    if (msg.role === 'assistant' && msg.tool_calls && msg.tool_calls.length > 0) {
      const parts = [];
      if (msg.content) parts.push({ text: typeof msg.content === 'string' ? msg.content : '' });
      for (const tc of msg.tool_calls) {
        let args = {};
        try {
          args = tc.function?.arguments ? JSON.parse(tc.function.arguments) : {};
        } catch { args = {}; }
        parts.push({
          functionCall: {
            name: tc.function?.name || '',
            args,
          },
        });
      }
      contents.push({ role: 'model', parts });
      continue;
    }

    const role = msg.role === 'assistant' ? 'model' : 'user';
    const text = typeof msg.content === 'string' ? msg.content : '';

    // assistant with array content (Anthropic-originated)
    if (Array.isArray(msg.content)) {
      const parts = [];
      for (const block of msg.content) {
        if (block.type === 'text' && block.text) parts.push({ text: block.text });
        if (block.type === 'tool_use') {
          parts.push({
            functionCall: { name: block.name, args: block.input || {} },
          });
        }
        if (block.type === 'tool_result') {
          parts.push({
            functionResponse: {
              name: block.tool_use_id || 'unknown',
              response: typeof block.content === 'string' ? { result: block.content } : block.content || {},
            },
          });
        }
      }
      if (parts.length > 0) {
        contents.push({ role, parts });
      }
      continue;
    }

    if (text) contents.push({ role, parts: [{ text }] });
  }

  const result = { contents };

  if (systemInstruction) {
    result.systemInstruction = systemInstruction;
  }

  // 转换 tools → functionDeclarations
  if (body.tools && Array.isArray(body.tools)) {
    const functionDeclarations = [];
    for (const tool of body.tools) {
      if (tool.type === 'function' && tool.function) {
        functionDeclarations.push({
          name: tool.function.name,
          description: tool.function.description || '',
          parameters: tool.function.parameters || { type: 'object', properties: {} },
        });
      }
    }
    if (functionDeclarations.length > 0) {
      result.tools = [{ functionDeclarations }];
    }
  }

  // generationConfig
  const gc = {};
  if (body.max_tokens !== undefined) gc.maxOutputTokens = body.max_tokens;
  if (body.temperature !== undefined) gc.temperature = body.temperature;
  if (body.top_p !== undefined) gc.topP = body.top_p;
  if (body.stop) gc.stopSequences = Array.isArray(body.stop) ? body.stop : [body.stop];
  if (Object.keys(gc).length > 0) result.generationConfig = gc;

  return result;
}

// ==================== 响应转换 ====================

function convertResponse(geminiBody) {
  const candidate = geminiBody.candidates?.[0];
  if (!candidate) {
    return { id: '', object: 'chat.completion', choices: [], usage: {} };
  }

  const parts = candidate.content?.parts || [];
  const textParts = [];
  const toolCalls = [];

  for (const part of parts) {
    if (part.text) {
      textParts.push(part.text);
    }
    if (part.functionCall) {
      toolCalls.push({
        id: generateCallId(),
        type: 'function',
        function: {
          name: part.functionCall.name,
          arguments: JSON.stringify(part.functionCall.args || {}),
        },
      });
    }
  }

  const message = { role: 'assistant', content: textParts.join('') || null };
  if (toolCalls.length > 0) message.tool_calls = toolCalls;

  return {
    id: '',
    object: 'chat.completion',
    choices: [{
      index: 0,
      message,
      finish_reason: toolCalls.length > 0 ? 'tool_calls' : mapFinishReason(candidate.finishReason),
    }],
    usage: {
      prompt_tokens: geminiBody.usageMetadata?.promptTokenCount || 0,
      completion_tokens: geminiBody.usageMetadata?.candidatesTokenCount || 0,
      total_tokens: geminiBody.usageMetadata?.totalTokenCount || 0,
    },
  };
}

function mapFinishReason(reason) {
  if (!reason) return null;
  if (reason === 'STOP') return 'stop';
  if (reason === 'MAX_TOKENS') return 'length';
  if (reason === 'SAFETY') return 'content_filter';
  return 'stop';
}

// ==================== SSE 流式转换 ====================

function createSSEConverter() {
  const state = { started: false, sentFunctionCall: new Map() };

  return {
    convertChunk(chunkText) {
      let output = '';
      const lines = chunkText.split('\n');

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data: ')) continue;
        const dataStr = trimmed.slice(6);
        if (!dataStr) continue;

        let chunk;
        try { chunk = JSON.parse(dataStr); } catch { continue; }

        const candidate = chunk.candidates?.[0];
        if (!candidate) continue;

        const parts = candidate.content?.parts || [];

        // 首个 chunk 发送 role
        if (!state.started && (parts.length > 0)) {
          state.started = true;
          output += encodeOpenAIEvent({
            id: '',
            object: 'chat.completion.chunk',
            choices: [{
              index: 0,
              delta: { role: 'assistant', content: null },
              finish_reason: null,
            }],
          });
        }

        // 文本增量
        const text = parts.filter(p => p.text).map(p => p.text).join('') || '';
        if (text) {
          output += encodeOpenAIEvent({
            id: '',
            object: 'chat.completion.chunk',
            choices: [{
              index: 0,
              delta: { content: text },
              finish_reason: null,
            }],
          });
        }

        // functionCall 增量（去重，首次生成 ID 后缓存）
        for (const part of parts) {
          if (!part.functionCall) continue;
          const key = part.functionCall.name + (typeof part.functionCall.args === 'string' ? part.functionCall.args : JSON.stringify(part.functionCall.args || {}));
          if (state.sentFunctionCall.has(key)) continue;
          const callId = generateCallId();
          state.sentFunctionCall.set(key, callId);

          output += encodeOpenAIEvent({
            id: '',
            object: 'chat.completion.chunk',
            choices: [{
              index: 0,
              delta: {
                tool_calls: [{
                  index: 0,
                  id: callId,
                  type: 'function',
                  function: {
                    name: part.functionCall.name,
                    arguments: JSON.stringify(part.functionCall.args || {}),
                  },
                }],
              },
              finish_reason: null,
            }],
          });
        }

        // finish
        if (candidate.finishReason) {
          const reason = mapFinishReason(candidate.finishReason);
          output += encodeOpenAIEvent({
            id: '',
            object: 'chat.completion.chunk',
            choices: [{ index: 0, delta: {}, finish_reason: reason }],
          });
          output += encodeOpenAIDone();
        }
      }

      return output || null;
    },
    flush() {
      return '';
    },
  };
}

module.exports = { convertRequest, convertResponse, createSSEConverter };
