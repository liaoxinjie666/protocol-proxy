/**
 * Responses API → Chat Completions API 转换器
 *
 * 将 OpenAI Responses API (第三代) 请求转换为 Chat Completions API (第二代) 格式
 */

const { normalizeToolFormat } = require('../adapters/utils');

const ROLE_MAP = { developer: 'system' };

// ─── 请求转换 ───────────────────────────────────────────────

function convertRequest(body, targetModel) {
  const messages = mapInputToMessages(body.input || []);

  // instructions → system 消息
  const instructions = (body.instructions || '').trim();
  if (instructions) {
    messages.unshift({ role: 'system', content: instructions });
  }

  const chatReq = {
    model: targetModel || body.model,
    messages,
    stream: body.stream || false,
  };

  // 可选参数
  if (body.temperature != null) chatReq.temperature = body.temperature;
  if (body.top_p != null) chatReq.top_p = body.top_p;
  if (body.stop != null) chatReq.stop = body.stop;

  // max_output_tokens → max_tokens
  if (body.max_output_tokens != null) {
    chatReq.max_tokens = body.max_output_tokens;
  }

  // tools 标准化
  if (Array.isArray(body.tools) && body.tools.length > 0) {
    chatReq.tools = body.tools
      .map(tool => tool && tool.type === 'image_gen' ? makeImageGenTool(tool) : normalizeToolFormat(tool))
      .filter(t => t.function && t.function.name);
  }

  // tool_choice
  if (body.tool_choice && chatReq.tools) {
    chatReq.tool_choice = body.tool_choice;
  }

  return chatReq;
}

// ─── 输入项 → 消息数组 ──────────────────────────────────────

function mapInputToMessages(inputItems) {
  if (typeof inputItems === 'string') {
    return [{ role: 'user', content: inputItems }];
  }
  if (!Array.isArray(inputItems)) return [];

  const messages = [];
  let pendingToolCalls = [];
  let pendingReasoning = '';

  function flushToolCalls() {
    if (pendingToolCalls.length === 0) return;
    messages.push({
      role: 'assistant',
      content: null,
      tool_calls: pendingToolCalls.slice(),
      reasoning_content: pendingReasoning || 'Tool calls.',
    });
    pendingToolCalls = [];
    pendingReasoning = '';
  }

  for (const item of inputItems) {
    if (!item || typeof item !== 'object') continue;

    switch (item.type) {
      case 'reasoning': {
        // reasoning item → 暂存，附加到下一个 assistant 消息
        const text = extractReasoningText(item);
        if (text) pendingReasoning += (pendingReasoning ? '\n' : '') + text;
        continue;
      }

      case 'function_call_output': {
        flushToolCalls();
        let content = item.output;
        if (Array.isArray(content)) {
          content = content.map(p => p.text || '').join('');
        } else if (typeof content !== 'string') {
          content = String(content);
        }
        messages.push({
          role: 'tool',
          tool_call_id: item.call_id,
          content,
        });
        continue;
      }

      case 'function_call': {
        pendingToolCalls.push({
          id: item.call_id,
          type: 'function',
          function: {
            name: item.name,
            arguments: item.arguments,
          },
        });
        continue;
      }

      default: {
        flushToolCalls();
        const role = ROLE_MAP[item.role] || item.role || 'user';
        const content = normalizeContent(item.content);
        const msg = { role };

        if (content != null) {
          msg.content = content;
        }

        if (item.name) msg.name = item.name;

        // 附加推理内容
        if (role === 'assistant' && pendingReasoning) {
          msg.reasoning_content = pendingReasoning;
          pendingReasoning = '';
        }

        messages.push(msg);
      }
    }
  }

  // 处理尾部未 flush 的 tool_calls
  flushToolCalls();

  // 如果还有未消费的 reasoning，附加到最后一个 assistant 消息
  if (pendingReasoning) {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'assistant') {
        messages[i].reasoning_content = pendingReasoning;
        break;
      }
    }
  }

  return messages;
}

// ─── 辅助函数 ───────────────────────────────────────────────

function extractReasoningText(item) {
  const parts = [];
  if (Array.isArray(item.summary)) {
    for (const s of item.summary) {
      if (s && s.text) parts.push(s.text);
    }
  }
  if (Array.isArray(item.content)) {
    for (const c of item.content) {
      if (c && c.text) parts.push(c.text);
    }
  }
  return parts.join('\n');
}

function normalizeContent(content) {
  if (content == null) return null;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return String(content);

  const parts = [];
  for (const part of content) {
    if (!part || typeof part !== 'object') continue;
    switch (part.type) {
      case 'input_text':
        parts.push({ type: 'text', text: part.text });
        break;
      case 'output_text':
        parts.push({ type: 'text', text: part.text });
        break;
      case 'input_image':
        parts.push({ type: 'image_url', image_url: part.image_url });
        break;
      default:
        parts.push(part);
    }
  }

  if (parts.length === 0) return null;
  if (parts.length === 1 && parts[0].type === 'text') return parts[0].text;
  return parts;
}

function makeImageGenTool(tool) {
  return {
    type: 'function',
    function: {
      name: 'image_gen',
      description: 'Generate a raster image from a detailed text prompt.',
      parameters: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: 'Detailed image generation prompt.' },
          size: { type: 'string', description: 'Image size such as 1024x1024 or 2560x1440.' },
        },
        required: ['prompt'],
      },
    },
    _image_gen: { size: tool.size || '' },
  };
}

module.exports = { convertRequest };
