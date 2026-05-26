/**
 * Gemini → OpenAI 协议转换
 */

const { encodeOpenAIEvent, encodeOpenAIDone } = require('./sse-helpers');

function generateCallId() {
  return 'call_' + Math.random().toString(36).slice(2, 14);
}

// ==================== 请求转换 ====================

function convertRequest(body, targetModel) {
  const messages = [];
  // 追踪 Gemini 函数名 → 生成的 tool_call id，用于后续 tool_result 转换
  const nameToId = new Map();
  const nameCount = new Map();

  // system_instruction → system message
  const sysText = body.systemInstruction?.parts?.map(p => p.text || '').join('') || '';
  if (sysText) {
    messages.push({ role: 'system', content: sysText });
  }

  // tools: functionDeclarations → OpenAI tools
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
        type: 'function',
        function: {
          name: fd.name,
          description: fd.description || '',
          parameters: fd.parameters || { type: 'object', properties: {} },
        },
      }));
    }
  }

  // contents → messages, functionCall/functionResponse → tool_calls/tool results
  for (const msg of (body.contents || [])) {
    const role = msg.role === 'model' ? 'assistant' : 'user';
    const parts = msg.parts || [];

    // 检查是否有 functionCall
    const functionCalls = parts.filter(p => p.functionCall);
    if (functionCalls.length > 0) {
      const text = parts.filter(p => p.text).map(p => p.text).join('');
      const tool_calls = functionCalls.map(fc => {
        const fnName = fc.functionCall.name || 'unknown';
        const count = nameCount.get(fnName) || 0;
        nameCount.set(fnName, count + 1);
        const callId = generateCallId();
        nameToId.set(fnName + '#' + count, callId);
        return {
          id: callId,
          type: 'function',
          function: { name: fnName, arguments: JSON.stringify(fc.functionCall.args || {}) },
        };
      });
      messages.push({ role: 'assistant', content: text || null, tool_calls });
      continue;
    }

    // 检查是否有 functionResponse → tool messages
    const functionResponses = parts.filter(p => p.functionResponse);
    const respCount = new Map();
    for (const fr of functionResponses) {
      const fnName = fr.functionResponse.name || 'unknown';
      const count = respCount.get(fnName) || 0;
      respCount.set(fnName, count + 1);
      const toolCallId = nameToId.get(fnName + '#' + count) || fnName;
      messages.push({
        role: 'tool',
        tool_call_id: toolCallId,
        content: typeof fr.functionResponse.response === 'string'
          ? fr.functionResponse.response
          : JSON.stringify(fr.functionResponse.response || {}),
      });
    }

    // 纯文本/图片/音频 part（跳过已处理 functionCall/functionResponse 的消息）
    if (functionCalls.length === 0 && functionResponses.length === 0) {
      const hasMedia = parts.some(p => p.inlineData);
      if (hasMedia) {
        const content = [];
        for (const p of parts) {
          if (p.text) content.push({ type: 'text', text: p.text });
          if (p.inlineData) {
            if (isImageMimeType(p.inlineData.mimeType)) {
              content.push({
                type: 'image_url',
                image_url: { url: `data:${p.inlineData.mimeType};base64,${p.inlineData.data}` },
              });
            } else if (isAudioMimeType(p.inlineData.mimeType)) {
              const format = p.inlineData.mimeType.replace(/^audio\//, '') || 'wav';
              content.push({
                type: 'input_audio',
                input_audio: { data: p.inlineData.data, format },
              });
            }
          }
        }
        if (content.length > 0) {
          messages.push({ role, content });
        }
      } else {
        const textParts = parts.filter(p => p.text).map(p => p.text).join('');
        if (textParts) {
          messages.push({ role, content: textParts });
        }
      }
    }
  }

  const result = {
    model: targetModel,
    messages,
    stream: false,
  };

  if (tools) result.tools = tools;

  // generationConfig → OpenAI params
  const gc = body.generationConfig || {};
  if (gc.maxOutputTokens !== undefined) result.max_tokens = gc.maxOutputTokens;
  if (gc.temperature !== undefined) result.temperature = gc.temperature;
  if (gc.topP !== undefined) result.top_p = gc.topP;
  if (gc.stopSequences) result.stop = gc.stopSequences;

  return { ...result, nameToId };
}

// ==================== 响应转换 ====================

function convertResponse(geminiBody) {
  const candidate = geminiBody.candidates?.[0];
  if (!candidate) {
    return { id: '', object: 'chat.completion', choices: [], usage: convertUsage(geminiBody.usageMetadata) };
  }

  const parts = candidate.content?.parts || [];
  const textParts = [];
  const toolCalls = [];

  for (const part of parts) {
    if (part.text) textParts.push(part.text);
    if (part.functionCall) {
      toolCalls.push({
        id: generateCallId(),
        type: 'function',
        function: { name: part.functionCall.name, arguments: JSON.stringify(part.functionCall.args || {}) },
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

function isImageMimeType(mimeType) {
  return typeof mimeType === 'string' && mimeType.startsWith('image/');
}

function isAudioMimeType(mimeType) {
  return typeof mimeType === 'string' && mimeType.startsWith('audio/');
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
  const state = { started: false, sentFunctionCallPositions: new Set(), buffer: '' };

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

        const parts = candidate.content?.parts || [];

        // 首个 chunk 发送 role
        if (!state.started && (parts.length > 0)) {
          state.started = true;
          output += encodeOpenAIEvent({
            id: '',
            object: 'chat.completion.chunk',
            choices: [{ index: 0, delta: { role: 'assistant', content: null }, finish_reason: null }],
          });
        }

        // 文本增量
        const text = parts.filter(p => p.text).map(p => p.text).join('') || '';
        if (text) {
          output += encodeOpenAIEvent({
            id: '',
            object: 'chat.completion.chunk',
            choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
          });
        }

        // functionCall 增量（按位置去重，Gemini 每个 chunk 发送完整 parts）
        let funcIndex = 0;
        for (const part of parts) {
          if (!part.functionCall) { funcIndex++; continue; }
          const pos = funcIndex++;
          if (state.sentFunctionCallPositions.has(pos)) continue;
          state.sentFunctionCallPositions.add(pos);
          const callId = generateCallId();
          const tcIndex = state.sentFunctionCallPositions.size - 1;
          output += encodeOpenAIEvent({
            id: '',
            object: 'chat.completion.chunk',
            choices: [{
              index: 0,
              delta: {
                tool_calls: [{
                  index: tcIndex,
                  id: callId,
                  type: 'function',
                  function: { name: part.functionCall.name, arguments: JSON.stringify(part.functionCall.args || {}) },
                }],
              },
              finish_reason: null,
            }],
          });
        }

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
    flush() { return ''; },
  };
}

module.exports = { convertRequest, convertResponse, createSSEConverter };
