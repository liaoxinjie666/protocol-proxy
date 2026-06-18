/**
 * Anthropic SSE → Responses API SSE 直接转换器
 *
 * 用于 responses→anthropic 流式路径，避免 a2o + c2r 双层转换的格式不兼容问题
 */

const { encodeAnthropicEvent, encodeDone, unwrapFreeformArgs, resolveNamespace } = require('./sse-helpers');

let _debugLog = null;
function dbg(...args) { if (_debugLog) _debugLog(...args); }
function setDebugLogger(fn) { _debugLog = fn; }

function uid(prefix) {
  const hex = Date.now().toString(16) + Math.random().toString(16).slice(2, 14);
  return `${prefix}_${hex.padEnd(24, '0').slice(0, 24)}`;
}

function createSSEConverter(targetModel, freeformTools, namespaceMap) {
  const responseId = uid('resp');
  let done = false;
  let createdSent = false;
  let outputIndex = -1;
  let textStarted = false;
  let textItemId = null;
  let accumulatedText = '';
  // reasoning（thinking）状态：把 anthropic thinking 内容转成 responses 的 reasoning item
  // 跨源降级：只传思维链摘要文本，丢弃 anthropic signature（跨厂商无意义）
  let reasoningStarted = false;
  let reasoningItemId = null;
  let reasoningOutputIndex = -1; // reasoning item 起始 output_index 快照，避免被后续 text/tool 递增污染
  let reasoningSummaryPartSent = false;
  let accumulatedReasoning = '';
  let usageData = null; // 外部通过 setUsage 注入，用于 response.completed
  const thinkingBlockIndexes = new Set(); // 记录 anthropic thinking content_block 的 index
  const toolBuf = new Map(); // Anthropic tool_use blockIndex → state
  const outputItems = [];
  let buffer = '';

  // 外部注入 usage（来自 anthropic message_delta 的 usage 字段），用于 response.completed
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
    // OpenAI Responses 标准序列：created 后紧跟 in_progress（状态心跳）
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

  // ─── reasoning（anthropic thinking → responses reasoning item）─────────
  // 跨源降级：只把 thinking 文本作为 reasoning summary 回传给 Codex，
  // 不携带 anthropic signature（跨厂商无意义）。
  // 注意：reasoning 的事件统一用 reasoningOutputIndex 快照，不能用全局 outputIndex，
  // 否则 reasoning 之后再来 text/tool 时，reasoning 的 done 事件会指向错误的 index。
  function handleReasoningDelta(text) {
    let result = '';
    if (!reasoningStarted) {
      reasoningStarted = true;
      outputIndex++;
      reasoningOutputIndex = outputIndex; // 快照：本 reasoning item 固定用这个 index
      reasoningItemId = uid('rs');
      const item = {
        id: reasoningItemId,
        type: 'reasoning',
        summary: [],
      };
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
    if (item) {
      item.summary = [{ type: 'summary_text', text: accumulatedReasoning }];
    }
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
    return result;
  }

  function handleTextDelta(text) {
    let result = '';
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
    accumulatedText += text;
    result += emit('response.output_text.delta', {
      type: 'response.output_text.delta',
      output_index: outputIndex,
      content_index: 0,
      delta: text,
    });
    return result;
  }

  function emitTextDone() {
    if (!textStarted) return '';
    textStarted = false;
    const item = outputItems.find(i => i.id === textItemId);
    if (item) {
      item.status = 'completed';
      item.content[0].text = accumulatedText;
    }
    let result = '';
    // 补发 OpenAI Responses 标准序列里文本块结束的两个事件
    result += emit('response.output_text.done', {
      type: 'response.output_text.done',
      output_index: outputIndex,
      content_index: 0,
      text: accumulatedText,
    });
    result += emit('response.content_part.done', {
      type: 'response.content_part.done',
      output_index: outputIndex,
      content_index: 0,
      part: { type: 'output_text', text: accumulatedText, annotations: [] },
    });
    result += emit('response.output_item.done', {
      type: 'response.output_item.done',
      output_index: outputIndex,
      item: item || { id: textItemId },
    });
    return result;
  }

  function handleToolUseStart(blockIndex, toolUseId, name) {
    outputIndex++;
    const isFreeform = freeformTools && freeformTools.includes(name);
    // namespace 工具名拆分：mcp__node_repl__js → namespace="mcp__node_repl", name="js"
    // 也支持模型返回短名 js（无前缀）的情况：反向查找 childName
    const { namespace, displayName, isNamespaceCustom } = resolveNamespace(name, namespaceMap);
    if (namespace) {
      dbg(`[a2r] tool_use namespace: "${name}" → namespace="${namespace}" name="${displayName}" custom=${isNamespaceCustom}`);
    }
    const isCustom = isFreeform || isNamespaceCustom;
    dbg(`[a2r] tool_use START: name="${name}" displayName="${displayName}" namespace="${namespace}" id="${toolUseId}" blockIndex=${blockIndex} isFreeform=${isFreeform} isNamespaceCustom=${isNamespaceCustom}`);
    const state = {
      id: uid('func'),
      call_id: toolUseId || uid('call'),
      name: displayName,
      namespace,
      isFreeform,
      isNamespaceCustom,
      arguments: '',
      outputIndex,
    };
    toolBuf.set(blockIndex, state);

    // freeform/namespace-custom 工具使用 custom_tool_call 类型，字段名 input
    const baseItem = { id: state.id, object: 'realtime.item', call_id: state.call_id, status: 'in_progress' };
    if (namespace) baseItem.namespace = namespace;
    const item = isCustom
      ? { ...baseItem, type: 'custom_tool_call', name: displayName, input: '' }
      : { ...baseItem, type: 'function_call', name: displayName, arguments: '' };
    outputItems.push(item);

    return emit('response.output_item.added', {
      type: 'response.output_item.added',
      output_index: state.outputIndex,
      item,
    });
  }

  function handleToolInputDelta(blockIndex, partialJson) {
    const state = toolBuf.get(blockIndex);
    if (!state) return '';
    state.arguments += partialJson;
    dbg(`[a2r] tool_input_delta: name="${state.name}" blockIndex=${blockIndex} partialLen=${partialJson.length} totalLen=${state.arguments.length} isFreeform=${state.isFreeform}`);
    // freeform 工具跳过 delta 事件（完成时通过 custom_tool_call_input.delta 整块发送）
    if (!state.isFreeform && !state.isNamespaceCustom) {
      const item = outputItems.find(i => i.id === state.id);
      if (item) item.arguments = state.arguments;
      return emit('response.function_call_arguments.delta', {
        type: 'response.function_call_arguments.delta',
        output_index: state.outputIndex,
        call_id: state.call_id,
        delta: partialJson,
      });
    }
    return '';
  }

  function emitToolDone(blockIndex) {
    const state = toolBuf.get(blockIndex);
    if (!state) return '';

    const ns = state.namespace || '';

    const isCustom = state.isFreeform || state.isNamespaceCustom;
    dbg(`[a2r] tool DONE: name="${state.name}" namespace="${ns}" blockIndex=${blockIndex} isFreeform=${state.isFreeform} isNamespaceCustom=${state.isNamespaceCustom} rawArgs=${state.arguments.slice(0, 300)}`);

    if (isCustom) {
      // freeform 工具参数解包：从 JSON 包裹中提取原始文本
      const rawArgs = state.arguments;
      state.arguments = unwrapFreeformArgs(state.arguments);
      if (state.arguments !== rawArgs) {
        dbg(`[a2r] freeform unwrap: len=${state.arguments.length}`);
      } else if (rawArgs) {
        dbg(`[a2r] freeform unwrap: kept raw (not JSON or no string value)`);
      }

      const item = outputItems.find(i => i.id === state.id);
      if (item) {
        item.input = state.arguments;
        item.status = 'completed';
      }

      dbg(`[a2r] freeform emitting: custom_tool_call_input.delta + output_item.done, inputLen=${state.arguments.length} input=${state.arguments.slice(0, 200)}`);

      // 先发 custom_tool_call_input.delta，再发 output_item.done
      let result = '';
      if (state.arguments) {
        result += emit('response.custom_tool_call_input.delta', {
          type: 'response.custom_tool_call_input.delta',
          output_index: state.outputIndex,
          call_id: state.call_id,
          delta: state.arguments,
        });
      }
      const fallbackItem = { id: state.id, type: 'custom_tool_call', name: state.name, call_id: state.call_id, input: state.arguments };
      if (ns) fallbackItem.namespace = ns;
      result += emit('response.output_item.done', {
        type: 'response.output_item.done',
        output_index: state.outputIndex,
        item: item || fallbackItem,
      });
      return result;
    }

    const item = outputItems.find(i => i.id === state.id);
    if (item) item.status = 'completed';
    const fallbackItem = { id: state.id };
    if (ns) fallbackItem.namespace = ns;
    return emit('response.output_item.done', {
      type: 'response.output_item.done',
      output_index: state.outputIndex,
      item: item || fallbackItem,
    });
  }

  function finish() {
    if (done) return '';
    done = true;
    let result = '';
    result += emitReasoningDone();
    result += emitTextDone();
    for (const [idx] of [...toolBuf.entries()].sort((a, b) => a[0] - b[0])) {
      result += emitToolDone(idx);
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
    // OpenAI Responses 客户端通常依赖 data: [DONE] 判断传输层流结束
    result += encodeDone();
    return result;
  }

  return {
    setUsage,
    getReasoningText() { return accumulatedReasoning; },
    convertChunk(chunkText) {
      if (done) return '';
      buffer += chunkText;
      let result = '';
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith(':')) continue;

        // Anthropic SSE: "event: <type>\ndata: <json>"
        let eventType = '';
        let dataStr = '';
        if (trimmed.startsWith('event: ')) {
          eventType = trimmed.slice(7).trim();
          continue; // data 行在下一行
        }
        if (trimmed.startsWith('data: ')) {
          dataStr = trimmed.slice(6).trim();
        } else {
          continue;
        }

        let data;
        try { data = JSON.parse(dataStr); } catch { continue; }

        // 用 data.type 作为事件类型（Anthropic 在 data 里也带 type）
        const et = data.type || eventType;

        // 记录所有事件类型（用于调试模型是否生成 tool_use）
        if (et !== 'content_block_delta') {
          const extra = et === 'content_block_start' ? ` blockType=${data.content_block?.type} name=${data.content_block?.name || '(none)'} id=${data.content_block?.id || '(none)'}` : '';
          dbg(`[a2r] ← event: ${et}${extra}`);
        }

        switch (et) {
          case 'message_start':
            if (!createdSent) result += emitCreated();
            break;

          case 'content_block_start': {
            if (!createdSent) result += emitCreated();
            const cb = data.content_block;
            if (cb?.type === 'tool_use') {
              result += handleToolUseStart(data.index, cb.id, cb.name);
            } else if (cb?.type === 'thinking') {
              // 记录 thinking 块 index，content_block_stop 时用于收尾 reasoning
              thinkingBlockIndexes.add(data.index);
            }
            // text block 的 delta 会在 content_block_delta 中处理
            break;
          }

          case 'content_block_delta': {
            const delta = data.delta;
            if (delta?.type === 'text_delta' && delta.text) {
              result += handleTextDelta(delta.text);
            } else if (delta?.type === 'input_json_delta' && delta.partial_json) {
              result += handleToolInputDelta(data.index, delta.partial_json);
            } else if (delta?.type === 'thinking_delta' && delta.thinking) {
              // anthropic thinking 文本 → responses reasoning summary（跨源降级，不带 signature）
              result += handleReasoningDelta(delta.thinking);
            }
            // signature_delta：anthropic 专有加密状态，跨协议无意义，丢弃
            break;
          }

          case 'content_block_stop':
            // thinking 块结束 → 收尾 reasoning item
            if (thinkingBlockIndexes.has(data.index)) {
              thinkingBlockIndexes.delete(data.index);
              result += emitReasoningDone();
            } else if (textStarted && !toolBuf.has(data.index)) {
              // text block 结束时 emit text done
              result += emitTextDone();
            }
            break;

          case 'message_delta': {
            // anthropic 的 usage（input_tokens/output_tokens）在 message_delta 里
            const u = data.usage;
            if (u) {
              usageData = {
                input_tokens: u.input_tokens || 0,
                output_tokens: u.output_tokens || 0,
                total_tokens: (u.input_tokens || 0) + (u.output_tokens || 0),
              };
            }
            break;
          }

          case 'message_stop':
            dbg(`[a2r] message_stop: toolBuf.size=${toolBuf.size} outputItems=${outputItems.map(i => `${i.type}:${i.name}`).join(',')}`);
            result += finish();
            break;
        }
      }

      return result;
    },

    flush() {
      if (buffer) {
        // 尝试处理剩余 buffer
        let result = '';
        if (buffer.startsWith('data: ')) {
          try {
            const data = JSON.parse(buffer.slice(6).trim());
            if (data.type === 'message_stop') result += finish();
          } catch { /* ignore */ }
        }
        buffer = '';
        return result || finish();
      }
      return finish();
    },
  };
}

module.exports = { createSSEConverter, setDebugLogger };