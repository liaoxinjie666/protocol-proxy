/**
 * Anthropic → Gemini 协议转换
 */

const { encodeAnthropicEvent } = require('./sse-helpers');

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
      // assistant 消息
      const text = extractText(msg.content);
      contents.push({ role: 'model', parts: [{ text }] });
    } else if (msg.role === 'user') {
      // user 消息，可能包含 text 和 tool_result
      const text = extractText(msg.content);
      if (text) contents.push({ role: 'user', parts: [{ text }] });
    }
  }

  const result = { contents };
  if (systemInstruction) result.systemInstruction = systemInstruction;

  // generationConfig
  const gc = {};
  if (body.max_tokens !== undefined) gc.maxOutputTokens = body.max_tokens;
  if (body.temperature !== undefined) gc.temperature = body.temperature;
  if (body.top_p !== undefined) gc.topP = body.top_p;
  if (body.stop_sequences) gc.stopSequences = body.stop_sequences;
  if (Object.keys(gc).length > 0) result.generationConfig = gc;

  return result;
}

function extractText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter(b => b.type === 'text')
      .map(b => b.text || '')
      .join('');
  }
  return '';
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
    }
  }

  return {
    id: '',
    type: 'message',
    role: 'assistant',
    content,
    stop_reason: mapFinishReason(candidate?.finishReason),
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
  const state = { started: false, textBlockStarted: false };

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

        // text delta
        const text = (candidate.content?.parts || []).map(p => p.text || '').join('');
        if (text) {
          if (!state.textBlockStarted) {
            state.textBlockStarted = true;
            output += encodeAnthropicEvent('content_block_start', {
              type: 'content_block_start',
              index: 0,
              content_block: { type: 'text', text: '' },
            });
          }
          output += encodeAnthropicEvent('content_block_delta', {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'text_delta', text },
          });
        }

        // finish
        if (candidate.finishReason) {
          if (state.textBlockStarted) {
            output += encodeAnthropicEvent('content_block_stop', {
              type: 'content_block_stop',
              index: 0,
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
    flush() {
      return '';
    },
  };
}

module.exports = { convertRequest, convertResponse, createSSEConverter };
