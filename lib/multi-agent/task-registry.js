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
  }

  create({ objective, scope, scopePath, model, toolsetNames, parentTaskId, dependencies }) {
    const task = {
      id: 'task-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8),
      objective,
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

  start(taskId, abortController) {
    const task = taskStore.get(taskId);
    if (!task) throw new Error(`Task ${taskId} not found`);
    if (task.status !== TASK_STATUS.CREATED) throw new Error(`Task ${taskId} is ${task.status}, cannot start`);
    task.status = TASK_STATUS.RUNNING;
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