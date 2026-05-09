/**
 * Anthropic → OpenAI 协议转换
 */

const { encodeOpenAIEvent, encodeOpenAIDone, encodeAnthropicEvent } = require('./sse-helpers');

// ==================== 请求转换 ====================

function generateCallId() {
  return 'call_' + Math.random().toString(36).slice(2, 11) + Math.random().toString(36).slice(2, 11);
}

function convertRequest(body, targetModel) {
  const result = {
    model: targetModel,
    max_tokens: body.max_tokens || 4096,
    stream: body.stream || false,
  };

  if (body.temperature !== undefined) result.temperature = body.temperature;
  if (body.top_p !== undefined) result.top_p = body.top_p;
  if (body.stop_sequences !== undefined) result.stop = body.stop_sequences;

  // 构建 tool_use_id 映射表（Anthropic id -> OpenAI id）
  const idMap = new Map();
  for (const msg of (body.messages || [])) {
    if (msg.role === 'assistant' && Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === 'tool_use' && block.id && !idMap.has(block.id)) {
          idMap.set(block.id, generateCallId());
        }
      }
    }
  }

  // 构建 messages 数组
  const messages = [];

  // system 转为 messages 中的 system 角色
  if (body.system) {
    const systemContent = typeof body.system === 'string'
      ? body.system
      : body.system.map(s => s.text || s).join('\n');
    messages.push({ role: 'system', content: systemContent });
  }

  // 转换其他消息
  for (const msg of (body.messages || [])) {
    const converted = convertMessage(msg, idMap);
    if (Array.isArray(converted)) {
      messages.push(...converted);
    } else {
      messages.push(converted);
    }
  }

  result.messages = messages;

  // 转换 tools
  if (body.tools && Array.isArray(body.tools)) {
    result.tools = body.tools.map(t => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description,
        parameters: t.input_schema || { type: 'object', properties: {} },
      },
    }));
  }

  // 转换 tool_choice
  if (body.tool_choice) {
    result.tool_choice = convertToolChoice(body.tool_choice);
  }

  return result;
}

function convertMessage(msg, idMap) {
  if (!msg || !msg.role) return msg;

  // 处理 content 数组
  if (Array.isArray(msg.content)) {
    const textParts = [];
    const toolResults = [];
    const toolUses = [];

    for (const block of msg.content) {
      if (block.type === 'text') {
        textParts.push(block.text);
      } else if (block.type === 'tool_result') {
        // 使用映射后的 OpenAI 格式 id
        const openaiId = idMap?.get(block.tool_use_id) || block.tool_use_id;
        toolResults.push({
          role: 'tool',
          tool_call_id: openaiId,
          content: typeof block.content === 'string' ? block.content : JSON.stringify(block.content),
        });
      } else if (block.type === 'tool_use') {
        // 使用映射后的 OpenAI 格式 id
        const openaiId = idMap?.get(block.id) || block.id;
        toolUses.push({
          id: openaiId,
          type: 'function',
          function: {
            name: block.name,
            arguments: JSON.stringify(block.input || {}),
          },
        });
      }
    }

    // assistant 消息含 tool_use → 需要拆分为 assistant + tool
    if (msg.role === 'assistant' && toolUses.length > 0) {
      const result = [];
      result.push({
        role: 'assistant',
        content: textParts.join('') || '',
        tool_calls: toolUses,
      });
      return result;
    }

    // user 消息含 tool_result → 拆分为多个 tool 消息
    if (msg.role === 'user' && toolResults.length > 0) {
      const result = [];
      // OpenAI 要求 tool 消息紧跟 assistant，user text 如果有的话应该放在 tool 之前
      // 但通常 tool_result 消息不会有额外的 user text
      if (textParts.length > 0) {
        result.push({ role: 'user', content: textParts.join('') });
      }
      result.push(...toolResults);
      return result;
    }

    // 普通情况
    return { role: msg.role, content: textParts.join('') };
  }

  return { role: msg.role, content: msg.content };
}

function convertToolChoice(tc) {
  if (typeof tc === 'string') {
    if (tc === 'auto') return 'auto';
    if (tc === 'none') return 'none';
    if (tc === 'any') return 'required';
    return 'auto';
  }
  if (tc.type === 'auto') return 'auto';
  if (tc.type === 'none') return 'none';
  if (tc.type === 'any') return 'required';
  if (tc.type === 'tool') {
    return { type: 'function', function: { name: tc.name } };
  }
  return 'auto';
}

// ==================== 响应转换 ====================

