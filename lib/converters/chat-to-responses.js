/**
 * Chat Completions API ↔ Responses API 双向转换器
 *
 * - convertRequest: Chat 请求 → Responses 请求
 * - convertResponse: Chat 响应 → Responses 响应
 * - createSSEConverter: Chat SSE → Responses SSE
 */

const { encodeAnthropicEvent } = require('./sse-helpers');

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
        content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content || ''),
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
  if (chatBody.tool_choice && respReq.tools) respReq.tool_choice = chatBody.tool_choice;

  return respReq;
}

// ─── 非流式响应转换 ─────────────────────────────────────────

function convertResponse(body) {
  const output = [];

  if (body.choices && body.choices.length > 0) {
    const msg = body.choices[0].message;

    if (msg && msg.content) {
      output.push({
        id: uid('msg'),
        object: 'realtime.item',
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: msg.content, annotations: [] }],
      });
    }

    if (msg && Array.isArray(msg.tool_calls)) {
      for (const tc of msg.tool_calls) {
        const args = typeof tc.function.arguments === 'string'
          ? tc.function.arguments
          : JSON.stringify(tc.function.arguments || {});
        output.push({
          id: uid('func'),
          object: 'realtime.item',
          type: 'function_call',
          name: tc.function.name,
          call_id: tc.id || uid('call'),
          arguments: args,
          status: 'completed',
        });
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

function createSSEConverter(targetModel) {
  const responseId = uid('resp');
  let createdSent = false;
  let done = false;
  let outputIndex = -1;
  let textStarted = false;
  let textItemId = null;
  let accumulatedText = '';
  const tcBuf = new Map(); // Chat Completions tool_call.index → state
  const outputItems = [];

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

  function handleTextDelta(content) {
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
      buf.nameDone = true;

      const item = outputItems.find(i => i.id === buf.id);
      if (item) item.name = fnName;

      result += emit('response.output_item.added', {
        type: 'response.output_item.added',
        output_index: buf.outputIndex,
        item: item || { id: buf.id, type: 'function_call', name: fnName, call_id: buf.call_id },
      });
    }

    // 参数增量
    const fnArgs = tc.function && tc.function.arguments;
    if (fnArgs) {
      buf.arguments += fnArgs;

      const item = outputItems.find(i => i.id === buf.id);
      if (item) item.arguments = buf.arguments;

      result += emit('response.function_call_arguments.delta', {
        type: 'response.function_call_arguments.delta',
        output_index: buf.outputIndex,
        call_id: buf.call_id,
        delta: fnArgs,
      });
    }

    return result;
  }

  function emitToolCallDone(idx) {
    const buf = tcBuf.get(idx);
    if (!buf) return '';

    const item = outputItems.find(i => i.id === buf.id);
    if (item) item.status = 'completed';

    return emit('response.output_item.done', {
      type: 'response.output_item.done',
      output_index: buf.outputIndex,
      item: item || { id: buf.id },
    });
  }

  function finish() {
    if (done) return '';
    done = true;

    let result = '';
    result += emitTextDone();

    // 按 index 顺序完成所有 tool_calls
    const sortedIdx = [...tcBuf.keys()].sort((a, b) => a - b);
    for (const idx of sortedIdx) {
      result += emitToolCallDone(idx);
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

  // ─── 主接口 ─────────────────────────────────────────────

  let buffer = '';

  return {
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
        if (!choice) continue;

        const delta = choice.delta;
        if (delta) {
          // 忽略 reasoning_content（不转发给客户端）
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
              const choice = data.choices && data.choices[0];
              if (choice && choice.delta) {
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

module.exports = { convertRequest, convertResponse, createSSEConverter };
