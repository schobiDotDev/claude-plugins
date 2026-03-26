let state = null;

export function startSession(companionName) {
  state = {
    companion: companionName,
    startTime: Date.now(),
    tools: [],
    errors: [],
    stopCount: 0,
  };
}

export function logTool(name, success = true) {
  if (!state) return;
  state.tools.push({
    name,
    timestamp: Date.now(),
    success,
  });
}

export function logError(tool, error) {
  if (!state) return;
  state.errors.push({
    tool,
    error,
    timestamp: Date.now(),
  });
}

export function logStop() {
  if (!state) return;
  state.stopCount++;
}

export function getDuration() {
  if (!state) return 0;
  return Math.round((Date.now() - state.startTime) / 60000);
}

export function getSummaryData() {
  if (!state) return null;
  const toolNames = [...new Set(state.tools.map(t => t.name))];
  return {
    companion: state.companion,
    duration: getDuration(),
    toolsCount: state.tools.length,
    toolNames,
    errorsCount: state.errors.length,
    stopCount: state.stopCount,
  };
}

export function getState() {
  return state;
}
