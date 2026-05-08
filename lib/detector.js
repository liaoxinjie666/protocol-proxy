/**
 * 检测入站请求使用的协议类型
 */

function detectInboundProtocol(req, body) {
  const path = req.path || req.url || '';

  // Anthropic 特征路径
  if (path.includes('/v1/messages')) {
    return 'anthropic';
  }

  // OpenAI 特征路径
  if (path.includes('/v1/chat/completions')) {
    return 'openai';
  }

  // 根据 body 结构推断
  if (body && typeof body === 'object') {
    // Anthropic: 有 system 顶级字段，messages 中角色没有 system
    if (body.system !== undefined && Array.isArray(body.messages)) {
      return 'anthropic';
    }
    // OpenAI: messages 数组中包含 role: system
    if (Array.isArray(body.messages) && body.messages.some(m => m && m.role === 'system')) {
      return 'openai';
    }
    // 默认按 functions/tools 字段判断
    if (body.functions !== undefined || (body.tools && Array.isArray(body.tools))) {
      return 'openai';
    }
  }

  // 无法确定时，默认 openai
  return 'openai';
}

module.exports = { detectInboundProtocol };
