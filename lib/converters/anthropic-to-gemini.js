/**
 * Anthropic → Gemini 协议转换
 */

const { encodeAnthropicEvent } = require('./sse-helpers');

function generateToolUseId() {
  return 'toolu_' + Math.random().toString(36).slice(2, 14) + Math.random().toString(36).slice(2, 10);
}

// ==================== 请求转换 ====================

function convertRequest(body, targetModel) {
  const contents = [];
  let systemInstruction = null;

  // system 顶级字段
  if (body.system) {
    const text = typeof body.system === 'string'
      ? body.system
      : (Array.isArray(body.system) ? body.system.map(s => s.text || s).join('\n') : '');
    if (text) systemInstruction = { parts: [{ text }] };
  }

  // messages → contents
  for (const msg of (body.messages || [])) {
    if (msg.role === 'assistant') {
      const parts = [];
      if (typeof msg.content === 'string') {
        parts.push({ text: msg.content });
      } else if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block.type === 'text' && block.text) parts.push({ text: block.text });
          if (block.type === 'tool_use') {
            parts.push({
              functionCall: { name: block.name, args: block.input || {} },
            });
          }
        }
      }
      if (parts.length > 0) contents.push({ role: 'model', parts });
    } else if (msg.role === 'user') {
      const parts = [];
      if (typeof msg.content === 'string') {
        parts.push({ text: msg.content });
      } else if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block.type === 'text' && block.text) parts.push({ text: block.text });
          if (block.type === 'tool_result') {
            parts.push({
              functionResponse: {
                name: block.tool_use_id || 'unknown',
                response: typeof block.content === 'string' ? { result: block.content } : block.content || {},
              },
            });
          }
        }
      }
      if (parts.length > 0) contents.push({ role: 'user', parts });
    }
  }

  const result = { contents };
  if (systemInstruction) result.systemInstruction = systemInstruction;

  // 转换 tools → functionDeclarations
  if (body.tools && Array.isArray(body.tools)) {
    const functionDeclarations = body.tools.map(t => ({
      name: t.name,
      description: t.description || '',
      parameters: t.input_schema || { type: 'object', properties: {} },
    }));
    result.tools = [{ functionDeclarations }];
  }

  // generationConfig
  const gc = {};
  if (body.max_tokens !== undefined) gc.maxOutputTokens = body.max_tokens;
  if (body.temperature !== undefined) gc.temperature = body.temperature;
  if (body.top_p !== undefined) gc.topP = body.top_p;
  if (body.stop_sequences) gc.stopSequences = body.stop_sequences;
  if (Object.keys(gc).length > 0) result.generationConfig = gc;

  return result;
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

function createSSEConverter() {
  const state = { started: false, textBlockStarted: false, textBlockClosed: false, blockIndex: 0, sentFunctionCall: new Map(), buffer: '' };

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

        // message_start（只发一次）
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
          // 在首个 functionCall 前关闭 text block
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
