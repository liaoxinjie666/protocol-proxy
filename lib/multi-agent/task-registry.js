const EventEmitter = require('events');
const taskStore = require('./task-store');

const TASK_STATUS = {
  CREATED: 'created',
  RUNNING: 'running',
  COMPLETED: 'completed',
  FAILED: 'failed',
  STOPPED: 'stopped',
};

class TaskRegistry extends EventEmitter {
  constructor() {
    super();
    this._active = new Map(); // taskId → { abortController, startedAt }
    this._messages = new Map(); // taskId → messages[]（供 message_task 续接）
  }

  create({ objective, scope, scopePath, model, toolsetNames, parentTaskId, dependencies, role, batchId, agent }) {
    const task = {
      id: 'task-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8),
      objective,
      role: role || 'full',
      agent: agent || null,
      batchId: batchId || null,
      scope: scope || 'workspace',
      scopePath: scopePath || null,
      model: model || null,
      toolsetNames: toolsetNames || null,
      parentTaskId: parentTaskId || null,
      dependencies: dependencies || [],
      status: TASK_STATUS.CREATED,
      result: null,
      error: null,
      summary: null,
      createdAt: Date.now(),
      startedAt: null,
      endedAt: null,
    };
    taskStore.save(task);
    this.emit('task:created', task);
    return task;
  }

  /**
   * 通知一批子任务已创建（用于前端渲染委派卡片）
   */
  emitBatchCreated(batchId, tasks) {
    this.emit('batch:created', { batchId, tasks: tasks.map(t => ({ id: t.id, objective: t.objective, role: t.role, agent: t.agent })) });
  }

  start(taskId, abortController, { allowResume = false } = {}) {
    const task = taskStore.get(taskId);
    if (!task) throw new Error(`Task ${taskId} not found`);
    const resumable = [TASK_STATUS.COMPLETED, TASK_STATUS.FAILED];
    if (task.status !== TASK_STATUS.CREATED && !(allowResume && resumable.includes(task.status))) {
      throw new Error(`Task ${taskId} is ${task.status}, cannot start`);
    }
    task.status = TASK_STATUS.RUNNING;
    task.endedAt = null;
    task.startedAt = Date.now();
    this._active.set(taskId, { abortController: abortController || new AbortController(), startedAt: task.startedAt });
    taskStore.save(task);
    this.emit('task:started', task);
    return task;
  }

  complete(taskId, { result, summary } = {}) {
    const task = taskStore.get(taskId);
    if (!task) return null;
    if (task.status !== TASK_STATUS.RUNNING) return null;
    task.status = TASK_STATUS.COMPLETED;
    task.result = result || null;
    task.summary = summary || null;
    task.endedAt = Date.now();
    this._active.delete(taskId);
    taskStore.save(task);
    taskStore.cleanup();
    this.emit('task:completed', task);
    return task;
  }

  fail(taskId, error) {
    const task = taskStore.get(taskId);
    if (!task) return null;
    if (task.status !== TASK_STATUS.RUNNING && task.status !== TASK_STATUS.CREATED) return null;
    task.status = TASK_STATUS.FAILED;
    task.error = typeof error === 'string' ? error : (error?.message || String(error));
    task.endedAt = Date.now();
    this._active.delete(taskId);
    taskStore.save(task);
    taskStore.cleanup();
    this.emit('task:failed', task);
    return task;
  }

  stop(taskId) {
    const entry = this._active.get(taskId);
    if (entry?.abortController) entry.abortController.abort();
    const task = taskStore.get(taskId);
    if (!task) return null;
    if (task.status !== TASK_STATUS.RUNNING) return null;
    task.status = TASK_STATUS.STOPPED;
    task.endedAt = Date.now();
    this._active.delete(taskId);
    taskStore.save(task);
    this.emit('task:stopped', task);
    return task;
  }

  get(taskId) { return taskStore.get(taskId); }

  storeMessages(taskId, messages) { this._messages.set(taskId, messages); }
  getMessages(taskId) { return this._messages.get(taskId) || null; }
  clearMessages(taskId) { this._messages.delete(taskId); }

  /**
   * 子代理进度回报（每轮工具调用后调用）
   */
  reportProgress(taskId, { round, lastTool, snippet } = {}) {
    const task = taskStore.get(taskId);
    if (!task || task.status !== TASK_STATUS.RUNNING) return;
    task.progress = { round, lastTool, snippet: (snippet || '').slice(0, 200), updatedAt: Date.now() };
    this.emit('task:progress', { taskId, progress: task.progress });
  }

  /**
   * 按 batchId 批量停止子任务（层级取消）
   */
  stopBatch(batchId) {
    let stopped = 0;
    for (const [taskId, entry] of this._active) {
      const task = taskStore.get(taskId);
      if (task && task.batchId === batchId) {
        if (entry.abortController) entry.abortController.abort();
        task.status = TASK_STATUS.STOPPED;
        task.endedAt = Date.now();
        this._active.delete(taskId);
        taskStore.save(task);
        this.emit('task:stopped', task);
        stopped++;
      }
    }
    return stopped;
  }

  list(status) {
    const all = taskStore.listAll();
    return status ? all.filter(t => t.status === status) : all;
  }

  getActive() {
    return Array.from(this._active.keys())
      .map(id => taskStore.get(id))
      .filter(Boolean);
  }

  isRunning(taskId) { return this._active.has(taskId); }

  // Claude Code 演进预留：从 TaskPacket 创建任务
  createFromPacket(packet) {
    return this.create({
      objective: packet.objective,
      scope: packet.scope,
      scopePath: packet.scopePath,
      model: packet.model,
      toolsetNames: packet.toolsetNames,
      parentTaskId: packet.parentTaskId,
      dependencies: packet.dependencies,
    });
  }
}

module.exports = { TaskRegistry, TASK_STATUS };