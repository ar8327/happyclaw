export const DEFAULT_CLAUDE_BUILTIN_TOOLS = [
  'AskUserQuestion',
  'Bash',
  'Edit',
  'EnterPlanMode',
  'ExitPlanMode',
  'Glob',
  'Grep',
  'NotebookEdit',
  'Read',
  'Skill',
  'Task',
  'TaskOutput',
  'TaskStop',
  'TodoWrite',
  'ToolSearch',
  'WebFetch',
  'WebSearch',
  'Write',
];

export const DEFAULT_ALLOWED_TOOLS = [
  ...DEFAULT_CLAUDE_BUILTIN_TOOLS,
  'mcp__happyclaw__*',
];
