const test = require("node:test");
const assert = require("node:assert/strict");
const { TaskStore } = require("../src/taskStore");

test("TaskStore: conversationId -> latest taskId 索引", () => {
  const store = new TaskStore();
  store.create({ taskId: "t1", conversationId: "c1", state: "detecting", steps: [], artifacts: [], createdAt: 1, updatedAt: 1 });
  assert.equal(store.getLatestTaskIdByConversationId("c1"), "t1");

  store.create({ taskId: "t2", conversationId: "c1", state: "detecting", steps: [], artifacts: [], createdAt: 2, updatedAt: 2 });
  assert.equal(store.getLatestTaskIdByConversationId("c1"), "t2");

  store.update("t1", { state: "completed" });
  // Update should refresh mapping to the updated task's id (t1) only if conversation matches; here it does.
  assert.equal(store.getLatestTaskIdByConversationId("c1"), "t1");
});

