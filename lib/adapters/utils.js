/**
 * Provider 适配器工具函数
 */

/**
 * 标准化 tool 格式为 OpenAI 规范:
 *   { type: "function", function: { name, description, parameters } }
 */
function normalizeToolFormat(tool) {
  if (!tool || typeof tool !== 'object') return tool;
  const result = { ...tool };

  if (!result.type) result.type = 'function';

  if (!result.function) {
    const { name, description, parameters, ...rest } = result;
    result.function = { name, description, parameters };
    result.type = 'function';
  }

  const fn = result.function;
  if (fn && typeof fn === 'object') {
    if (!fn.parameters || typeof fn.parameters !== 'object') {
      fn.parameters = { type: 'object', properties: {} };
    }
    if (fn.parameters.type !== 'object') {
      fn.parameters.type = 'object';
      if (!fn.parameters.properties) fn.parameters.properties = {};
    }
  }

  return result;
}

/**
 * 标准化 tool_call: 确保 type="function"，arguments 为 JSON 字符串
 */
function normalizeToolCall(tc) {
  if (!tc || typeof tc !== 'object') return tc;
  const result = { ...tc };
  if (!result.type) result.type = 'function';
  if (result.function && typeof result.function === 'object') {
    const fn = { ...result.function };
    if (typeof fn.arguments === 'object' && fn.arguments !== null) {
      fn.arguments = JSON.stringify(fn.arguments);
    }
    result.function = fn;
  }
  return result;
}

/**
 * 标准化响应中所有 choices 的 tool_calls
 */
function normalizeResponseToolCalls(body) {
  if (!body || !body.choices) return body;
  for (const choice of body.choices) {
    if (choice.message && Array.isArray(choice.message.tool_calls)) {
      choice.message.tool_calls = choice.message.tool_calls.map(normalizeToolCall);
    }
  }
  return body;
}

/**
 * 标准化流式 delta 中的 tool_calls
 */
function normalizeStreamToolCalls(chunk) {
  if (!chunk || !chunk.choices) return chunk;
  for (const choice of chunk.choices) {
    if (choice.delta && Array.isArray(choice.delta.tool_calls)) {
      choice.delta.tool_calls = choice.delta.tool_calls.map(normalizeToolCall);
    }
  }
  return chunk;
}

/**
 * 从 content 文本中提取嵌入的 tool_calls
 * patterns: [{ regex, parseFn }] — regex 需要有 capture group 1 为 JSON 内容
 * 返回 { cleanedContent, toolCalls[] }
 */
function extractToolCallsFromContent(content, patterns) {
  if (!content || typeof content !== 'string' || !patterns || patterns.length === 0) {
    return { cleanedContent: content, toolCalls: [] };
  }

  const toolCalls = [];
  let cleaned = content;

  for (const { regex, parseFn } of patterns) {
    const re = new RegExp(regex.source, regex.flags);
    let match;
    while ((match = re.exec(cleaned)) !== null) {
      const raw = match[1];
      if (!raw) continue;
      try {
        const parsed = parseFn ? parseFn(raw) : JSON.parse(raw);
        if (parsed && parsed.name) {
          toolCalls.push({
            id: `call_${toolCalls.length}`,
            type: 'function',
            function: {
              name: parsed.name,
              arguments: typeof parsed.arguments === 'string'
                ? parsed.arguments
                : JSON.stringify(parsed.arguments || {}),
            },
          });
          cleaned = cleaned.replace(match[0], '');
        }
      } catch {
        // parse 失败跳过
      }
    }
  }

  return { cleanedContent: cleaned.trim(), toolCalls };
}

/**
 * 从请求体中移除不兼容的字段
 */
function removeIncompatibleFields(body, fields) {
  for (const field of fields) {
    delete body[field];
  }
}

module.exports = {
  normalizeToolFormat,
  normalizeToolCall,
  normalizeResponseToolCalls,
  normalizeStreamToolCalls,
  extractToolCallsFromContent,
  removeIncompatibleFields,
};
