/**
 * 智谱 GLM (Zhipu) 适配器
 *
 * 已知问题:
 * - 不支持 logprobs/logit_bias 字段
 * - 默认关闭采样，需要显式设置 do_sample: true
 * - 默认开启 thinking 模式
 */
const {
  normalizeResponseToolCalls,
  normalizeStreamToolCalls,
  removeIncompatibleFields,
} = require('./utils');

function preprocessRequestBody(body) {
  removeIncompatibleFields(body, ['logprobs', 'logit_bias']);

  // GLM 需要显式开启采样
  if (body.do_sample === undefined) {
    body.do_sample = true;
  }

  // 禁用 thinking 模式，除非已显式设置
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
