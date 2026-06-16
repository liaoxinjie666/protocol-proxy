/**
 * Kimi (月之暗面) 适配器
 *
 * 已知问题:
 * - 不支持 logprobs/logit_bias/user 字段
 * - k2.x 默认开启 thinking 模式，k2.7code 只接受 type=enabled
 * - 有时 tool_calls 嵌入在 content 的 XML/JSON 标签中
 */
const {
  normalizeResponseToolCalls,
  normalizeStreamToolCalls,
  extractToolCallsFromContent,
  removeIncompatibleFields,
} = require('./utils');

const KIMI_PATTERNS = [
  {
    // <function_call>{"name":"...","arguments":{...}}</function_call>
    regex: /<function_call>\s*([\s\S]*?)\s*<\/function_call>/g,
    parseFn: (raw) => JSON.parse(raw),
  },
  {
    // JSON in markdown code fences
    regex: /```json\s*(\{[\s\S]*?"name"[\s\S]*?\})\s*```/g,
    parseFn: (raw) => JSON.parse(raw),
  },
];

function preprocessRequestBody(body) {
  removeIncompatibleFields(body, ['logprobs', 'logit_bias', 'user']);

  // k2.7code 及后续 k2.x 模型只接受 thinking.type=enabled
  // 客户端（如 opencode）可能发送 thinking.type=disabled 或其他值，需要纠正
  if (body.thinking && body.thinking.type !== 'enabled') {
    const model = (body.model || '').toLowerCase();
    if (model.includes('k2')) {
      body.thinking = { type: 'enabled' };
    } else {
      // 非 k2 系列模型：删除 thinking 字段，让 API 使用默认行为
      delete body.thinking;
    }
  }
}

function postprocessResponseBody(body) {
  if (!body || !body.choices) return body;

  for (const choice of body.choices) {
    const msg = choice.message;
    if (!msg) continue;

    // 只在没有 tool_calls 时尝试从 content 提取
    if (msg.content && typeof msg.content === 'string' && !msg.tool_calls) {
      const { cleanedContent, toolCalls } = extractToolCallsFromContent(
        msg.content,
        KIMI_PATTERNS
      );
      if (toolCalls.length > 0) {
        msg.tool_calls = toolCalls;
        msg.content = cleanedContent || null;
      }
    }
  }

  return normalizeResponseToolCalls(body);
}

function transformStreamChunk(chunkStr) {
  if (!chunkStr) return chunkStr;

  const lines = chunkStr.split('\n');
  const result = [];

  for (const line of lines) {
    if (!line.startsWith('data: ')) {
      result.push(line);
      continue;
    }

    const dataStr = line.slice(6).trim();
    if (dataStr === '[DONE]') {
      result.push(line);
      continue;
    }

    try {
      const data = JSON.parse(dataStr);
      normalizeStreamToolCalls(data);
      result.push(`data: ${JSON.stringify(data)}`);
    } catch {
      result.push(line);
    }
  }

  return result.join('\n');
}

module.exports = { preprocessRequestBody, postprocessResponseBody, transformStreamChunk };