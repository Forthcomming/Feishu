class TaskStore {
  constructor() {
    this.byId = new Map();
    this.latestTaskIdByConversationId = new Map();
    this.waitersByTaskId = new Map();
    this.cancelledByTaskId = new Set();
  }

  create(task) {
    this.byId.set(task.taskId, task);
    if (task && typeof task.conversationId === "string" && task.conversationId.trim()) {
      this.latestTaskIdByConversationId.set(task.conversationId.trim(), task.taskId);
    }
    return task;
  }

  get(taskId) {
    return this.byId.get(taskId) || null;
  }

  update(taskId, patch) {
    const prev = this.get(taskId);
    if (!prev) return null;
    const next = { ...prev, ...patch, updatedAt: Date.now() };
    this.byId.set(taskId, next);
    if (next && typeof next.conversationId === "string" && next.conversationId.trim()) {
      this.latestTaskIdByConversationId.set(next.conversationId.trim(), next.taskId);
    }
    return next;
  }

  getLatestTaskIdByConversationId(conversationId) {
    const cid = typeof conversationId === "string" ? conversationId.trim() : "";
    if (!cid) return "";
    return this.latestTaskIdByConversationId.get(cid) || "";
  }

  isCancelled(taskId) {
    return this.cancelledByTaskId.has(taskId);
  }

  cancel(taskId) {
    this.cancelledByTaskId.add(taskId);
    const waiters = this.waitersByTaskId.get(taskId);
    if (waiters) {
      for (const w of waiters.values()) w.reject(new Error("task cancelled"));
      this.waitersByTaskId.delete(taskId);
    }
    return true;
  }

  waitForConfirm(taskId, stepId) {
    if (this.isCancelled(taskId)) return Promise.reject(new Error("task cancelled"));
    let waiters = this.waitersByTaskId.get(taskId);
    if (!waiters) {
      waiters = new Map();
      this.waitersByTaskId.set(taskId, waiters);
    }
    if (waiters.has(stepId)) return waiters.get(stepId).promise;

    let resolve;
    let reject;
    const promise = new Promise((res, rej) => {
      resolve = res;
      reject = rej;
    });
    waiters.set(stepId, { promise, resolve, reject });
    return promise;
  }

  resolveConfirm(taskId, stepId, approved, override) {
    const waiters = this.waitersByTaskId.get(taskId);
    const w = waiters ? waiters.get(stepId) : null;
    if (!w) return false;
    waiters.delete(stepId);
    if (waiters.size === 0) this.waitersByTaskId.delete(taskId);
    w.resolve({ approved: approved === true, override: override && typeof override === "object" ? override : null });
    return true;
  }
}

module.exports = { TaskStore };

