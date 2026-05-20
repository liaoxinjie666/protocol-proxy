/**
 * DeepSeek 适配器
 *
 * 已知问题:
 * - 不支持 logprobs/logit_bias/user 字段
 * - stop 最多支持 4 个
 * - 默认开启 thinking/reasoning 模式，可能导致 agent 死循环
 */
const {
  normalizeResponseToolCalls,
  normalizeStreamToolCalls,
  removeIncompatibleFields,
} = require('./utils');

function preprocessRequestBody(body) {
  removeIncompatibleFields(body, ['logprobs', 'logit_bias', 'user']);

  // stop 最多 4 个
  if (Array.isArray(body.stop) && body.stop.length > 4) {
    body.stop = body.stop.slice(0, 4);
  }

  // 禁用 thinking 模式（避免推理循环），除非请求已显式设置
  if (!body.thinking) {
    body.thinking = { type: 'disabled' };
  }
}

function postprocessResponseBody(body) {
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
