import { spawnSync } from 'child_process';

export type CodexExecThinkingEffort = 'low' | 'medium' | 'high' | 'max' | string;

export interface CodexExecArgsOptions {
  cwd: string;
  model?: string;
  outputLastMessageFile?: string;
  thinkingEffort?: CodexExecThinkingEffort;
  stdinPrompt?: boolean;
  skipGitRepoCheck?: boolean;
  ephemeral?: boolean;
  ignoreUserConfig?: boolean;
  ignoreRules?: boolean;
  bypassApprovalsAndSandbox?: boolean;
}

let cachedHelp: string | null | undefined;

function codexExecHelp(): string | null {
  if (cachedHelp !== undefined) return cachedHelp;
  const result = spawnSync('codex', ['exec', '--help'], {
    encoding: 'utf8',
    timeout: 3000,
    windowsHide: true,
  });
  if ((result.error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') {
    cachedHelp = null;
    return cachedHelp;
  }
  cachedHelp = `${result.stdout || ''}\n${result.stderr || ''}`;
  return cachedHelp;
}

function supportsFlag(flag: string): boolean {
  const help = codexExecHelp();
  return !help || help.includes(flag);
}

export function normalizeCodexExecThinkingEffort(effort: CodexExecThinkingEffort | undefined): string | undefined {
  if (!effort) return undefined;
  const normalized = String(effort).trim().toLowerCase();
  if (!normalized) return undefined;
  if (normalized === 'max') return 'xhigh';
  if (['low', 'medium', 'high', 'xhigh'].includes(normalized)) return normalized;
  return normalized;
}

export function buildCodexExecArgs(options: CodexExecArgsOptions): string[] {
  const args = ['exec'];
  if (options.skipGitRepoCheck ?? true) args.push('--skip-git-repo-check');
  if (options.ephemeral ?? true) args.push('--ephemeral');
  if (options.ignoreUserConfig ?? true) args.push('--ignore-user-config');
  if (options.ignoreRules ?? true) args.push('--ignore-rules');

  if (options.bypassApprovalsAndSandbox ?? true) {
    if (supportsFlag('--dangerously-bypass-approvals-and-sandbox')) {
      args.push('--dangerously-bypass-approvals-and-sandbox');
    } else {
      args.push('--sandbox', 'danger-full-access', '--ask-for-approval', 'never');
    }
  }

  args.push('--cd', options.cwd);
  if (options.model) {
    args.push('--model', options.model);
  }

  const thinkingEffort = normalizeCodexExecThinkingEffort(options.thinkingEffort);
  if (thinkingEffort) {
    args.push('-c', `model_reasoning_effort="${thinkingEffort}"`);
  }

  if (options.outputLastMessageFile) {
    args.push('--output-last-message', options.outputLastMessageFile);
  }
  if (options.stdinPrompt ?? true) args.push('-');
  return args;
}
