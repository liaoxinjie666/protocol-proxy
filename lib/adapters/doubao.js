/**
 * 豆包/火山 (Doubao) 适配器
 *
 * 已知问题:
 * - 不支持 logprobs/logit_bias/user 字段
 * - stop 最多支持 4 个
 */
const {
  normalizeResponseToolCalls,
  normalizeStreamToolCalls,
  removeIncompatibleFields,
} = require('./utils');

function preprocessRequestBody(body) {
  removeIncompatibleFields(body, ['logprobs', 'logit_bias', 'user', 'stream_options']);

  // stop 最多 4 个
  if (Array.isArray(body.stop) && body.stop.length > 4) {
    body.stop = body.stop.slice(0, 4);
  }
}

function postprocessResponseBody(body) {
  return normalizeResponseToolCalls(body);
}

function preprocessImageGenerationBody(body) {
  if (!body || typeof body !== 'object') return body;
  if (!body.response_format) body.response_format = 'url';
  if (body.watermark === undefined) body.watermark = false;
  return body;
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

module.exports = {
  preprocessRequestBody,
  postprocessResponseBody,
  transformStreamChunk,
  preprocessImageGenerationBody,
};
