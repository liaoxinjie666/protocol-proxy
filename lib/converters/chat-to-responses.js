/**
 * Chat Completions API ↔ Responses API 双向转换器
 *
 * - convertRequest: Chat 请求 → Responses 请求
 * - convertResponse: Chat 响应 → Responses 响应
 * - createSSEConverter: Chat SSE → Responses SSE
 */

const { encodeAnthropicEvent, encodeDone, unwrapFreeformArgs, resolveNamespace } = require('./sse-helpers');
const { extractFreeformToolCalls } = require('./freeform-parser');

let _debugLog = null;
function dbg(...args) { if (_debugLog) _debugLog(...args); }
function setDebugLogger(fn) { _debugLog = fn; }

function uid(prefix) {
  const hex = Date.now().toString(16) + Math.random().toString(16).slice(2, 14);
  return `${prefix}_${hex.padEnd(24, '0').slice(0, 24)}`;
}

// ─── 请求转换: Chat → Responses ───────────────────────────────

function convertRequest(chatBody, targetModel) {
  const messages = chatBody.messages || [];
  let instructions = '';
  const input = [];

  for (const msg of messages) {
    if (msg.role === 'system') {
      // system 消息 → instructions
      const text = typeof msg.content === 'string' ? msg.content : '';
      instructions += (instructions ? '\n\n' : '') + text;
      continue;
    }

    const item = { role: msg.role === 'assistant' ? 'assistant' : 'user' };

    if (msg.role === 'assistant' && Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
      // assistant + tool_calls → function_call items
      if (msg.content) {
        item.type = 'message';
        item.content = [{ type: 'output_text', text: msg.content }];
        input.push(item);
      }
      for (const tc of msg.tool_calls) {
        input.push({
          type: 'function_call',
          call_id: tc.id || uid('call'),
          name: tc.function?.name || '',
          arguments: typeof tc.function?.arguments === 'string' ? tc.function.arguments : JSON.stringify(tc.function?.arguments || {}),
        });
      }
      continue;
    }

    if (msg.role === 'tool') {
      // tool 结果 → function_call_output
      input.push({
        type: 'function_call_output',
        call_id: msg.tool_call_id || '',
        output: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content || ''),
      });
      continue;
    }

    // 普通消息
    item.type = 'message';
    if (typeof msg.content === 'string') {
      item.content = [{ type: msg.role === 'user' ? 'input_text' : 'output_text', text: msg.content }];
    } else if (Array.isArray(msg.content)) {
      item.content = msg.content.map(part => {
        if (part.type === 'text') return { type: msg.role === 'user' ? 'input_text' : 'output_text', text: part.text };
        if (part.type === 'image_url') return { type: 'input_image', image_url: part.image_url };
        return part;
      });
    } else if (msg.content != null) {
      item.content = [{ type: 'input_text', text: String(msg.content) }];
    }
    input.push(item);
  }

  const respReq = {
    model: targetModel || chatBody.model,
    input,
    stream: chatBody.stream || false,
  };

  if (instructions) respReq.instructions = instructions;
  if (chatBody.temperature != null) respReq.temperature = chatBody.temperature;
  if (chatBody.top_p != null) respReq.top_p = chatBody.top_p;
  if (chatBody.stop != null) respReq.stop = chatBody.stop;
  if (chatBody.max_tokens != null) respReq.max_output_tokens = chatBody.max_tokens;
  if (Array.isArray(chatBody.tools) && chatBody.tools.length > 0) {
    respReq.tools = chatBody.tools.map(t => {
      const fn = t.function || t;
      return {
        type: 'function',
        name: fn.name || '',
        description: fn.description || '',
        parameters: fn.parameters || { type: 'object', properties: {} },
      };
    });
  }
  if (chatBody.tool_choice && respReq.tools) {
    const tc = chatBody.tool_choice;
    if (typeof tc === 'object' && tc.type === 'function' && tc.function?.name) {
      // Chat Completions: {"type": "function", "function": {"name": "shell"}}
      // Responses API: {"type": "function", "name": "shell"}
      respReq.tool_choice = { type: 'function', name: tc.function.name };
    } else {
      respReq.tool_choice = tc;
    }
  }

  return respReq;
}

