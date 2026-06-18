/**
 * OpenAI → Anthropic 协议转换
 */

const { encodeAnthropicEvent } = require('./sse-helpers');

// ==================== 请求转换 ====================

function convertRequest(body, targetModel, options = {}) {
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
  // DeepSeek 等使用 reasoning_content 的模型要求：如果历史消息中有 thinking，
  // 后续的 assistant 消息必须也回传 thinking（即使该消息本身没有 reasoning_content）
  const reasoningCache = options.reasoningCache;
  const hasReasoning = otherMessages.some(m => m.reasoning_content);
  result.messages = otherMessages.map(msg => convertMessage(msg, hasReasoning, reasoningCache));

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
  if (block.type === 'image_url') {
    // 兼容两种 chat 格式：image_url 为字符串（"data:..."）或对象（{url: "..."}）
    const url = typeof block.image_url === 'string' ? block.image_url : block.image_url?.url;
    if (url) {
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
  if (block.type === 'input_audio' && block.input_audio?.data) {
    const format = block.input_audio.format || 'wav';
    return { type: 'audio', source: { type: 'base64', media_type: `audio/${format}`, data: block.input_audio.data } };
  }
  return null;
}

// 构造 anthropic thinking block。
// 「同源直通，跨源降级」原则：
// - 入参是 thinking block 数组（来自 anthropic 上游响应缓存）且块带 signature → 原样保留（同源有效）
// - 入参是纯字符串 reasoning_content（来自 OpenAI/Responses 协议，无 signature）→ 不生成 thinking block
//   原因：anthropic 服务端要求多轮回传的 thinking block 必须带有效 signature，否则报 400
//   导致 agentic 任务中断。跨厂商时 signature 本就无法获取，宁可不回传 thinking，也不发无效块。
function makeThinkingBlock(reasoning) {
  // 同源：anthropic thinking block 数组（缓存里带 signature 的完整块）
  if (Array.isArray(reasoning)) {
    const validBlocks = reasoning
      .filter(b => b && (b.thinking || b.text) && b.signature)
      .map(b => ({ type: 'thinking', thinking: b.thinking || b.text, signature: b.signature }));
    if (validBlocks.length > 0) return validBlocks;
    // 数组里没有带 signature 的块 → 跨源降级，不回传
    return null;
  }
  // 字符串 reasoning_content：跨源，无 signature，不生成 thinking block
  return null;
}

function convertMessage(msg, forceThinking = false, reasoningCache = null) {
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

  // 确定需要添加 thinking 块：消息自身有 reasoning_content 或 forceThinking
  const needThinking = msg.role === 'assistant' && (msg.reasoning_content || forceThinking);
  // 获取 reasoning 内容：优先使用消息中的，否则从缓存获取（通过 content 匹配）
  let reasoningContent = msg.reasoning_content;
  if (!reasoningContent && forceThinking && reasoningCache) {
    reasoningContent = reasoningCache.get(msg.content) || reasoningCache.get(msg.content?.slice(0, 100));
  }

  if (msg.role === 'assistant' && msg.tool_calls) {
    const content = [];
    if (needThinking) {
      const blocks = makeThinkingBlock(reasoningContent);
      if (blocks) content.push(...(Array.isArray(blocks) ? blocks : [blocks]));
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
    if (needThinking) {
      const blocks = makeThinkingBlock(reasoningContent);
      if (blocks) content.unshift(...(Array.isArray(blocks) ? blocks : [blocks]));
    }
    return { role: msg.role, content };
  }

  // assistant 消息
  if (msg.role === 'assistant') {
    const content = [];
    if (needThinking) {
      const blocks = makeThinkingBlock(reasoningContent);
      if (blocks) content.push(...(Array.isArray(blocks) ? blocks : [blocks]));
    }
    content.push({ type: 'text', text: typeof msg.content === 'string' ? msg.content : '' });
    return { role: 'assistant', content };
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

  // 提取文本内容、tool_calls 和 thinking 块
  const toolCalls = [];
  const textParts = [];
  const thinkingParts = [];

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
    } else if (block.type === 'thinking') {
      thinkingParts.push(block.thinking || '');
    }
  }

  choice.message.content = textParts.join('');
  if (toolCalls.length > 0) {
    choice.message.tool_calls = toolCalls;
  }
  if (thinkingParts.length > 0) {
    choice.message.reasoning_content = thinkingParts.join('');
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

      if (delta.type === 'thinking_delta' && delta.thinking) {
        return prefix + encodeOpenAIChunk(state.messageId, targetModel, { reasoning_content: delta.thinking });
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
