/**
 * SSE 解析与编码辅助函数
 */

function parseSSELines(buffer) {
  const lines = buffer.split('\n');
  const events = [];
  let currentEvent = { event: null, data: null };

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === '') {
      // 空行表示一个事件结束
      if (currentEvent.data !== null) {
        events.push(currentEvent);
      }
      currentEvent = { event: null, data: null };
      continue;
    }
    if (trimmed.startsWith('event:')) {
      currentEvent.event = trimmed.slice(6).trim();
    } else if (trimmed.startsWith('data:')) {
      const data = trimmed.slice(5).trim();
      currentEvent.data = currentEvent.data === null ? data : currentEvent.data + '\n' + data;
    }
  }

  // 如果最后一行没有空行结束，保留未完成的事件
  const remainder = currentEvent.data !== null ? currentEvent : null;

  return { events, remainder };
}

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
  parseSSELines,
  encodeOpenAIEvent,
  encodeOpenAIDone,
  encodeAnthropicEvent,
};
