/**
 * Anthropic SSE → Responses API SSE 直接转换器
 *
 * 用于 responses→anthropic 流式路径，避免 a2o + c2r 双层转换的格式不兼容问题
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
  const toolBuf = new Map(); // Anthropic tool_use blockIndex → state
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
    return emit('response.output_item.done', {
      type: 'response.output_item.done',
      output_index: outputIndex,
      item: item || { id: textItemId },
    });
  }

  function handleToolUseStart(blockIndex, toolUseId, name) {
    outputIndex++;
    const isFreeform = freeformTools && freeformTools.includes(name);
    dbg(`[a2r] tool_use START: name="${name}" id="${toolUseId}" blockIndex=${blockIndex} isFreeform=${isFreeform} freeformTools=${JSON.stringify(freeformTools)}`);
    const state = {
      id: uid('func'),
      call_id: toolUseId || uid('call'),
      name: name || '',
      isFreeform,
      arguments: '',
      outputIndex,
    };
    toolBuf.set(blockIndex, state);

    // freeform 工具使用 custom_tool_call 类型，字段名 input
    const item = isFreeform
      ? { id: state.id, object: 'realtime.item', type: 'custom_tool_call', name: state.name, call_id: state.call_id, input: '', status: 'in_progress' }
      : { id: state.id, object: 'realtime.item', type: 'function_call', name: state.name, call_id: state.call_id, arguments: '', status: 'in_progress' };
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
    if (!state.isFreeform) {
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

    dbg(`[a2r] tool DONE: name="${state.name}" blockIndex=${blockIndex} isFreeform=${state.isFreeform} rawArgs=${state.arguments.slice(0, 300)}`);

    if (state.isFreeform) {
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
      result += emit('response.output_item.done', {
        type: 'response.output_item.done',
        output_index: state.outputIndex,
        item: item || { id: state.id, type: 'custom_tool_call', name: state.name, call_id: state.call_id, input: state.arguments },
      });
      return result;
    }

    const item = outputItems.find(i => i.id === state.id);
    if (item) item.status = 'completed';
    return emit('response.output_item.done', {
      type: 'response.output_item.done',
      output_index: state.outputIndex,
      item: item || { id: state.id },
    });
  }

  function finish() {
    if (done) return '';
    done = true;
    let result = '';
    result += emitTextDone();
    for (const [idx] of [...toolBuf.entries()].sort((a, b) => a[0] - b[0])) {
      result += emitToolDone(idx);
    }
    result += emit('response.completed', {
      type: 'response.completed',
      response: {
        id: responseId,
        object: 'response',
        model: targetModel || '',
        status: 'completed',
        output: outputItems,
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
            }
            break;
          }

          case 'content_block_stop':
            // text block 结束时 emit text done
            if (textStarted && !toolBuf.has(data.index)) {
              result += emitTextDone();
            }
            break;

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