// freeform 工具在 Responses API 中使用 custom_tool_call 类型
// 字段名是 input 而非 arguments，delta 事件是 custom_tool_call_input.delta
function makeToolCallItem(name, callId, args, isFreeform, namespace) {
  if (isFreeform) {
    const item = {
      id: uid('func'),
      object: 'realtime.item',
      type: 'custom_tool_call',
      name,
      call_id: callId,
      input: args,
      status: 'completed',
    };
    if (namespace) item.namespace = namespace;
    return item;
  }
  const item = {
    id: uid('func'),
    object: 'realtime.item',
    type: 'function_call',
    name,
    call_id: callId,
    arguments: args,
    status: 'completed',
  };
  if (namespace) item.namespace = namespace;
  return item;
}

// ─── 非流式响应转换 ─────────────────────────────────────────

function convertResponse(body, freeformTools, namespaceMap) {
  const output = [];

  if (body.choices && body.choices.length > 0) {
    const msg = body.choices[0].message;

    // reasoning_content → reasoning item（放在 message 之前，与流式顺序一致）
    // 跨源降级：只传思维链摘要文本，不涉及加密状态
    if (msg && msg.reasoning_content) {
      const text = typeof msg.reasoning_content === 'string'
        ? msg.reasoning_content
        : (Array.isArray(msg.reasoning_content) ? msg.reasoning_content.map(b => b.thinking || b.text || '').join('') : '');
      if (text && text.trim()) {
        output.push({
          id: uid('rs'),
          type: 'reasoning',
          summary: [{ type: 'summary_text', text }],
        });
      }
    }

    if (msg && msg.content) {
      // content 可能是字符串，也可能是数组（多模态：含 text 和 image_url 块）
      const msgContent = Array.isArray(msg.content)
        ? msg.content.map(p => {
            if (p.type === 'text') return { type: 'output_text', text: p.text, annotations: [] };
            if (p.type === 'image_url') {
              const url = typeof p.image_url === 'string' ? p.image_url : p.image_url?.url;
              return url ? { type: 'output_image', image_url: url } : null;
            }
            return null;
          }).filter(Boolean)
        : [{ type: 'output_text', text: msg.content, annotations: [] }];
      if (msgContent.length > 0) {
        output.push({
          id: uid('msg'),
          object: 'realtime.item',
          type: 'message',
          role: 'assistant',
          status: 'completed',
          content: msgContent,
        });
      }
    }

    if (msg && Array.isArray(msg.tool_calls)) {
      for (const tc of msg.tool_calls) {
        let args = typeof tc.function.arguments === 'string'
          ? tc.function.arguments
          : JSON.stringify(tc.function.arguments || {});
        const isFreeform = freeformTools && freeformTools.includes(tc.function.name);
        // freeform 工具参数解包
        if (isFreeform) {
          dbg(`[c2r] convertResponse freeform: name="${tc.function.name}" rawArgs=${args.slice(0, 200)}`);
          args = unwrapFreeformArgs(args);
        }
        // namespace 工具名拆分：mcp__node_repl__js → namespace="mcp__node_repl", name="js"
        // 也支持模型返回短名 js 的情况：反向查找 childName
        const nsResult = resolveNamespace(tc.function.name, namespaceMap);
        let toolName = nsResult.displayName;
        let { namespace, isNamespaceCustom } = nsResult;
        if (namespace && isNamespaceCustom) {
          // custom 类型子工具：参数解包（从 {"input": "..."} 中提取原始文本）
          args = unwrapFreeformArgs(args);
          dbg(`[c2r] convertResponse namespace custom: "${tc.function.name}" → namespace="${namespace}" name="${toolName}"`);
        } else if (namespace) {
          dbg(`[c2r] convertResponse namespace function: "${tc.function.name}" → namespace="${namespace}" name="${toolName}"`);
        }
        output.push(makeToolCallItem(toolName, tc.id || uid('call'), args, isFreeform || isNamespaceCustom, namespace));
      }
    }
  }

  const usage = body.usage
    ? {
        input_tokens: body.usage.prompt_tokens || 0,
        output_tokens: body.usage.completion_tokens || 0,
        total_tokens: body.usage.total_tokens || 0,
      }
    : {};

  return {
    id: uid('resp'),
    object: 'response',
    status: 'completed',
    model: body.model || '',
    output,
    usage,
  };
}

// ─── 流式 SSE 转换器 ────────────────────────────────────────

