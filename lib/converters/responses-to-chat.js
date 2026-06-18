/**
 * Responses API → Chat Completions API 转换器
 *
 * 将 OpenAI Responses API (第三代) 请求转换为 Chat Completions API (第二代) 格式
 */

const { normalizeToolFormat } = require('../adapters/utils');

let _debugLog = null;
function dbg(...args) { if (_debugLog) _debugLog(...args); }
function setDebugLogger(fn) { _debugLog = fn; }

const ROLE_MAP = { developer: 'system' };

// 过滤系统提示词中与 function 工具格式矛盾的 freeform 指令
// 当 freeform/custom 工具被转为 function 工具后，"do not wrap in JSON" 等指示会让模型困惑
function sanitizeInstructionsForFreeform(instructions, freeformToolNames) {
  if (!instructions || freeformToolNames.length === 0) return instructions;
  let result = instructions;

  // 移除包含 "FREEFORM" 的句子（通常伴随 "do not wrap in JSON"）
  // 匹配：句号/换行前包含 FREEFORM 的整句
  result = result.replace(/[^\n.!?]*\bFREEFORM\b[^.!?\n]*[.!?\n]?/gi, '');

  // 移除 "do not wrap ... in JSON" / "don't wrap ... in JSON" 变体
  result = result.replace(/[^\n.!?]*\b(?:do not|don't)\s+wrap\b[^.!?\n]*\bJSON\b[^.!?\n]*[.!?\n]?/gi, '');

  // 移除 "Pass the input directly" / "pass as raw text" 等 freeform 特有指示
  result = result.replace(/[^\n.!?]*\bpass\b[^.!?\n]*\b(?:raw text|directly|as-is)\b[^.!?\n]*[.!?\n]?/gi, '');

  // 清理多余空行（连续 3+ 换行 → 2 换行）
  result = result.replace(/\n{3,}/g, '\n\n').trim();

  if (result !== instructions) {
    dbg(`[r2c] sanitized instructions: ${instructions.length} → ${result.length} chars (removed freeform contradictions for tools: ${freeformToolNames.join(',')})`);
  }
  return result;
}

// ─── 请求转换 ───────────────────────────────────────────────

function convertRequest(body, targetModel) {
  const messages = mapInputToMessages(body.input || []);

  const chatReq = {
    model: targetModel || body.model,
    messages,
    stream: body.stream || false,
  };

  // 可选参数
  if (body.temperature != null) chatReq.temperature = body.temperature;
  if (body.top_p != null) chatReq.top_p = body.top_p;
  if (body.stop != null) chatReq.stop = body.stop;

  // max_output_tokens → max_tokens
  if (body.max_output_tokens != null) {
    chatReq.max_tokens = body.max_output_tokens;
  }

  // tools 标准化
  // freeform 工具转为 function 类型透传（参数用 JSON 字段包裹原始文本）
  // namespace 工具（MCP）展平为独立的 function 工具
  const freeformTools = [];
  const namespaceMap = {}; // flattenedName → { namespace, childName }
  if (Array.isArray(body.tools) && body.tools.length > 0) {
    dbg(`[r2c] raw tools count=${body.tools.length}`);
    // 展开 namespace 工具和普通工具（namespace 会展开为多个 function 工具）
    const expandedTools = [];
    for (const tool of body.tools) {
      if (!tool) continue;
      if (tool.type === 'namespace') {
        expandedTools.push(...flattenNamespaceTool(tool, namespaceMap, dbg));
      } else {
        expandedTools.push(tool);
      }
    }
    chatReq.tools = expandedTools
      .map(tool => {
        if (!tool) return null;
        // 记录原始工具定义（截取关键字段）
        const toolKeys = Object.keys(tool);
        const toolName = tool.name || tool.function?.name || '?';
        dbg(`[r2c] raw tool "${toolName}": type=${tool.type || '(none)'} keys=[${toolKeys.join(',')}] name=${tool.name || '(none)'} hasParams=${!!tool.parameters} hasFunction=${!!tool.function}`);

        if (tool.type === 'image_gen') return makeImageGenTool(tool);
        // Responses API 内置工具类型（tool_search, web_search, file_search 等）
        // 在 Chat Completions 中无等价物，直接过滤掉
        if (tool.type && tool.type !== 'function' && tool.type !== 'freeform' && tool.type !== 'custom') {
          dbg(`[r2c] tool "${toolName}" → filtered (built-in type=${tool.type}, not supported in Chat Completions)`);
          return null;
        }
        // freeform / custom 工具 → 转为 function 类型
        if ((tool.type === 'freeform' || tool.type === 'custom') && tool.name) {
          freeformTools.push(tool.name);
          const converted = makeFreeformTool(tool);
          dbg(`[r2c] tool "${tool.name}" type=${tool.type} → function (freeform/custom conversion)`);
          return converted;
        }
        // 已知 freeform/custom 工具（名字匹配 FREEFORM_TOOL_DEFS）→ 转为 function 类型
        if (tool.name && FREEFORM_TOOL_DEFS[tool.name] && (!tool.type || tool.type === 'function')) {
          freeformTools.push(tool.name);
          const converted = makeFreeformTool(tool);
          dbg(`[r2c] tool "${tool.name}" type=${tool.type || '(none)'} → function (FREEFORM_TOOL_DEFS match)`);
          return converted;
        }
        // 默认路径
        const normalized = normalizeToolFormat(tool);
        const normName = normalized?.function?.name || '?';
        dbg(`[r2c] tool "${toolName}" type=${tool.type || '(none)'} → normalizeToolFormat (name="${normName}")`);
        return normalized;
      })
      .filter(t => t && ((t.type && t.type !== 'function') || (t.function && t.function.name)));
  }
  if (freeformTools.length > 0) {
    chatReq._freeformTools = freeformTools;
    dbg(`[r2c] freeformTools=${JSON.stringify(freeformTools)}`);
  }
  if (Object.keys(namespaceMap).length > 0) {
    chatReq._namespaceMap = namespaceMap;
    dbg(`[r2c] namespaceMap=${JSON.stringify(namespaceMap)}`);
  }
  if (Array.isArray(chatReq.tools)) {
    dbg(`[r2c] converted tools=${JSON.stringify(chatReq.tools.map(t => ({ type: t.type, name: t.function?.name || t.name, params: Object.keys(t.function?.parameters?.properties || t.parameters?.properties || {}) })))}`);
  }
  if (freeformTools.length === 0 && Object.keys(namespaceMap).length === 0) {
    dbg(`[r2c] no freeform or namespace tools detected.`);
  }

  // instructions → system 消息（在工具转换之后，以便根据 freeform 工具过滤矛盾指令）
  const instructions = (body.instructions || '').trim();
  if (instructions) {
    const sanitized = freeformTools.length > 0
      ? sanitizeInstructionsForFreeform(instructions, freeformTools)
      : instructions;
    messages.unshift({ role: 'system', content: sanitized });
  }

  // tool_choice（Responses API 和 Chat Completions 格式不同，需要转换）
  if (body.tool_choice && chatReq.tools) {
    const tc = body.tool_choice;
    if (typeof tc === 'object' && tc.type === 'function' && tc.name) {
      chatReq.tool_choice = { type: 'function', function: { name: tc.name } };
    } else {
      chatReq.tool_choice = tc;
    }
  }

  // parallel_tool_calls
  if (body.parallel_tool_calls != null) {
    chatReq.parallel_tool_calls = body.parallel_tool_calls;
  }

  return chatReq;
}

// ─── 输入项 → 消息数组 ──────────────────────────────────────

function mapInputToMessages(inputItems) {
  if (typeof inputItems === 'string') {
    return [{ role: 'user', content: inputItems }];
  }
  if (!Array.isArray(inputItems)) return [];

  const messages = [];
  let pendingToolCalls = [];
  let pendingReasoning = '';
  let pendingAssistantContent = null; // 暂存 assistant 文本，与后续 tool_calls 合并到同一条消息

  // flush 当前 assistant 回合：把暂存的 text + tool_calls 合并成一条 assistant 消息
  // （chat/anthropic 协议要求同一 assistant 回合的 text 和 tool_use 在同一条消息里，
  //  否则多轮后模型会因消息序列碎片化而困惑、停止调用工具）
  function flushAssistant() {
    const hasContent = pendingAssistantContent !== null;
    const hasTools = pendingToolCalls.length > 0;
    const hasReasoning = !!pendingReasoning;
    if (!hasContent && !hasTools && !hasReasoning) return; // 无内容可 flush
    const msg = { role: 'assistant' };
    msg.content = hasContent ? pendingAssistantContent : null;
    if (hasTools) {
      msg.tool_calls = pendingToolCalls.slice();
    }
    if (hasReasoning) {
      msg.reasoning_content = pendingReasoning;
    } else if (hasTools) {
      msg.reasoning_content = 'Tool calls.';
    }
    messages.push(msg);
    pendingToolCalls = [];
    pendingAssistantContent = null;
    pendingReasoning = '';
  }

  // 旧的 flushToolCalls 保留兼容（实际由 flushAssistant 统一处理）
  function flushToolCalls() {
    flushAssistant();
  }

  for (const item of inputItems) {
    if (!item || typeof item !== 'object') continue;

    switch (item.type) {
      case 'reasoning': {
        // reasoning item → 暂存，附加到下一个 assistant 消息
        const text = extractReasoningText(item);
        if (text) pendingReasoning += (pendingReasoning ? '\n' : '') + text;
        continue;
      }

      case 'function_call_output':
      case 'custom_tool_call_output': {
        flushToolCalls();
        let content = item.output;
        if (Array.isArray(content)) {
          content = content.map(p => p.text || '').join('');
        } else if (typeof content !== 'string') {
          content = String(content);
        }
        dbg(`[r2c] input→msg: ${item.type} call_id=${item.call_id} content=${JSON.stringify(content).slice(0, 200)}`);
        messages.push({
          role: 'tool',
          tool_call_id: item.call_id,
          content,
        });
        continue;
      }

      case 'function_call':
      case 'custom_tool_call': {
        // custom_tool_call 用 input 字段，function_call 用 arguments 字段
        const args = item.input !== undefined ? item.input : item.arguments;
        const argsStr = typeof args === 'string' ? args : JSON.stringify(args || {});
        dbg(`[r2c] input→msg: ${item.type} name=${item.name} call_id=${item.call_id} args=${argsStr.slice(0, 200)}`);
        pendingToolCalls.push({
          id: item.call_id,
          type: 'function',
          function: {
            name: item.name,
            arguments: argsStr,
          },
        });
        continue;
      }

      default: {
        const role = ROLE_MAP[item.role] || item.role || 'user';
        const content = normalizeContent(item.content);

        if (role === 'assistant') {
          // assistant message：暂存文本，与同回合的 function_call 合并（不立即 push）
          if (content != null) {
            pendingAssistantContent = content;
          }
          // reasoning 也暂存（不在此处赋值，由 flushAssistant 统一处理）
          continue;
        }

        // 非 assistant 消息（user/system 等）：先 flush 待处理的 assistant 回合
        flushAssistant();

        const msg = { role };
        if (content != null) {
          msg.content = content;
        }
        if (item.name) msg.name = item.name;
        messages.push(msg);
      }
    }
  }

  // 处理尾部未 flush 的 tool_calls
  // 循环结束：flush 最后一个待处理的 assistant 回合（含 text + tool_calls + reasoning）
  flushAssistant();

  return messages;
}

// ─── 辅助函数 ───────────────────────────────────────────────

function extractReasoningText(item) {
  const parts = [];
  if (Array.isArray(item.summary)) {
    for (const s of item.summary) {
      if (s && s.text) parts.push(s.text);
    }
  }
  if (Array.isArray(item.content)) {
    for (const c of item.content) {
      if (c && c.text) parts.push(c.text);
    }
  }
  return parts.join('\n');
}

function normalizeContent(content) {
  if (content == null) return null;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return String(content);

  const parts = [];
  for (const part of content) {
    if (!part || typeof part !== 'object') continue;
    switch (part.type) {
      case 'input_text':
        parts.push({ type: 'text', text: part.text });
        break;
      case 'output_text':
        parts.push({ type: 'text', text: part.text });
        break;
      case 'input_image': {
        // Responses API 的 input_image.image_url 是字符串（data URL 或完整 URL），
        // Chat Completions 标准格式是 { image_url: { url: "..." } }，这里归一化。
        const url = typeof part.image_url === 'string' ? part.image_url : part.image_url?.url;
        if (url) {
          parts.push({ type: 'image_url', image_url: { url } });
        } else if (part.file_id) {
          // file_id 形式：当前不支持（需先通过 Files API 下载），用占位文本避免静默丢失
          dbg(`[r2c] input_image with file_id="${part.file_id}" 不支持，已用占位文本替代`);
          parts.push({ type: 'text', text: '[图片内容未透传：file_id 形式暂不支持]' });
        }
        break;
      }
      case 'input_file':
        // Responses API 的文档/文件输入（PDF 等），当前不支持，用占位文本避免静默丢失
        dbg(`[r2c] input_file 不支持，已用占位文本替代`);
        parts.push({ type: 'text', text: '[文件内容未透传：input_file 暂不支持]' });
        break;
      default:
        parts.push(part);
    }
  }

  if (parts.length === 0) return null;
  if (parts.length === 1 && parts[0].type === 'text') return parts[0].text;
  return parts;
}

function makeImageGenTool(tool) {
  return {
    type: 'function',
    function: {
      name: 'image_gen',
      description: 'Generate a raster image from a detailed text prompt.',
      parameters: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: 'Detailed image generation prompt.' },
          size: { type: 'string', description: 'Image size such as 1024x1024 or 2560x1440.' },
        },
        required: ['prompt'],
      },
    },
    _image_gen: { size: tool.size || '' },
  };
}

