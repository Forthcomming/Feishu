function stateEvent(taskId, state) {
  return { eventType: "task.state", taskId, state, at: Date.now() };
}

function stepEvent(taskId, step) {
  return { eventType: "task.step", taskId, step, at: Date.now() };
}

function artifactEvent(taskId, artifact) {
  return { eventType: "task.artifact", taskId, artifact, at: Date.now() };
}

function errorEvent(taskId, stepId, error) {
  return { eventType: "task.error", taskId, stepId, error, at: Date.now() };
}

function confirmRequiredEvent(taskId, stepId, reason, options) {
  return { eventType: "task.confirm_required", taskId, stepId, reason, options: options || {}, at: Date.now() };
}

module.exports = { stateEvent, stepEvent, artifactEvent, errorEvent, confirmRequiredEvent };

