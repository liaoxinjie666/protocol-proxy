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

// ─── 请求转换 ───────────────────────────────────────────────

function convertRequest(body, targetModel) {
  const messages = mapInputToMessages(body.input || []);

  // instructions → system 消息
  const instructions = (body.instructions || '').trim();
  if (instructions) {
    messages.unshift({ role: 'system', content: instructions });
  }

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
  const freeformTools = [];
  if (Array.isArray(body.tools) && body.tools.length > 0) {
    dbg(`[r2c] raw tools count=${body.tools.length}`);
    chatReq.tools = body.tools
      .map(tool => {
        if (!tool) return null;
        // 记录原始工具定义（截取关键字段）
        const toolKeys = Object.keys(tool);
        const toolName = tool.name || tool.function?.name || '?';
        dbg(`[r2c] raw tool "${toolName}": type=${tool.type || '(none)'} keys=[${toolKeys.join(',')}] name=${tool.name || '(none)'} hasParams=${!!tool.parameters} hasFunction=${!!tool.function}`);

        if (tool.type === 'image_gen') return makeImageGenTool(tool);
        // Responses API 内置工具类型直接保留（tool_search, web_search 等）
        // custom 和 freeform 不是内置类型，需要转换为 function 工具
        if (tool.type && tool.type !== 'function' && tool.type !== 'freeform' && tool.type !== 'custom') {
          dbg(`[r2c] tool "${toolName}" → passthrough (built-in type=${tool.type})`);
          return tool;
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
    dbg(`[r2c] converted tools=${JSON.stringify(chatReq.tools.map(t => ({ type: t.type, name: t.function?.name || t.name, params: Object.keys(t.function?.parameters?.properties || t.parameters?.properties || {}) })))}`);
  } else {
    dbg(`[r2c] no freeform tools detected. tools=${JSON.stringify(chatReq.tools.map(t => ({ type: t.type, name: t.function?.name || t.name })))}`);
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

  function flushToolCalls() {
    if (pendingToolCalls.length === 0) return;
    messages.push({
      role: 'assistant',
      content: null,
      tool_calls: pendingToolCalls.slice(),
      reasoning_content: pendingReasoning || 'Tool calls.',
    });
    pendingToolCalls = [];
    pendingReasoning = '';
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
        flushToolCalls();
        const role = ROLE_MAP[item.role] || item.role || 'user';
        const content = normalizeContent(item.content);
        const msg = { role };

        if (content != null) {
          msg.content = content;
        }

        if (item.name) msg.name = item.name;

        // 附加推理内容
        if (role === 'assistant' && pendingReasoning) {
          msg.reasoning_content = pendingReasoning;
          pendingReasoning = '';
        }

        messages.push(msg);
      }
    }
  }

  // 处理尾部未 flush 的 tool_calls
  flushToolCalls();

  // 如果还有未消费的 reasoning，附加到最后一个 assistant 消息
  if (pendingReasoning) {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'assistant') {
        messages[i].reasoning_content = pendingReasoning;
        break;
      }
    }
  }

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
      case 'input_image':
        parts.push({ type: 'image_url', image_url: part.image_url });
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

// freeform 工具（如 apply_patch）→ function 工具
// freeform 工具的参数是原始文本（非 JSON），Chat Completions 不支持这种格式
// 所以需要包装为一个 function 工具，参数用 cmd JSON 字段包裹原始文本
const FREEFORM_TOOL_DEFS = {
  apply_patch: {
    description: 'Create, modify, or delete files using a patch. Pass a "patch" argument with the patch text. Format: *** Begin Patch, then *** Add File: <path> (lines start with +), *** Update File: <path> (@@ for section, - remove, + add), *** Delete File: <path>, *** End Patch. Example: "*** Begin Patch\\n*** Add File: hello.txt\\n+Hello World\\n*** End Patch"',
    paramProp: 'patch',
    paramDesc: 'The patch text. Must start with *** Begin Patch and end with *** End Patch.',
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
        // 始终用我们的描述（原始描述说"不要包裹JSON"，与转换后的function格式矛盾）
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
  // 未知 freeform 工具：通用包装
  return {
    type: 'function',
    function: {
      name,
      description: tool.description || `Execute the ${name} tool.`,
      parameters: {
        type: 'object',
        properties: {
          input: { type: 'string', description: 'The tool input as text.' },
        },
        required: ['input'],
      },
    },
  };
}

module.exports = { convertRequest, setDebugLogger };
