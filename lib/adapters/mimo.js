/**
 * MiMo 适配器（小米 MiMo-v2.5 / mimo-v2-omni）
 *
 * 已知特性:
 * - 使用 OpenAI 兼容格式，扩展了 video_url content block
 * - 支持 fps / media_resolution 参数控制视频理解精细度
 * - 响应 usage 中包含 video_tokens / audio_tokens
 */
const {
  normalizeResponseToolCalls,
  normalizeStreamToolCalls,
  removeIncompatibleFields,
} = require('./utils');

function preprocessRequestBody(body) {
  removeIncompatibleFields(body, ['logprobs', 'logit_bias', 'user']);
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
