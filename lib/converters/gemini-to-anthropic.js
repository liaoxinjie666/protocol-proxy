/**
 * Gemini → Anthropic 协议转换
 */

const { encodeAnthropicEvent } = require('./sse-helpers');

function generateToolUseId() {
  return 'toolu_' + Math.random().toString(36).slice(2, 14) + Math.random().toString(36).slice(2, 10);
}

// ==================== 请求转换 ====================

function convertRequest(body, targetModel) {
  const messages = [];
  // 追踪 Gemini 函数名 → 生成的 tool_use id，用于后续 tool_result 转换
  const nameToId = new Map();

  // system_instruction → system 顶级字段
  const sysText = body.systemInstruction?.parts?.map(p => p.text || '').join('') || '';
  const system = sysText || undefined;

  // tools: functionDeclarations → Anthropic tools
  let tools = undefined;
  if (body.tools && Array.isArray(body.tools)) {
    const allDeclarations = [];
    for (const tool of body.tools) {
      if (tool.functionDeclarations) {
        allDeclarations.push(...tool.functionDeclarations);
      }
    }
    if (allDeclarations.length > 0) {
      tools = allDeclarations.map(fd => ({
        name: fd.name,
        description: fd.description || '',
        input_schema: fd.parameters || { type: 'object', properties: {} },
      }));
    }
  }

  // contents → messages
  for (const msg of (body.contents || [])) {
    const role = msg.role === 'model' ? 'assistant' : 'user';
    const parts = msg.parts || [];

    // assistant + functionCall
    const functionCalls = parts.filter(p => p.functionCall);
    if (role === 'assistant' && functionCalls.length > 0) {
      const content = [];
      const text = parts.filter(p => p.text).map(p => p.text).join('');
      if (text) content.push({ type: 'text', text });
      for (const fc of functionCalls) {
        const toolId = generateToolUseId();
        const fnName = fc.functionCall.name || 'unknown';
        nameToId.set(fnName, toolId);
        content.push({
          type: 'tool_use',
          id: toolId,
          name: fnName,
          input: fc.functionCall.args || {},
        });
      }
      messages.push({ role: 'assistant', content });
      continue;
    }

    // user + functionResponse → tool_result
    const functionResponses = parts.filter(p => p.functionResponse);
    if (role === 'user' && functionResponses.length > 0) {
      const content = [];
      const text = parts.filter(p => p.text).map(p => p.text).join('');
      if (text) content.push({ type: 'text', text });
      for (const fr of functionResponses) {
        // 用函数名查找之前生成的 tool_use id，找不到则用原始名
        const toolId = nameToId.get(fr.functionResponse.name) || fr.functionResponse.name || 'unknown';
        content.push({
          type: 'tool_result',
          tool_use_id: toolId,
          content: typeof fr.functionResponse.response === 'string'
            ? fr.functionResponse.response
            : JSON.stringify(fr.functionResponse.response || {}),
        });
      }
      messages.push({ role: 'user', content });
      continue;
    }

    // 纯文本
    const text = parts.filter(p => p.text).map(p => p.text).join('');
    if (text) {
      messages.push({ role, content: text });
    }
  }

  const result = {
    model: targetModel,
    max_tokens: body.generationConfig?.maxOutputTokens || 4096,
    messages,
  };

  if (system) result.system = system;
  if (tools) result.tools = tools;
  if (body.generationConfig?.temperature !== undefined) result.temperature = body.generationConfig.temperature;
  if (body.generationConfig?.topP !== undefined) result.top_p = body.generationConfig.topP;
  if (body.generationConfig?.stopSequences) result.stop_sequences = body.generationConfig.stopSequences;

  return { ...result, nameToId };
}

// ==================== 响应转换 ====================

function convertResponse(geminiBody) {
  const candidate = geminiBody.candidates?.[0];
  const content = [];

  if (candidate?.content?.parts) {
    for (const part of candidate.content.parts) {
      if (part.text) {
        content.push({ type: 'text', text: part.text });
      }
      if (part.functionCall) {
        content.push({
          type: 'tool_use',
          id: generateToolUseId(),
          name: part.functionCall.name,
          input: part.functionCall.args || {},
        });
      }
    }
  }

  const stopReason = candidate?.content?.parts?.some(p => p.functionCall)
    ? 'tool_use' : mapFinishReason(candidate?.finishReason);

  return {
    id: '',
    type: 'message',
    role: 'assistant',
    content,
    stop_reason: stopReason,
    usage: {
      input_tokens: geminiBody.usageMetadata?.promptTokenCount || 0,
      output_tokens: geminiBody.usageMetadata?.candidatesTokenCount || 0,
    },
  };
}

