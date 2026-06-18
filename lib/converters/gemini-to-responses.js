/**
 * Gemini SSE → Responses API SSE 直接转换器
 *
 * 用于 responses→gemini 流式路径，避免 o2g + c2r 双层转换的格式不兼容问题
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
  const toolBuf = new Map(); // functionCall key → state
  const outputItems = [];
  let usageData = null;
  // reasoning（gemini thought → responses reasoning item）
  let reasoningStarted = false;
  let reasoningItemId = null;
  let reasoningOutputIndex = -1;
  let reasoningSummaryPartSent = false;
  let accumulatedReasoning = '';
  let buffer = '';

  function setUsage(u) { if (u) usageData = u; }

  // gemini thought（part.thought===true）→ responses reasoning summary
  function handleReasoningDelta(text) {
    let result = '';
    if (!reasoningStarted) {
      reasoningStarted = true;
      outputIndex++;
      reasoningOutputIndex = outputIndex;
      reasoningItemId = uid('rs');
      const item = { id: reasoningItemId, type: 'reasoning', summary: [] };
      outputItems.push(item);
      result += emit('response.output_item.added', {
        type: 'response.output_item.added', output_index: reasoningOutputIndex, item,
      });
    }
    accumulatedReasoning += text;
    if (!reasoningSummaryPartSent) {
      reasoningSummaryPartSent = true;
      result += emit('response.reasoning_summary_part.added', {
        type: 'response.reasoning_summary_part.added', output_index: reasoningOutputIndex,
        summary_index: 0, part: { type: 'summary_text', text: '' },
      });
    }
    result += emit('response.reasoning_summary_text.delta', {
      type: 'response.reasoning_summary_text.delta', output_index: reasoningOutputIndex,
      summary_index: 0, delta: text,
    });
    return result;
  }

  function emitReasoningDone() {
    if (!reasoningStarted) return '';
    reasoningStarted = false;
    reasoningSummaryPartSent = false;
    const item = outputItems.find(i => i.id === reasoningItemId);
    if (item) item.summary = [{ type: 'summary_text', text: accumulatedReasoning }];
    let result = '';
    result += emit('response.reasoning_summary_text.done', {
      type: 'response.reasoning_summary_text.done', output_index: reasoningOutputIndex,
      summary_index: 0, text: accumulatedReasoning,
    });
    result += emit('response.reasoning_summary_part.done', {
      type: 'response.reasoning_summary_part.done', output_index: reasoningOutputIndex,
      summary_index: 0, part: { type: 'summary_text', text: accumulatedReasoning },
    });
    result += emit('response.output_item.done', {
      type: 'response.output_item.done', output_index: reasoningOutputIndex,
      item: item || { id: reasoningItemId, type: 'reasoning', summary: [{ type: 'summary_text', text: accumulatedReasoning }] },
    });
    accumulatedReasoning = ''; // 清零：支持后续重新开启 reasoning item
    return result;
  }

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

  function handleTextDelta(text) {
    let result = '';
    // text 开始前若 reasoning 仍在进行，先关闭它，保证 reasoning/text 的 added/done 配对顺序
    if (!textStarted && reasoningStarted) {
      result += emitReasoningDone();
    }
    if (!textStarted) {
      textStarted = true;
      outputIndex++;
      textItemId = uid('msg');
      const item = {
        id: textItemId, object: 'realtime.item', type: 'message',
        role: 'assistant', status: 'in_progress',
        content: [{ type: 'output_text', text: '', annotations: [] }],
      };
      outputItems.push(item);
      result += emit('response.output_item.added', {
        type: 'response.output_item.added', output_index: outputIndex, item,
      });
      result += emit('response.content_part.added', {
        type: 'response.content_part.added', output_index: outputIndex,
        content_index: 0, part: { type: 'output_text', text: '', annotations: [] },
      });
    }
    accumulatedText += text;
    result += emit('response.output_text.delta', {
      type: 'response.output_text.delta', output_index: outputIndex,
      content_index: 0, delta: text,
    });
    return result;
  }

  function emitTextDone() {
    if (!textStarted) return '';
    textStarted = false;
    const item = outputItems.find(i => i.id === textItemId);
    if (item) { item.status = 'completed'; item.content[0].text = accumulatedText; }
    let result = '';
    result += emit('response.output_text.done', {
      type: 'response.output_text.done', output_index: outputIndex,
      content_index: 0, text: accumulatedText,
    });
    result += emit('response.content_part.done', {
      type: 'response.content_part.done', output_index: outputIndex,
      content_index: 0, part: { type: 'output_text', text: accumulatedText, annotations: [] },
    });
    result += emit('response.output_item.done', {
      type: 'response.output_item.done', output_index: outputIndex,
      item: item || { id: textItemId },
    });
    return result;
  }

  function handleFunctionCall(name, args) {
    let finalArgs = args;
    const isFreeform = freeformTools && freeformTools.includes(name);
    // namespace 工具名拆分：mcp__node_repl__js → namespace="mcp__node_repl", name="js"
    // 也支持模型返回短名 js 的情况：反向查找 childName
    const { namespace, displayName, isNamespaceCustom } = resolveNamespace(name, namespaceMap);
    if (namespace) {
      dbg(`[g2r] function_call namespace: "${name}" → namespace="${namespace}" name="${displayName}" custom=${isNamespaceCustom}`);
    }
    const isCustom = isFreeform || isNamespaceCustom;
    dbg(`[g2r] function_call: name="${name}" displayName="${displayName}" namespace="${namespace}" isFreeform=${isFreeform} isNamespaceCustom=${isNamespaceCustom} rawArgs=${(args || '').slice(0, 300)}`);

    // freeform/namespace-custom 工具参数解包
    if (isCustom) {
      finalArgs = unwrapFreeformArgs(args);
      if (finalArgs !== args) {
        dbg(`[g2r] custom unwrap: len=${finalArgs.length}`);
      }
    }

    outputIndex++;
    const callId = uid('call');
    const state = { id: uid('func'), call_id: callId, name: displayName, namespace, arguments: finalArgs, outputIndex };
    toolBuf.set(name + outputIndex, state);

    // freeform/namespace-custom 工具使用 custom_tool_call 类型，字段名 input
    const baseItem = { id: state.id, object: 'realtime.item', call_id: callId, status: 'completed' };
    if (namespace) baseItem.namespace = namespace;
    let item;
    if (isCustom) {
      item = { ...baseItem, type: 'custom_tool_call', name: displayName, input: finalArgs };
    } else {
      item = { ...baseItem, type: 'function_call', name: displayName, arguments: finalArgs };
    }
    outputItems.push(item);

    let result = emit('response.output_item.added', {
      type: 'response.output_item.added', output_index: outputIndex, item,
    });

    // custom 工具先发 custom_tool_call_input.delta
    if (isCustom && finalArgs) {
      result += emit('response.custom_tool_call_input.delta', {
        type: 'response.custom_tool_call_input.delta',
        output_index: outputIndex, call_id: callId, delta: finalArgs,
      });
    }

    result += emit('response.output_item.done', {
      type: 'response.output_item.done', output_index: outputIndex, item,
    });
    return result;
  }

  function finish() {
    if (done) return '';
    done = true;
    let result = '';
    result += emitReasoningDone();
    result += emitTextDone();
    const responseObj = {
      id: responseId, object: 'response',
      model: targetModel || '', status: 'completed', output: outputItems,
    };
    if (usageData) responseObj.usage = usageData;
    result += emit('response.completed', {
      type: 'response.completed',
      response: responseObj,
    });
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
        if (!trimmed.startsWith('data: ')) continue;
        const dataStr = trimmed.slice(6).trim();
        if (!dataStr) continue;

        let chunk;
        try { chunk = JSON.parse(dataStr); } catch { continue; }

        const candidate = chunk.candidates?.[0];
        // gemini 的 usageMetadata（promptTokenCount/candidatesTokenCount）在每个 chunk 里都可能带
        const um = chunk.usageMetadata;
        if (um) {
          usageData = {
            input_tokens: um.promptTokenCount || 0,
            output_tokens: um.candidatesTokenCount || 0,
            total_tokens: (um.promptTokenCount || 0) + (um.candidatesTokenCount || 0),
          };
        }
        if (!candidate) continue;
        const parts = candidate.content?.parts || [];

        if (!createdSent && parts.length > 0) result += emitCreated();

        for (const part of parts) {
          // gemini 2.5+ 的 thought（part.thought===true）→ reasoning，普通 text → output_text
          if (part.text && part.thought) {
            result += handleReasoningDelta(part.text);
          } else if (part.text) {
            result += handleTextDelta(part.text);
          }
          if (part.functionCall) {
            const args = typeof part.functionCall.args === 'string'
              ? part.functionCall.args
              : JSON.stringify(part.functionCall.args || {});
            result += handleFunctionCall(part.functionCall.name, args);
          }
        }

        if (candidate.finishReason) result += finish();
      }
      return result;
    },

    flush() {
      if (buffer) {
        let result = '';
        if (buffer.startsWith('data: ')) {
          try {
            const chunk = JSON.parse(buffer.slice(6).trim());
            // 提取最后一个 chunk 的 usageMetadata（convertChunk 会因为末尾无换行而漏掉它）
            const um = chunk.usageMetadata;
            if (um) {
              usageData = {
                input_tokens: um.promptTokenCount || 0,
                output_tokens: um.candidatesTokenCount || 0,
                total_tokens: (um.promptTokenCount || 0) + (um.candidatesTokenCount || 0),
              };
            }
            const candidate = chunk.candidates?.[0];
            if (candidate) {
              if (!createdSent) result += emitCreated();
              for (const part of (candidate.content?.parts || [])) {
                if (part.text && part.thought) {
                  result += handleReasoningDelta(part.text);
                } else if (part.text) {
                  result += handleTextDelta(part.text);
                }
                if (part.functionCall) {
                  const args = typeof part.functionCall.args === 'string'
                    ? part.functionCall.args : JSON.stringify(part.functionCall.args || {});
                  result += handleFunctionCall(part.functionCall.name, args);
                }
              }
            }
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
