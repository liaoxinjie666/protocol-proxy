/**
 * OpenAI → Anthropic 协议转换
 */

const { encodeAnthropicEvent } = require('./sse-helpers');

// ==================== 请求转换 ====================

function convertRequest(body, targetModel) {
  const result = {
    model: targetModel,
    max_tokens: body.max_tokens || 4096,
    stream: body.stream || false,
  };

  if (body.temperature !== undefined) result.temperature = body.temperature;
  if (body.top_p !== undefined) result.top_p = body.top_p;
  if (body.stop !== undefined) result.stop_sequences = Array.isArray(body.stop) ? body.stop : [body.stop];

  // 处理 messages 和 system
  const systemMessages = [];
  const otherMessages = [];

  for (const msg of (body.messages || [])) {
    if (msg.role === 'system') {
      systemMessages.push(typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content));
    } else {
      otherMessages.push(msg);
    }
  }

  if (systemMessages.length > 0) {
    result.system = systemMessages.join('\n\n');
  }

  // 转换消息角色和内容
  result.messages = otherMessages.map(msg => convertMessage(msg));

  // 转换 tools / functions
  if (body.tools && Array.isArray(body.tools)) {
    result.tools = body.tools.map(t => convertTool(t));
  } else if (body.functions && Array.isArray(body.functions)) {
    // 旧版 functions 转 tools
    result.tools = body.functions.map(f => ({
      name: f.name,
      description: f.description,
      input_schema: f.parameters || { type: 'object', properties: {} },
    }));
  }

  // 转换 tool_choice
  if (body.tool_choice) {
    result.tool_choice = convertToolChoice(body.tool_choice);
  }

  return result;
}

function convertContentBlock(block) {
  if (block.type === 'text') {
    return { type: 'text', text: block.text || '' };
  }
  if (block.type === 'image_url' && block.image_url?.url) {
    const url = block.image_url.url;
    if (url.startsWith('data:')) {
      const match = url.match(/^data:([^;]+);base64,(.+)$/);
      if (match) {
        return { type: 'image', source: { type: 'base64', media_type: match[1], data: match[2] } };
      }
    }
    return { type: 'image', source: { type: 'url', url } };
  }
  return null;
}

function convertMessage(msg) {
  if (msg.role === 'tool') {
    // OpenAI tool result → Anthropic tool_result content block
    return {
      role: 'user',
      content: [{
        type: 'tool_result',
        tool_use_id: msg.tool_call_id,
        content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content),
      }],
    };
  }

  if (msg.role === 'assistant' && msg.tool_calls) {
    // assistant message with tool_calls → assistant with tool_use blocks
    const content = [];
    if (msg.reasoning_content) {
      content.push({ type: 'thinking', thinking: msg.reasoning_content });
    }
    if (msg.content) {
      content.push({ type: 'text', text: msg.content });
    }
    for (const tc of msg.tool_calls) {
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
    return { role: 'assistant', content };
  }

  // 普通消息 — content 为数组时逐块转换
  if (Array.isArray(msg.content)) {
    const content = msg.content.map(convertContentBlock).filter(Boolean);
    if (msg.role === 'assistant' && msg.reasoning_content) {
      content.unshift({ type: 'thinking', thinking: msg.reasoning_content });
    }
    return { role: msg.role, content };
  }

  // assistant 消息带 reasoning_content
  if (msg.role === 'assistant' && msg.reasoning_content) {
    return {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: msg.reasoning_content },
        { type: 'text', text: typeof msg.content === 'string' ? msg.content : '' },
      ],
    };
  }

  return {
    role: msg.role,
    content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content),
  };
}

function convertTool(tool) {
  return {
    name: tool.function?.name || tool.name,
    description: tool.function?.description || tool.description,
    input_schema: tool.function?.parameters || tool.input_schema || { type: 'object', properties: {} },
  };
}

function convertToolChoice(tc) {
  if (tc === 'auto') return { type: 'auto' };
  if (tc === 'none') return { type: 'none' };
  if (tc === 'required') return { type: 'any' };
  if (typeof tc === 'object' && tc.type === 'function') {
    return { type: 'tool', name: tc.function?.name };
  }
  return { type: 'auto' };
}

// ==================== 响应转换 ====================

