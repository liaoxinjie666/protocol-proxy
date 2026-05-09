/**
 * SSE 解析与编码辅助函数
 */

function encodeOpenAIEvent(obj) {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

function encodeOpenAIDone() {
  return 'data: [DONE]\n\n';
}

function encodeAnthropicEvent(eventName, obj) {
  return `event: ${eventName}\ndata: ${JSON.stringify(obj)}\n\n`;
}

module.exports = {
  encodeOpenAIEvent,
  encodeOpenAIDone,
  encodeAnthropicEvent,
};