// freeform/custom 工具 → function 工具
// Responses API 的 freeform/custom 工具参数是原始文本（非 JSON），
// 转为 function 工具时用单个 "input" string 参数包裹，与 Codex 的 JSON fallback 设计一致
const FREEFORM_TOOL_DEFS = {
  apply_patch: {
    description: 'Use the apply_patch tool to edit files. Pass an "input" argument containing the patch text.\nFormat: *** Begin Patch, then *** Add File: <path> (lines start with +), *** Update File: <path> (@@ for section, - remove, + add), *** Delete File: <path>, *** End Patch.\nFile references can only be relative, NEVER ABSOLUTE.\nExample: "*** Begin Patch\\n*** Add File: hello.txt\\n+Hello World\\n*** End Patch"',
    paramProp: 'input',
    paramDesc: 'The patch text. Must start with *** Begin Patch and end with *** End Patch.',
  },
  js_repl: {
    description: 'Execute JavaScript code in a REPL environment. Pass an "input" argument containing the JavaScript code to execute.',
    paramProp: 'input',
    paramDesc: 'The JavaScript code to execute.',
  },
};

function makeFreeformTool(tool) {
  const name = tool.name;
  const def = FREEFORM_TOOL_DEFS[name];
  if (def) {
    return {
      type: 'function',
      function: {
        name,
        // 使用预定义描述（原始描述可能说"不要包裹JSON"，与转换后的 function 格式矛盾）
        description: def.description,
        parameters: {
          type: 'object',
          properties: {
            [def.paramProp]: { type: 'string', description: def.paramDesc },
          },
          required: [def.paramProp],
        },
      },
    };
  }

  // 未知 freeform/custom 工具：利用 format 字段和 description 生成最佳描述
  let description = tool.description || `Execute the ${name} tool.`;
  // 清理与 function 格式矛盾的提示（句子级匹配，避免跨句删除）
  description = description
    .replace(/[^\n.!?]*\bFREEFORM\b[^.!?\n]*[.!?\n]?/gi, '')
    .replace(/[^\n.!?]*\bdo not wrap\b[^.!?\n]*\bJSON\b[^.!?\n]*[.!?\n]?/gi, '')
    .replace(/[^\n.!?]*\bdon't wrap\b[^.!?\n]*\bJSON\b[^.!?\n]*[.!?\n]?/gi, '')
    .replace(/\n{3,}/g, '\n\n').trim();

  // 从 format 字段提取语法信息，附加到描述中
  if (tool.format && tool.format.type === 'grammar' && tool.format.definition) {
    const syntax = tool.format.syntax || 'grammar';
    const fullGrammar = tool.format.definition.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    // 截取语法定义的关键部分（按行截断，避免切断语法规则）
    const grammarSnippet = fullGrammar.length > 500
      ? fullGrammar.slice(0, fullGrammar.lastIndexOf('\n', 500)) + '\n...'
      : fullGrammar;
    description += `\nExpected input format (${syntax} grammar):\n${grammarSnippet}`;
  } else if (tool.format && tool.format.type === 'regex' && tool.format.pattern) {
    description += `\nExpected input must match regex: ${tool.format.pattern}`;
  }

  return {
    type: 'function',
    function: {
      name,
      description,
      parameters: {
        type: 'object',
        properties: {
          input: { type: 'string', description: `The input text for the ${name} tool.` },
        },
        required: ['input'],
      },
    },
  };
}

// ─── Namespace 工具展平 ───────────────────────────────────────
// Codex 中 MCP 工具以 type: "namespace" 形式发送，结构如：
// { type: "namespace", namespace: "node_repl", tools: [{ name: "js", ... }] }
// 展平为独立的 function 工具，名称格式: namespace__child_name

function flattenNamespaceTool(namespaceTool, namespaceMap, dbg) {
  const ns = namespaceTool.namespace || namespaceTool.name || '';
  const children = namespaceTool.tools;
  if (!Array.isArray(children) || children.length === 0) {
    dbg(`[r2c] namespace tool "${ns}" has no children, skipping`);
    return [];
  }

  const nsDesc = namespaceTool.description || '';
  const result = [];

  for (const child of children) {
    if (!child || !child.name) continue;

    const flatName = flattenNamespaceName(ns, child.name);
    const childType = child.type || 'function';
    // 记录子工具的原始类型（custom vs function），响应转换时需要区分
    namespaceMap[flatName] = { namespace: ns, childName: child.name, childType };

    // 合并描述：namespace 描述 + 子工具描述
    let description = child.description || '';
    if (nsDesc && description) {
      description = `${nsDesc}\n\n${description}`;
    } else if (nsDesc) {
      description = nsDesc;
    }

    // custom 类型子工具 → freeform 函数工具（单个 input 字符串参数）
    // function 类型子工具 → 标准函数工具（使用原始 parameters）
    if (childType === 'custom') {
      result.push({
        type: 'function',
        function: {
          name: flatName,
          description: description || `Execute the ${child.name} tool.`,
          parameters: {
            type: 'object',
            properties: {
              input: { type: 'string', description: `The input for ${child.name}.` },
            },
            required: ['input'],
          },
        },
      });
      dbg(`[r2c] namespace "${ns}" child "${child.name}" type=custom → function "${flatName}" (freeform)`);
    } else {
      result.push({
        type: 'function',
        function: {
          name: flatName,
          description,
          parameters: child.parameters || { type: 'object', properties: {} },
        },
      });
      dbg(`[r2c] namespace "${ns}" child "${child.name}" type=function → function "${flatName}"`);
    }
  }

  return result;
}

function flattenNamespaceName(namespace, name) {
  if (!namespace) return name;
  if (namespace.endsWith('__') || name.startsWith('__')) {
    return `${namespace}${name}`;
  }
  return `${namespace}__${name}`;
}

module.exports = { convertRequest, setDebugLogger };