function createSSEConverter(targetModel, freeformTools, namespaceMap) {
  const responseId = uid('resp');
  let createdSent = false;
  let done = false;
  let outputIndex = -1;
  let textStarted = false;
  let textItemId = null;
  let accumulatedText = '';
  // reasoning（chat reasoning_content → responses reasoning item）
  let reasoningStarted = false;
  let reasoningItemId = null;
  let reasoningOutputIndex = -1; // reasoning item 起始 output_index 快照，避免被后续 text/tool 递增污染
  let reasoningSummaryPartSent = false;
  let accumulatedReasoning = '';
  let usageData = null;
  const tcBuf = new Map(); // Chat Completions tool_call.index → state
  const outputItems = [];

  function setUsage(u) { if (u) usageData = u; }

  function emit(type, data) {
    return encodeAnthropicEvent(type, data);
  }

  function emitCreated() {
    createdSent = true;
    let result = emit('response.created', {
      type: 'response.created',
      response: {
        id: responseId,
        object: 'response',
        model: targetModel || '',
        status: 'in_progress',
        output: [],
      },
    });
    result += emit('response.in_progress', {
      type: 'response.in_progress',
      response: {
        id: responseId,
        object: 'response',
        model: targetModel || '',
        status: 'in_progress',
        output: [],
      },
    });
    return result;
  }

  // chat reasoning_content → responses reasoning item（思维链摘要）
  // 注意：chat 流里 reasoning_content 和 content 可能交替出现（DeepSeek/Qwen）。
  // 这里用 reasoningOutputIndex 快照保证 reasoning 事件 index 始终指向 reasoning item，
  // 不会因后续 text/tool 的 outputIndex++ 而错位。多段 reasoning 合并到同一个 reasoning item。
  function handleReasoningDelta(text) {
    let result = '';
    if (!reasoningStarted) {
      reasoningStarted = true;
      outputIndex++;
      reasoningOutputIndex = outputIndex; // 快照：本 reasoning item 固定用这个 index
      reasoningItemId = uid('rs');
      const item = { id: reasoningItemId, type: 'reasoning', summary: [] };
      outputItems.push(item);
      result += emit('response.output_item.added', {
        type: 'response.output_item.added',
        output_index: reasoningOutputIndex,
        item,
      });
    }
    accumulatedReasoning += text;
    if (!reasoningSummaryPartSent) {
      reasoningSummaryPartSent = true;
      result += emit('response.reasoning_summary_part.added', {
        type: 'response.reasoning_summary_part.added',
        output_index: reasoningOutputIndex,
        summary_index: 0,
        part: { type: 'summary_text', text: '' },
      });
    }
    result += emit('response.reasoning_summary_text.delta', {
      type: 'response.reasoning_summary_text.delta',
      output_index: reasoningOutputIndex,
      summary_index: 0,
      delta: text,
    });
    return result;
  }

  function emitReasoningDone() {
    if (!reasoningStarted) return '';
    reasoningStarted = false;
    reasoningSummaryPartSent = false; // 复位，支持后续重新开启 reasoning item
    const item = outputItems.find(i => i.id === reasoningItemId);
    if (item) item.summary = [{ type: 'summary_text', text: accumulatedReasoning }];
    let result = '';
    result += emit('response.reasoning_summary_text.done', {
      type: 'response.reasoning_summary_text.done',
      output_index: reasoningOutputIndex,
      summary_index: 0,
      text: accumulatedReasoning,
    });
    result += emit('response.reasoning_summary_part.done', {
      type: 'response.reasoning_summary_part.done',
      output_index: reasoningOutputIndex,
      summary_index: 0,
      part: { type: 'summary_text', text: accumulatedReasoning },
    });
    result += emit('response.output_item.done', {
      type: 'response.output_item.done',
      output_index: reasoningOutputIndex,
      item: item || { id: reasoningItemId, type: 'reasoning', summary: [{ type: 'summary_text', text: accumulatedReasoning }] },
    });
    accumulatedReasoning = ''; // 清零：text 开始后若再出现 reasoning，可重新开启独立 item
    return result;
  }

  function handleTextDelta(content) {
    let result = '';

    // text 开始前若 reasoning 仍在进行，先关闭它，保证 reasoning/text 的 added/done 配对顺序
    // （chat 流里 reasoning_content 和 content 可能交替出现）
    if (!textStarted && reasoningStarted) {
      result += emitReasoningDone();
    }

    if (!textStarted) {
      textStarted = true;
      outputIndex++;
      textItemId = uid('msg');

      const item = {
        id: textItemId,
        object: 'realtime.item',
        type: 'message',
        role: 'assistant',
        status: 'in_progress',
        content: [{ type: 'output_text', text: '', annotations: [] }],
      };
      outputItems.push(item);

      result += emit('response.output_item.added', {
        type: 'response.output_item.added',
        output_index: outputIndex,
        item,
      });

      result += emit('response.content_part.added', {
        type: 'response.content_part.added',
        output_index: outputIndex,
        content_index: 0,
        part: { type: 'output_text', text: '', annotations: [] },
      });
    }

    accumulatedText += content;

    result += emit('response.output_text.delta', {
      type: 'response.output_text.delta',
      output_index: outputIndex,
      content_index: 0,
      delta: content,
    });

    return result;
  }

  function emitTextDone() {
    if (!textStarted) return '';
    textStarted = false;

    // 兜底：检查累积文本里是否有 freeform XML 工具调用
    const { calls: xmlCalls, cleanedText } = extractFreeformToolCalls(accumulatedText);

    const item = outputItems.find(i => i.id === textItemId);
    let result = '';

    if (xmlCalls.length > 0 && cleanedText.length === 0) {
      // 文本全是 XML 工具调用 → 跳过 message item，发 function_call items 替代
      const idx = outputItems.findIndex(i => i.id === textItemId);
      if (idx >= 0) outputItems.splice(idx, 1);
      result += emitXmlToolCalls(xmlCalls);
      return result;
    }

    const finalText = xmlCalls.length > 0 ? cleanedText : accumulatedText;
    if (item) {
      item.status = 'completed';
      item.content[0].text = finalText;
    }
    result += emit('response.output_text.done', {
      type: 'response.output_text.done',
      output_index: outputIndex,
      content_index: 0,
      text: finalText,
    });
    result += emit('response.content_part.done', {
      type: 'response.content_part.done',
      output_index: outputIndex,
      content_index: 0,
      part: { type: 'output_text', text: finalText, annotations: [] },
    });
    result += emit('response.output_item.done', {
      type: 'response.output_item.done',
      output_index: outputIndex,
      item: item || { id: textItemId },
    });
    if (xmlCalls.length > 0) {
      result += emitXmlToolCalls(xmlCalls);
    }
    return result;
  }

  // 把 freeform XML 提取的工具调用转成 function_call items
  function emitXmlToolCalls(calls) {
    let result = '';
    for (const call of calls) {
      outputIndex++;
      const callId = uid('call');
      const fcItem = {
        id: uid('fc'),
        object: 'realtime.item',
        type: 'function_call',
        status: 'completed',
        call_id: callId,
        name: call.name,
        arguments: JSON.stringify(call.arguments),
      };
      outputItems.push(fcItem);
      result += emit('response.output_item.added', {
        type: 'response.output_item.added',
        output_index: outputIndex,
        item: fcItem,
      });
      result += emit('response.function_call_arguments.done', {
        type: 'response.function_call_arguments.done',
        output_index: outputIndex,
        call_id: callId,
        arguments: JSON.stringify(call.arguments),
      });
      result += emit('response.output_item.done', {
        type: 'response.output_item.done',
        output_index: outputIndex,
        item: fcItem,
      });
    }
    return result;
  }

  function handleToolCallDelta(tc) {
    const idx = tc.index;
    let result = '';

    if (!tcBuf.has(idx)) {
      outputIndex++;
      const callId = tc.id || uid('call');
      const state = {
        id: uid('func'),
        call_id: callId,
        name: '',
        arguments: '',
        nameDone: false,
        outputIndex,
      };
      tcBuf.set(idx, state);

      // 占位 item，type/name 在 name 确定后更新
      outputItems.push({
        id: state.id,
        object: 'realtime.item',
        type: 'function_call',
        name: '',
        call_id: callId,
        arguments: '',
        status: 'in_progress',
      });
    }

    const buf = tcBuf.get(idx);

    // 函数名（首次出现时 emit added）
    const fnName = tc.function && tc.function.name;
    if (fnName && !buf.nameDone) {
      buf.name = fnName;
      buf.isFreeform = freeformTools && freeformTools.includes(fnName);
      // namespace 工具名拆分：mcp__node_repl__js → namespace="mcp__node_repl", name="js"
      // 也支持模型返回短名 js 的情况：反向查找 childName
      const nsResult = resolveNamespace(fnName, namespaceMap);
      buf.namespace = nsResult.namespace;
      buf.displayName = nsResult.displayName;
      buf.isNamespaceCustom = nsResult.isNamespaceCustom;
      if (nsResult.namespace) {
        dbg(`[c2r] tool_call namespace: "${fnName}" → namespace="${buf.namespace}" name="${buf.displayName}" custom=${buf.isNamespaceCustom}`);
      }
      const isCustom = buf.isFreeform || buf.isNamespaceCustom;
      buf.nameDone = true;
      dbg(`[c2r] tool_call name="${fnName}" idx=${idx} isFreeform=${buf.isFreeform} isNamespaceCustom=${buf.isNamespaceCustom} namespace="${buf.namespace}" freeformTools=${JSON.stringify(freeformTools)}`);

      const item = outputItems.find(i => i.id === buf.id);
      if (item) {
        item.name = buf.displayName;
        if (buf.namespace) item.namespace = buf.namespace;
        // freeform/namespace-custom 工具使用 custom_tool_call 类型，字段名 input
        if (isCustom) {
          item.type = 'custom_tool_call';
          item.input = '';
          delete item.arguments;
        }
      }

      // output_item.added 中 item 的类型
      const baseItem = { id: buf.id, object: 'realtime.item', call_id: buf.call_id };
      if (buf.namespace) baseItem.namespace = buf.namespace;
      const addedItem = isCustom
        ? { ...baseItem, type: 'custom_tool_call', name: buf.displayName, input: '' }
        : { ...baseItem, type: 'function_call', name: buf.displayName, arguments: '' };

      result += emit('response.output_item.added', {
        type: 'response.output_item.added',
        output_index: buf.outputIndex,
        item: addedItem,
      });
    }

    // 参数增量
    const fnArgs = tc.function && tc.function.arguments;
    if (fnArgs) {
      buf.arguments += fnArgs;

      if (buf.isFreeform || buf.isNamespaceCustom) {
        // freeform/namespace-custom 工具跳过 delta（参数是 JSON 包裹，完成时解包后通过 custom_tool_call_input.delta 发送）
        // 不发任何 delta 事件
      } else {
        const item = outputItems.find(i => i.id === buf.id);
        if (item) item.arguments = buf.arguments;

        result += emit('response.function_call_arguments.delta', {
          type: 'response.function_call_arguments.delta',
          output_index: buf.outputIndex,
          call_id: buf.call_id,
          delta: fnArgs,
        });
      }
    }

    return result;
  }

  function emitToolCallDone(idx) {
    const buf = tcBuf.get(idx);
    if (!buf) return '';

    const displayName = buf.displayName || buf.name;
    const ns = buf.namespace || '';
    const isCustom = buf.isFreeform || buf.isNamespaceCustom;

    dbg(`[c2r] tool_call DONE: name="${buf.name}" displayName="${displayName}" namespace="${ns}" idx=${idx} isFreeform=${buf.isFreeform} isNamespaceCustom=${buf.isNamespaceCustom} rawArgs=${buf.arguments.slice(0, 300)}`);

    // freeform/namespace-custom 工具参数解包：从 JSON 包裹中提取原始文本
    if (isCustom) {
      const rawArgs = buf.arguments;
      buf.arguments = unwrapFreeformArgs(buf.arguments);
      if (buf.arguments !== rawArgs) {
        dbg(`[c2r] custom unwrap: len=${buf.arguments.length}`);
      } else if (rawArgs) {
        dbg(`[c2r] custom unwrap: kept raw (not JSON or no string value)`);
      }

      // 发送 custom_tool_call_input.delta（整块发送解包后的参数）
      const item = outputItems.find(i => i.id === buf.id);
      if (item) {
        item.input = buf.arguments;
        item.status = 'completed';
      }

      // 先发 delta（完整参数），再发 done
      let result = '';
      if (buf.arguments) {
        result += emit('response.custom_tool_call_input.delta', {
          type: 'response.custom_tool_call_input.delta',
          output_index: buf.outputIndex,
          call_id: buf.call_id,
          delta: buf.arguments,
        });
      }

      const fallbackItem = { id: buf.id, type: 'custom_tool_call', name: displayName, call_id: buf.call_id, input: buf.arguments };
      if (ns) fallbackItem.namespace = ns;
      result += emit('response.output_item.done', {
        type: 'response.output_item.done',
        output_index: buf.outputIndex,
        item: item || fallbackItem,
      });
      return result;
    }

    const item = outputItems.find(i => i.id === buf.id);
    if (item) item.status = 'completed';

    const fallbackItem = { id: buf.id };
    if (ns) fallbackItem.namespace = ns;
    return emit('response.output_item.done', {
      type: 'response.output_item.done',
      output_index: buf.outputIndex,
      item: item || fallbackItem,
    });
  }

  function finish() {
    if (done) return '';
    done = true;

    let result = '';
    result += emitReasoningDone();
    result += emitTextDone();

    // 按 index 顺序完成所有 tool_calls
    const sortedIdx = [...tcBuf.keys()].sort((a, b) => a - b);
    for (const idx of sortedIdx) {
      result += emitToolCallDone(idx);
    }

    const responseObj = {
      id: responseId,
      object: 'response',
      model: targetModel || '',
      status: 'completed',
      output: outputItems,
    };
    if (usageData) {
      responseObj.usage = usageData;
    }

    result += emit('response.completed', {
      type: 'response.completed',
      response: responseObj,
    });
    result += encodeDone();

    return result;
  }

  // ─── 主接口 ─────────────────────────────────────────────

  let buffer = '';

  return {
    setUsage,
    getReasoningText() { return accumulatedReasoning; },
    convertChunk(chunkText) {
      if (done) return '';

      buffer += chunkText;
      let result = '';

      // 按行解析
      const lines = buffer.split('\n');
      // 最后一行可能是不完整的，保留到下次
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith(':')) continue;

        if (trimmed === 'data: [DONE]') {
          result += finish();
          continue;
        }

        if (!trimmed.startsWith('data: ')) continue;

        const dataStr = trimmed.slice(6);
        let data;
        try {
          data = JSON.parse(dataStr);
        } catch {
          continue;
        }

        if (!createdSent) {
          result += emitCreated();
        }

        const choice = data.choices && data.choices[0];

        // chat 末块的 usage（OpenAI 流式带 include_usage 时在此块返回）
        if (data.usage) {
          usageData = {
            input_tokens: data.usage.prompt_tokens || data.usage.input_tokens || 0,
            output_tokens: data.usage.completion_tokens || data.usage.output_tokens || 0,
            total_tokens: data.usage.total_tokens || 0,
          };
        }

        if (!choice) continue;

        const delta = choice.delta;
        if (delta) {
          // reasoning_content → responses reasoning summary（思维链摘要）
          if (delta.reasoning_content) {
            result += handleReasoningDelta(delta.reasoning_content);
          }

          if (delta.content) {
            result += handleTextDelta(delta.content);
          }

          if (Array.isArray(delta.tool_calls)) {
            for (const tc of delta.tool_calls) {
              result += handleToolCallDelta(tc);
            }
          }
        }

        if (choice.finish_reason) {
          result += finish();
        }
      }

      return result;
    },

    flush() {
      if (buffer) {
        // 处理缓冲区剩余内容
        let result = '';
        if (buffer.startsWith('data: ')) {
          const dataStr = buffer.slice(6).trim();
          if (dataStr !== '[DONE]') {
            try {
              const data = JSON.parse(dataStr);
              if (!createdSent) result += emitCreated();
              if (data.usage) {
                usageData = {
                  input_tokens: data.usage.prompt_tokens || data.usage.input_tokens || 0,
                  output_tokens: data.usage.completion_tokens || data.usage.output_tokens || 0,
                  total_tokens: data.usage.total_tokens || 0,
                };
              }
              const choice = data.choices && data.choices[0];
              if (choice && choice.delta) {
                if (choice.delta.reasoning_content) result += handleReasoningDelta(choice.delta.reasoning_content);
                if (choice.delta.content) result += handleTextDelta(choice.delta.content);
                if (Array.isArray(choice.delta.tool_calls)) {
                  for (const tc of choice.delta.tool_calls) result += handleToolCallDelta(tc);
                }
              }
            } catch { /* ignore */ }
          }
        }
        buffer = '';
        return result + finish();
      }
      return finish();
    },
  };
}

module.exports = { convertRequest, convertResponse, createSSEConverter, setDebugLogger };
