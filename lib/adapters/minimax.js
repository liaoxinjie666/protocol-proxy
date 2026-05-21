/**
 * MiniMax 适配器
 *
 * 已知限制:
 * - 不支持多条 system 消息，需合并为一条
 */

function preprocessRequestBody(body) {
  if (!Array.isArray(body.messages)) return;

  // 合并连续 system 消息
  for (let i = body.messages.length - 1; i > 0; i--) {
    if (body.messages[i].role === 'system' && body.messages[i - 1].role === 'system') {
      const a = typeof body.messages[i - 1].content === 'string' ? body.messages[i - 1].content : '';
      const b = typeof body.messages[i].content === 'string' ? body.messages[i].content : '';
      body.messages[i - 1].content = a + '\n\n' + b;
      body.messages.splice(i, 1);
    }
  }
}

module.exports = { preprocessRequestBody };