function convertResponse(openaiBody) {
  const choice = openaiBody.choices?.[0];
  if (!choice) {
    return { id: openaiBody.id, type: 'message', role: 'assistant', content: [] };
  }

  const content = [];
  const message = choice.message || {};

  // 文本内容
  if (message.content) {
    content.push({ type: 'text', text: message.content });
  }

  // tool_calls → tool_use
  if (message.tool_calls) {
    for (const tc of message.tool_calls) {
      let input = {};
      try {
        input = tc.function?.arguments ? JSON.parse(tc.function.arguments) : {};
      } catch {
        input = {};
      }
      content.push({
        type: 'tool_use',
        id: tc.id,
        name: tc.function?.name,
        input,
      });
    }
  }

  return {
    id: openaiBody.id,
    type: 'message',
    role: 'assistant',
    content,
    stop_reason: mapFinishReason(choice.finish_reason),
    usage: openaiBody.usage ? {
      input_tokens: openaiBody.usage.prompt_tokens,
      output_tokens: openaiBody.usage.completion_tokens,
    } : undefined,
  };
}

function mapFinishReason(reason) {
  if (!reason) return null;
  if (reason === 'stop') return 'end_turn';
  if (reason === 'length') return 'max_tokens';
  if (reason === 'tool_calls') return 'tool_use';
  if (reason === 'content_filter') return 'end_turn';
  return reason;
}

// ==================== SSE 流式转换 ====================

function createSSEConverter(targetModel) {
  const state = {
    messageId: null,
    started: false,
    textBlockStarted: false,
    toolCalls: new Map(), // index -> { id, name, args }
    buffer: '',
  };

  return {
    convertChunk(chunkText) {
      let output = '';
      state.buffer += chunkText;
      const lines = state.buffer.split('\n');
      state.buffer = lines.pop() || '';

      for (const line of lines) {
        const converted = processLine(line.trim(), state, targetModel);
        if (converted) output += converted;
      }

      return output;
    },
    flush() {
      let output = '';
      if (state.started) {
        // 确保发送 message_stop
        output += encodeAnthropicEvent('message_stop', { type: 'message_stop' });
      }
      return output;
    },
  };
}

function processLine(line, state, targetModel) {
  if (!line.startsWith('data:')) return '';
  const dataStr = line.slice(5).trim();
  if (dataStr === '[DONE]') {
    return encodeAnthropicEvent('message_stop', { type: 'message_stop' });
  }

  let chunk;
  try {
    chunk = JSON.parse(dataStr);
  } catch {
    return '';
  }

  if (!chunk || !chunk.choices) return '';

  const choice = chunk.choices[0];
  if (!choice) return '';

  const delta = choice.delta || {};
  let output = '';

  // 第一个有 role 的 chunk → message_start
  if (delta.role && !state.started) {
    state.started = true;
    state.messageId = chunk.id;
    output += encodeAnthropicEvent('message_start', {
      type: 'message_start',
      message: {
        id: chunk.id,
        type: 'message',
        role: 'assistant',
        model: targetModel,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    });
  }

  // 文本内容
  if (delta.content !== undefined && delta.content !== null) {
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
      delta: { type: 'text_delta', text: delta.content },
    });
  }

  // tool_calls
  if (delta.tool_calls && Array.isArray(delta.tool_calls)) {
    for (const tc of delta.tool_calls) {
      const idx = tc.index || 0;
      let tool = state.toolCalls.get(idx);

      if (!tool) {
        // 新的 tool_call
        tool = { id: tc.id, name: tc.function?.name, args: '' };
        state.toolCalls.set(idx, tool);
        output += encodeAnthropicEvent('content_block_start', {
          type: 'content_block_start',
          index: idx + 1, // text block 占 index 0
          content_block: {
            type: 'tool_use',
            id: tc.id,
            name: tc.function?.name,
            input: {},
          },
        });
      }

      if (tc.function?.arguments) {
        tool.args += tc.function.arguments;
        output += encodeAnthropicEvent('content_block_delta', {
          type: 'content_block_delta',
          index: idx + 1,
          delta: { type: 'input_json_delta', partial_json: tc.function.arguments },
        });
      }
    }
  }

  // finish_reason
  if (choice.finish_reason) {
    const stopReason = mapFinishReason(choice.finish_reason);
    if (state.textBlockStarted) {
      output += encodeAnthropicEvent('content_block_stop', {
        type: 'content_block_stop',
        index: 0,
      });
    }
    for (let i = 0; i < state.toolCalls.size; i++) {
      output += encodeAnthropicEvent('content_block_stop', {
        type: 'content_block_stop',
        index: i + 1,
      });
    }
    output += encodeAnthropicEvent('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage: { output_tokens: 0 },
    });
    output += encodeAnthropicEvent('message_stop', { type: 'message_stop' });
  }

  return output;
}

module.exports = {
  convertRequest,
  convertResponse,
  createSSEConverter,
};
