/**
 * 从模型输出的文本中提取 freeform/custom 工具调用的 XML。
 *
 * 某些模型（特别是经过 freeform→function 转换后）会偶发性地把工具调用
 * 写成 XML 文本而非结构化 tool_use：
 *   <tool_call> <function=shell_command> <parameter=command>ls -la</parameter> </function> </tool_call>
 *
 * 本模块负责从文本中提取这些 XML 块，转成结构化的 { name, arguments } 对象，
 * 并返回清理后的文本（去除 XML 块）。
 */

// 提取文本中的所有 <tool_call> 块，返回 { calls: [{name, arguments}], cleanedText }
function extractFreeformToolCalls(text) {
  if (!text || typeof text !== 'string') return { calls: [], cleanedText: text || '' };

  const calls = [];
  let cleanedText = text;

  // 匹配 <tool_call> ... </tool_call>（非贪婪，允许多个）
  const toolCallRe = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g;
  let m;
  const matched = [];

  while ((m = toolCallRe.exec(text)) !== null) {
    const inner = m[1];
    const parsed = parseToolCallInner(inner);
    if (parsed) {
      calls.push(parsed);
      matched.push(m[0]); // 记录原始匹配，用于清理
    }
  }

  if (calls.length === 0) return { calls: [], cleanedText: text };

  // 从原文中移除已解析的 <tool_call> 块
  for (const block of matched) {
    cleanedText = cleanedText.replace(block, '');
  }
  // 清理多余空白（XML 块移除后可能留下空行）
  cleanedText = cleanedText.replace(/\n{3,}/g, '\n\n').trim();

  return { calls, cleanedText };
}

// 解析 <tool_call> 内部的内容：<function=NAME> <parameter=P1>V1</parameter> ... </function>
function parseToolCallInner(inner) {
  // 提取并消费 function 开始标签：<function=NAME>
  const funcMatch = inner.match(/<function=(\w+)>/);
  if (!funcMatch) return null;
  const name = funcMatch[1];

  // 从 function 开始标签之后的内容里提取参数
  // （避免把 <function=NAME> 当成 parameter 误匹配）
  const afterFunc = inner.slice(funcMatch.index + funcMatch[0].length);

  // 提取所有参数：<parameter=NAME>VALUE</parameter>
  // 注意：模型偶发会把 parameter 写成 function（如 <function=prefix_rule>），统一当作参数处理
  const params = {};
  const paramRe = /<(?:parameter|function)=(\w+)>([\s\S]*?)<\/(?:parameter|function)>/g;
  let pm;
  while ((pm = paramRe.exec(afterFunc)) !== null) {
    const paramName = pm[1];
    let paramValue = pm[2].trim();
    // 尝试解析 JSON 值（如数组、对象、数字），失败则保留字符串
    try {
      paramValue = JSON.parse(paramValue);
    } catch {
      // 保留原始字符串
    }
    params[paramName] = paramValue;
  }

  return { name, arguments: params };
}

module.exports = { extractFreeformToolCalls };
