/**
 * Gemini → Anthropic 协议转换
 */

const { encodeAnthropicEvent } = require('./sse-helpers');

// ==================== 请求转换 ====================

function convertRequest(body, targetModel) {
  const contents = [];
  let systemInstruction = null;

  // system_instruction → system 顶级字段
  const sysText = body.systemInstruction?.parts?.map(p => p.text || '').join('') || '';
  if (sysText) {
    // Gemini 没有 system 顶级字段，放在第一个 user 消息前面
    // 但 Gemini API 确实支持 systemInstruction，所以直接传
    systemInstruction = sysText;
  }

  // contents → messages
  for (const msg of (body.contents || [])) {
    const role = msg.role === 'model' ? 'assistant' : 'user';
    const text = (msg.parts || []).map(p => p.text || '').join('');
    if (text) {
      contents.push({ role, content: text });
    }
  }

  const result = {
    model: targetModel,
    max_tokens: body.generationConfig?.maxOutputTokens || 4096,
    messages: contents,
  };

  if (systemInstruction) {
    result.system = systemInstruction;
  }

  if (body.generationConfig?.temperature !== undefined) {
    result.temperature = body.generationConfig.temperature;
  }
  if (body.generationConfig?.topP !== undefined) {
    result.top_p = body.generationConfig.topP;
  }
  if (body.generationConfig?.stopSequences) {
    result.stop_sequences = body.generationConfig.stopSequences;
  }

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
