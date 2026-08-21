/**
 * grok 内建工具名 → happyclaw/Claude 语义工具名的映射。
 *
 * grok 的 headless 事件流与 Claude Code 的 stream-json 同构，但工具命名是自己
 * 一套（`run_terminal_command` 而非 `Bash`）。事件适配与 hook 守卫都需要这张表：
 * 前者用来复用 claude 的 StreamEvent 渲染分支，后者用来复用 safety-lite 规则。
 *
 * MCP 工具不在表内 —— grok 不把它们展开成顶层工具，而是统一经由
 * `search_tool` 发现、`use_tool` 调用，工具全名形如 `agentdock__send_message`。
 */

export const GROK_TO_CLAUDE_TOOL_NAMES: Record<string, string> = {
  run_terminal_command: 'Bash',
  read_file: 'Read',
  write: 'Write',
  search_replace: 'Edit',
  list_dir: 'Glob',
  grep: 'Grep',
  todo_write: 'TodoWrite',
  spawn_subagent: 'Task',
  ask_user_question: 'AskUserQuestion',
  web_search: 'WebSearch',
  web_fetch: 'WebFetch',
  enter_plan_mode: 'EnterPlanMode',
  exit_plan_mode: 'ExitPlanMode',
  get_command_or_subagent_output: 'TaskOutput',
  kill_command_or_subagent: 'TaskStop',
  search_tool: 'ToolSearch',
};

/** grok 里等价于 Bash 的工具，safety-lite 守卫按这个匹配。 */
export const GROK_SHELL_TOOL = 'run_terminal_command';

/** hooks matcher 用的正则：同时兼容 grok 原生名与 Claude 兼容别名。 */
export const GROK_SHELL_TOOL_MATCHER = 'run_terminal_command|Bash';

export function toClaudeToolName(name: string | undefined): string {
  if (!name) return '';
  return GROK_TO_CLAUDE_TOOL_NAMES[name] || name;
}
