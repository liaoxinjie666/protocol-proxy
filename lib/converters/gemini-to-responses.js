/**
 * Gemini SSE → Responses API SSE 直接转换器
 *
 * 用于 responses→gemini 流式路径，避免 o2g + c2r 双层转换的格式不兼容问题
 */

const { encodeAnthropicEvent, unwrapFreeformArgs } = require('./sse-helpers');

let _debugLog = null;
function dbg(...args) { if (_debugLog) _debugLog(...args); }
function setDebugLogger(fn) { _debugLog = fn; }

function uid(prefix) {
  const hex = Date.now().toString(16) + Math.random().toString(16).slice(2, 14);
  return `${prefix}_${hex.padEnd(24, '0').slice(0, 24)}`;
}

function createSSEConverter(targetModel, freeformTools) {
  const responseId = uid('resp');
  let done = false;
  let createdSent = false;
  let outputIndex = -1;
  let textStarted = false;
  let textItemId = null;
  let accumulatedText = '';
  const toolBuf = new Map(); // functionCall key → state
  const outputItems = [];
  let buffer = '';

  function emit(type, data) {
    return encodeAnthropicEvent(type, data);
  }

  function emitCreated() {
    createdSent = true;
    return emit('response.created', {
      type: 'response.created',
      response: {
        id: responseId,
        object: 'response',
        model: targetModel || '',
        status: 'in_progress',
        output: [],
      },
    });
  }

  function handleTextDelta(text) {
    let result = '';
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
    return emit('response.output_item.done', {
      type: 'response.output_item.done', output_index: outputIndex,
      item: item || { id: textItemId },
    });
  }

  function handleFunctionCall(name, args) {
    let finalArgs = args;
    const isFreeform = freeformTools && freeformTools.includes(name);
    dbg(`[g2r] function_call: name="${name}" isFreeform=${isFreeform} rawArgs=${(args || '').slice(0, 300)}`);

    // freeform 工具参数解包
    if (isFreeform) {
      finalArgs = unwrapFreeformArgs(args);
      if (finalArgs !== args) {
        dbg(`[g2r] freeform unwrap: len=${finalArgs.length}`);
      }
    }

    outputIndex++;
    const callId = uid('call');
    const state = { id: uid('func'), call_id: callId, name, arguments: finalArgs, outputIndex };
    toolBuf.set(name + outputIndex, state);

    // freeform 工具使用 custom_tool_call 类型，字段名 input
    let item;
    if (isFreeform) {
      item = {
        id: state.id, object: 'realtime.item', type: 'custom_tool_call',
        name, call_id: callId, input: finalArgs, status: 'completed',
      };
    } else {
      item = {
        id: state.id, object: 'realtime.item', type: 'function_call',
        name, call_id: callId, arguments: finalArgs, status: 'completed',
      };
    }
    outputItems.push(item);

    let result = emit('response.output_item.added', {
      type: 'response.output_item.added', output_index: outputIndex, item,
    });

    // freeform 工具先发 custom_tool_call_input.delta
    if (isFreeform && finalArgs) {
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
    result += emitTextDone();
    result += emit('response.completed', {
      type: 'response.completed',
      response: {
        id: responseId, object: 'response',
        model: targetModel || '', status: 'completed', output: outputItems,
      },
    });
    return result;
  }

  return {
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
        if (!candidate) continue;
        const parts = candidate.content?.parts || [];

        if (!createdSent && parts.length > 0) result += emitCreated();

        for (const part of parts) {
          if (part.text) result += handleTextDelta(part.text);
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
            const candidate = chunk.candidates?.[0];
            if (candidate) {
              if (!createdSent) result += emitCreated();
              for (const part of (candidate.content?.parts || [])) {
                if (part.text) result += handleTextDelta(part.text);
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