function convertResponse(anthropicBody) {
  const choice = {
    index: 0,
    message: {
      role: 'assistant',
      content: '',
    },
    finish_reason: null,
  };

  // 提取文本内容和 tool_calls
  const toolCalls = [];
  const textParts = [];

  for (const block of (anthropicBody.content || [])) {
    if (block.type === 'text') {
      textParts.push(block.text);
    } else if (block.type === 'tool_use') {
      toolCalls.push({
        id: block.id,
        type: 'function',
        function: {
          name: block.name,
          arguments: JSON.stringify(block.input || {}),
        },
      });
    }
  }

  choice.message.content = textParts.join('');
  if (toolCalls.length > 0) {
    choice.message.tool_calls = toolCalls;
  }

  // 映射 stop_reason
  choice.finish_reason = mapStopReason(anthropicBody.stop_reason);

  return {
    id: anthropicBody.id,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: anthropicBody.model,
    choices: [choice],
    usage: anthropicBody.usage ? {
      prompt_tokens: anthropicBody.usage.input_tokens,
      completion_tokens: anthropicBody.usage.output_tokens,
      total_tokens: (anthropicBody.usage.input_tokens || 0) + (anthropicBody.usage.output_tokens || 0),
    } : undefined,
  };
}

function mapStopReason(reason) {
  if (!reason) return null;
  if (reason === 'end_turn') return 'stop';
  if (reason === 'max_tokens') return 'length';
  if (reason === 'tool_use') return 'tool_calls';
  if (reason === 'stop_sequence') return 'stop';
  return reason;
}

// ==================== SSE 流式转换 ====================

function createSSEConverter(targetModel) {
  const state = {
    messageId: null,
    blockType: null,
    blockIndex: 0,
    toolUseId: null,
    toolName: null,
    toolCallIndex: -1,
    sentRole: false,
    sentToolInit: false,
    buffer: '',
  };

  return {
    convertChunk(chunkText) {
      let output = '';
      state.buffer += chunkText;
      const lines = state.buffer.split('\n');
      state.buffer = lines.pop() || ''; // 保留不完整的最后一行

      for (const line of lines) {
        const converted = processLine(line.trim(), state, targetModel);
        if (converted) output += converted;
      }

      return output;
    },
    flush() {
      // 结束时不发送额外内容，[DONE] 在 finish_reason 时已经发送
      return '';
    },
  };
}

function processLine(line, state, targetModel) {
  if (!line.startsWith('data:')) return '';
  const dataStr = line.slice(5).trim();
  if (dataStr === '[DONE]') return '';

  let event;
  try {
    event = JSON.parse(dataStr);
  } catch {
    return '';
  }

  if (!event || !event.type) return '';

  switch (event.type) {
    case 'message_start': {
      state.messageId = event.message?.id;
      state.sentRole = false;
      return '';
    }

    case 'content_block_start': {
      state.blockType = event.content_block?.type;
      state.blockIndex = event.index;
      state.sentToolInit = false;

      if (state.blockType === 'tool_use') {
        state.toolUseId = event.content_block.id;
        state.toolName = event.content_block.name;
        state.toolCallIndex = (state.toolCallIndex || 0) + 1;
      }
      return '';
    }

    case 'content_block_delta': {
      const delta = event.delta;
      if (!delta) return '';

      // 发送 role（如果是第一个内容块）
      let prefix = '';
      if (!state.sentRole) {
        prefix = encodeOpenAIChunk(state.messageId, targetModel, { role: 'assistant' });
        state.sentRole = true;
      }

      if (delta.type === 'text_delta' && delta.text) {
        return prefix + encodeOpenAIChunk(state.messageId, targetModel, { content: delta.text });
      }

      if (delta.type === 'input_json_delta' && delta.partial_json !== undefined) {
        if (!state.sentToolInit) {
          state.sentToolInit = true;
          const toolCallChunk = {
            tool_calls: [{
              index: state.toolCallIndex,
              id: state.toolUseId,
              type: 'function',
              function: { name: state.toolName, arguments: delta.partial_json },
            }],
          };
          return prefix + encodeOpenAIChunk(state.messageId, targetModel, toolCallChunk);
        }
        return prefix + encodeOpenAIChunk(state.messageId, targetModel, {
          tool_calls: [{ index: state.toolCallIndex, function: { arguments: delta.partial_json } }],
        });
      }

      return prefix;
    }

    case 'content_block_stop': {
      state.blockType = null;
      return '';
    }

    case 'message_delta': {
      const stopReason = event.delta?.stop_reason;
      if (stopReason) {
        return encodeOpenAIChunk(state.messageId, targetModel, {}, mapStopReason(stopReason));
      }
      return '';
    }

    case 'message_stop': {
      return 'data: [DONE]\n\n';
    }

    default:
      return '';
  }
}

function encodeOpenAIChunk(id, model, delta, finishReason = null) {
  const chunk = {
    id: id || 'chatcmpl-proxy',
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: model || 'proxy-model',
    choices: [{
      index: 0,
      delta,
      finish_reason: finishReason,
    }],
  };
  return `data: ${JSON.stringify(chunk)}\n\n`;
}

module.exports = {
  convertRequest,
  convertResponse,
  createSSEConverter,
};
