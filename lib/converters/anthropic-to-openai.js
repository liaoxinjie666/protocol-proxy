/**
 * Anthropic → OpenAI 协议转换
 */

const { encodeAnthropicEvent } = require('./sse-helpers');

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

  // 检查历史消息中是否有 thinking 块或 reasoning_content
  // 如果有，DeepSeek 等模型要求后续所有 assistant 消息都必须包含 reasoning_content
  const hasReasoning = (body.messages || []).some(msg => {
    if (msg.role !== 'assistant') return false;
    if (msg.reasoning_content) return true;
    if (Array.isArray(msg.content)) {
      return msg.content.some(b => b.type === 'thinking');
    }
    return false;
  });

  // 额外检查：如果这是多轮对话（有 tool_use 历史），也强制添加 reasoning_content
  // Anthropic 格式中 tool_use 在 msg.content 数组中，OpenAI 格式在 msg.tool_calls 中
  const hasToolHistory = (body.messages || []).some(msg => {
    if (msg.role !== 'assistant') return false;
    // OpenAI 格式
    if (msg.tool_calls && msg.tool_calls.length > 0) return true;
    // Anthropic 格式（content 数组中有 tool_use 块）
    if (Array.isArray(msg.content)) {
      return msg.content.some(b => b.type === 'tool_use');
    }
    return false;
  });

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
  // 强制 thinking：如果历史中有 thinking 或有 tool 调用历史，都需要 reasoning_content
  const forceThinking = hasReasoning || hasToolHistory;
  for (const msg of (body.messages || [])) {
    const converted = convertMessage(msg, idMap, forceThinking);
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

function convertMessage(msg, idMap, forceThinking = false) {
  if (!msg || !msg.role) return msg;

  // 处理 content 数组
  if (Array.isArray(msg.content)) {
    const textParts = [];
    const thinkingParts = [];
    const toolResults = [];
    const toolUses = [];
    const contentBlocks = [];

    for (const block of msg.content) {
      if (block.type === 'text') {
        textParts.push(block.text);
        contentBlocks.push({ type: 'text', text: block.text });
      } else if (block.type === 'thinking') {
        thinkingParts.push(block.thinking);
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
      } else if (block.type === 'image') {
        if (block.source?.type === 'base64' && block.source.media_type && block.source.data) {
          contentBlocks.push({
            type: 'image_url',
            image_url: { url: `data:${block.source.media_type};base64,${block.source.data}` },
          });
        } else if (block.source?.type === 'url' && block.source.url) {
          contentBlocks.push({
            type: 'image_url',
            image_url: { url: block.source.url },
          });
        }
      } else if (block.type === 'audio') {
        if (block.source?.type === 'base64' && block.source.media_type && block.source.data) {
          const format = block.source.media_type.replace(/^audio\//, '') || 'wav';
          contentBlocks.push({
            type: 'input_audio',
            input_audio: { data: block.source.data, format },
          });
        }
      }
    }

    // assistant 消息含 tool_use → 需要拆分为 assistant + tool
    if (msg.role === 'assistant' && toolUses.length > 0) {
      const assistantMsg = {
        role: 'assistant',
        content: textParts.join('') || '',
        tool_calls: toolUses,
      };
      // 如果有 thinking 或 forceThinking，需要添加 reasoning_content
      const hasThinking = thinkingParts.length > 0 || forceThinking;
      if (hasThinking) {
        assistantMsg.reasoning_content = thinkingParts.join('') || ' ';
      }
      return [assistantMsg];
    }

    // user 消息含 tool_result → 拆分为多个 tool 消息
    // OpenAI 要求 tool 消息紧跟 assistant tool_calls，user text 放在 tool 之后
    if (msg.role === 'user' && toolResults.length > 0) {
      const result = [];
      result.push(...toolResults);
      const remainingBlocks = contentBlocks.filter(b => b.type === 'text' || b.type === 'image_url' || b.type === 'input_audio');
      if (remainingBlocks.length > 0) {
        result.push({ role: 'user', content: remainingBlocks });
      }
      return result;
    }

    // 普通情况：如果存在图片，输出 content 数组
    const hasMedia = contentBlocks.some(b => b.type === 'image_url' || b.type === 'input_audio');
    if (hasMedia) {
      return { role: msg.role, content: contentBlocks };
    }

    const out = { role: msg.role, content: textParts.join('') };
    if (msg.role === 'assistant') {
      const hasThinking = thinkingParts.length > 0 || forceThinking;
      if (hasThinking) {
        out.reasoning_content = thinkingParts.join('') || ' ';
      }
    }
    return out;
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
    textBlockClosed: false,
    textBlockIndex: 0,
    blockIndex: 0,
    toolCalls: new Map(), // index -> { id, name, args, blockIndex }
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
      delta: { type: 'text_delta', text: delta.content },
    });
  }

  // tool_calls
  if (delta.tool_calls && Array.isArray(delta.tool_calls)) {
    // 在首个 tool_call 前关闭 text block
    if (state.textBlockStarted && !state.textBlockClosed) {
      state.textBlockClosed = true;
      output += encodeAnthropicEvent('content_block_stop', {
        type: 'content_block_stop',
        index: state.textBlockIndex,
      });
    }
    for (const tc of delta.tool_calls) {
      const idx = tc.index || 0;
      let tool = state.toolCalls.get(idx);

      if (!tool) {
        // 新的 tool_call
        tool = { id: tc.id, name: tc.function?.name, args: '', blockIndex: state.blockIndex++ };
        state.toolCalls.set(idx, tool);
        output += encodeAnthropicEvent('content_block_start', {
          type: 'content_block_start',
          index: tool.blockIndex,
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
          index: tool.blockIndex,
          delta: { type: 'input_json_delta', partial_json: tc.function.arguments },
        });
      }
    }
  }

  // finish_reason
  if (choice.finish_reason) {
    const stopReason = mapFinishReason(choice.finish_reason);
    if (state.textBlockStarted && !state.textBlockClosed) {
      state.textBlockClosed = true;
      output += encodeAnthropicEvent('content_block_stop', {
        type: 'content_block_stop',
        index: state.textBlockIndex,
      });
    }
    for (const [, tool] of state.toolCalls) {
      output += encodeAnthropicEvent('content_block_stop', {
        type: 'content_block_stop',
        index: tool.blockIndex,
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