function mapFinishReason(reason) {
  if (!reason) return null;
  if (reason === 'STOP') return 'end_turn';
  if (reason === 'MAX_TOKENS') return 'max_tokens';
  if (reason === 'SAFETY') return 'end_turn';
  return 'end_turn';
}

// ==================== SSE 流式转换 ====================

function createSSEConverter(nameToId = new Map()) {
  const state = { started: false, textBlockStarted: false, textBlockClosed: false, blockIndex: 0, sentFunctionCall: new Map(), nameToId, buffer: '' };

  return {
    convertChunk(chunkText) {
      let output = '';
      state.buffer += chunkText;
      const lines = state.buffer.split('\n');
      state.buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data: ')) continue;
        const dataStr = trimmed.slice(6);
        if (!dataStr) continue;

        let chunk;
        try { chunk = JSON.parse(dataStr); } catch { continue; }

        const candidate = chunk.candidates?.[0];
        if (!candidate) continue;

        // message_start
        if (!state.started) {
          state.started = true;
          output += encodeAnthropicEvent('message_start', {
            type: 'message_start',
            message: {
              id: '',
              type: 'message',
              role: 'assistant',
              content: [],
              stop_reason: null,
              usage: { input_tokens: 0, output_tokens: 0 },
            },
          });
        }

        const parts = candidate.content?.parts || [];

        // 文本增量
        const text = parts.filter(p => p.text).map(p => p.text).join('') || '';
        if (text) {
          if (!state.textBlockStarted) {
            state.textBlockStarted = true;
            state.textBlockIndex = state.blockIndex++;
            output += encodeAnthropicEvent('content_block_start', {
              type: 'content_block_start',
              index: state.textBlockIndex,
              content_block: { type: 'text', text: '' },
            });
          }
          output += encodeAnthropicEvent('content_block_delta', {
            type: 'content_block_delta',
            index: state.textBlockIndex,
            delta: { type: 'text_delta', text },
          });
        }

        // functionCall 增量（去重，首次生成 ID 后缓存）
        for (const part of parts) {
          if (!part.functionCall) continue;
          if (state.textBlockStarted && !state.textBlockClosed) {
            state.textBlockClosed = true;
            output += encodeAnthropicEvent('content_block_stop', {
              type: 'content_block_stop',
              index: state.textBlockIndex,
            });
          }
          const key = part.functionCall.name + (typeof part.functionCall.args === 'string' ? part.functionCall.args : JSON.stringify(part.functionCall.args || {}));
          if (state.sentFunctionCall.has(key)) continue;
          const toolId = generateToolUseId();
          state.sentFunctionCall.set(key, toolId);
          state.nameToId.set(part.functionCall.name, toolId);

          const idx = state.blockIndex++;
          output += encodeAnthropicEvent('content_block_start', {
            type: 'content_block_start',
            index: idx,
            content_block: {
              type: 'tool_use',
              id: toolId,
              name: part.functionCall.name,
              input: {},
            },
          });
          output += encodeAnthropicEvent('content_block_delta', {
            type: 'content_block_delta',
            index: idx,
            delta: { type: 'input_json_delta', partial_json: JSON.stringify(part.functionCall.args || {}) },
          });
          output += encodeAnthropicEvent('content_block_stop', {
            type: 'content_block_stop',
            index: idx,
          });
        }

        // finish
        if (candidate.finishReason) {
          if (state.textBlockStarted && !state.textBlockClosed) {
            output += encodeAnthropicEvent('content_block_stop', {
              type: 'content_block_stop',
              index: state.textBlockIndex,
            });
          }
          output += encodeAnthropicEvent('message_delta', {
            type: 'message_delta',
            delta: { stop_reason: mapFinishReason(candidate.finishReason) },
            usage: { output_tokens: 0 },
          });
          output += encodeAnthropicEvent('message_stop', { type: 'message_stop' });
        }
      }

      return output || null;
    },
    flush() { return ''; },
  };
}

module.exports = { convertRequest, convertResponse, createSSEConverter };
