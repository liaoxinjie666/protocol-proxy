/**
 * Gemini → OpenAI 协议转换
 */

const { encodeOpenAIEvent, encodeOpenAIDone } = require('./sse-helpers');

// ==================== 请求转换 ====================

function convertRequest(body, targetModel) {
  const messages = [];

  // system_instruction → system message
  const sysText = body.systemInstruction?.parts?.map(p => p.text || '').join('') || '';
  if (sysText) {
    messages.push({ role: 'system', content: sysText });
  }

  // contents → messages
  for (const msg of (body.contents || [])) {
    const role = msg.role === 'model' ? 'assistant' : 'user';
    const text = (msg.parts || []).map(p => p.text || '').join('');
    messages.push({ role, content: text });
  }

  const result = {
    model: targetModel,
    messages,
    stream: false,
  };

  // generationConfig → OpenAI params
  const gc = body.generationConfig || {};
  if (gc.maxOutputTokens !== undefined) result.max_tokens = gc.maxOutputTokens;
  if (gc.temperature !== undefined) result.temperature = gc.temperature;
  if (gc.topP !== undefined) result.top_p = gc.topP;
  if (gc.stopSequences) result.stop = gc.stopSequences;

  return result;
}

// ==================== 响应转换 ====================

function convertResponse(geminiBody) {
  const candidate = geminiBody.candidates?.[0];
  if (!candidate) {
    return {
      id: '',
      object: 'chat.completion',
      choices: [],
      usage: convertUsage(geminiBody.usageMetadata),
    };
  }

  const text = (candidate.content?.parts || []).map(p => p.text || '').join('');

  return {
    id: '',
    object: 'chat.completion',
    choices: [{
      index: 0,
      message: { role: 'assistant', content: text },
      finish_reason: mapFinishReason(candidate.finishReason),
    }],
    usage: convertUsage(geminiBody.usageMetadata),
  };
}

function convertUsage(meta) {
  return {
    prompt_tokens: meta?.promptTokenCount || 0,
    completion_tokens: meta?.candidatesTokenCount || 0,
    total_tokens: meta?.totalTokenCount || 0,
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

        const text = (candidate.content?.parts || []).map(p => p.text || '').join('');
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

        if (candidate.finishReason) {
          output += encodeOpenAIEvent({
            id: '',
            object: 'chat.completion.chunk',
            choices: [{
              index: 0,
              delta: {},
              finish_reason: mapFinishReason(candidate.finishReason),
            }],
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
