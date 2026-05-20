/**
 * 通义千问 (Qwen) 适配器
 *
 * 已知问题:
 * - 不支持 logprobs/logit_bias/user 字段
 * - 流式响应会嵌套在 output.choices 中而非顶层 choices
 * - 有时 tool_calls 嵌入在 content 的 XML 标签中
 */
const {
  normalizeResponseToolCalls,
  normalizeStreamToolCalls,
  extractToolCallsFromContent,
  removeIncompatibleFields,
} = require('./utils');

const QWEN_PATTERNS = [
  {
    regex: /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g,
    parseFn: (raw) => {
      // Qwen 格式: {"name":"...","arguments":{...}}
      // 或 functionName({...})
      try {
        return JSON.parse(raw);
      } catch {
        const m = raw.match(/(\w+)\s*\((.*)\)/s);
        if (m) return { name: m[1], arguments: JSON.parse(m[2]) };
        throw new Error('unparseable');
      }
    },
  },
];

function preprocessRequestBody(body) {
  removeIncompatibleFields(body, ['logprobs', 'logit_bias', 'user']);
}

function postprocessResponseBody(body) {
  if (!body || !body.choices) return body;

  for (const choice of body.choices) {
    const msg = choice.message;
    if (!msg) continue;

    // 尝试从 content 提取嵌入的 tool_calls
    if (msg.content && typeof msg.content === 'string' && !msg.tool_calls) {
      const { cleanedContent, toolCalls } = extractToolCallsFromContent(
        msg.content,
        QWEN_PATTERNS
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

      // Qwen 特有: 流式数据嵌套在 output.choices 中
      if (data.output && data.output.choices && !data.choices) {
        data.choices = data.output.choices;
      }

      normalizeStreamToolCalls(data);
      result.push(`data: ${JSON.stringify(data)}`);
    } catch {
      result.push(line);
    }
  }

  return result.join('\n');
}

module.exports = { preprocessRequestBody, postprocessResponseBody, transformStreamChunk };
