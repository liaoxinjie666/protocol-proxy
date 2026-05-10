/**
 * OpenAI → Gemini 协议转换
 */

const { encodeOpenAIEvent, encodeOpenAIDone } = require('./sse-helpers');

// ==================== 请求转换 ====================

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

    const role = msg.role === 'assistant' ? 'model' : 'user';
    const text = typeof msg.content === 'string' ? msg.content : '';
    contents.push({ role, parts: [{ text }] });
  }

  const result = { contents };

  if (systemInstruction) {
    result.systemInstruction = systemInstruction;
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

  const text = candidate.content?.parts?.map(p => p.text || '').join('') || '';

  return {
    id: '',
    object: 'chat.completion',
    choices: [{
      index: 0,
      message: { role: 'assistant', content: text },
      finish_reason: mapFinishReason(candidate.finishReason),
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

        const text = candidate.content?.parts?.map(p => p.text || '').join('') || '';
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
