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

/**
 * 解包 freeform 工具的 JSON 包裹参数
 * 从 {"input": "..."} 或 {"patch": "..."} 中提取原始文本
 * 优先匹配已知 key（input, patch），否则取第一个 string 类型的值
 */

/**
 * Namespace 工具名反向查找
 * 支持全名查找（mcp__node_repl__js）和短名反向查找（js → childName 匹配）
 * @param {string} name - 工具名
 * @param {object|null} namespaceMap - namespace 映射表
 * @returns {{ namespace: string, displayName: string, isNamespaceCustom: boolean }}
 */
function resolveNamespace(name, namespaceMap) {
  if (!namespaceMap || !name) return { namespace: '', displayName: name || '', isNamespaceCustom: false };
  let entry = namespaceMap[name];
  if (!entry) {
    for (const val of Object.values(namespaceMap)) {
      if (val.childName === name) { entry = val; break; }
    }
  }
  if (entry) {
    return {
      namespace: entry.namespace,
      displayName: entry.childName,
      isNamespaceCustom: entry.childType === 'custom',
    };
  }
  return { namespace: '', displayName: name, isNamespaceCustom: false };
}
function unwrapFreeformArgs(rawArgs) {
  if (!rawArgs) return rawArgs;
  try {
    const parsed = JSON.parse(rawArgs);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return rawArgs;
    const keys = Object.keys(parsed);
    if (keys.length === 0) return rawArgs;
    // 优先匹配已知 key
    for (const known of ['input', 'patch']) {
      if (typeof parsed[known] === 'string') return parsed[known];
    }
    // fallback: 第一个 string 类型的值
    if (typeof parsed[keys[0]] === 'string') return parsed[keys[0]];
  } catch { /* 不是 JSON，保持原样 */ }
  return rawArgs;
}

module.exports = {
  encodeOpenAIEvent,
  encodeOpenAIDone,
  encodeAnthropicEvent,
  unwrapFreeformArgs,
  resolveNamespace,
};
