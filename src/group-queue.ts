import { ChildProcess } from 'child_process';
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from './config.js';
import { killProcessTree } from './runtime-runner.js';
import { getSystemSettings } from './runtime-config.js';
import { logger } from './logger.js';
import { type MessageIntent } from './intent-analyzer.js';

export type SendMessageResult =
  | 'sent'
  | 'no_active'
  | 'interrupted_stop'
  | 'interrupted_correction';

function extractSourceChannels(text: string): string[] | undefined {
  const sources = [...text.matchAll(/source="([^"]+)"/g)]
    .map((match) => match[1]?.trim())
    .filter((source): source is string => !!source);
  return sources.length > 0 ? [...new Set(sources)] : undefined;
}

interface QueuedTask {
  id: string;
  groupJid: string;
  fn: () => Promise<void>;
}

const MAX_RETRIES = 5;
const BASE_RETRY_MS = 5000;

interface GroupState {
  active: boolean;
  pendingMessages: boolean;
  pendingTasks: QueuedTask[];
  process: ChildProcess | null;
  runtimeIdentifier: string | null;
  runtimeLabel: string | null;
  groupFolder: string | null;
  agentId: string | null;
  retryCount: number;
  retryTimer: ReturnType<typeof setTimeout> | null;
  restarting: boolean;
}

type ActiveGroupState = GroupState & { groupFolder: string };

export class SessionRuntimeQueue {
  private groups = new Map<string, GroupState>();
  private activeCount = 0;
  private waitingGroups = new Set<string>();
  private contextOverflowGroups = new Set<string>(); // 跟踪发生上下文溢出的 group
  private processMessagesFn: ((groupJid: string) => Promise<boolean>) | null =
    null;
  private shuttingDown = false;
  private serializationKeyResolver: ((groupJid: string) => string) | null =
    null;
  private onMaxRetriesExceededFn: ((groupJid: string) => void) | null = null;
  private onContainerExitListeners: Array<(groupJid: string) => void> = [];
  private userConcurrentLimitFn:
    | ((groupJid: string) => { allowed: boolean })
    | null = null;
  private lifecycleEmitter:
    | ((groupJid: string, state: string, detail?: string) => void)
    | null = null;

  private getGroup(groupJid: string): GroupState {
    let state = this.groups.get(groupJid);
    if (!state) {
      state = {
        active: false,
        pendingMessages: false,
        pendingTasks: [],
        process: null,
        runtimeIdentifier: null,
        runtimeLabel: null,
        groupFolder: null,
        agentId: null,
        retryCount: 0,
        retryTimer: null,
        restarting: false,
      };
      this.groups.set(groupJid, state);
    }
    return state;
  }

  setProcessMessagesFn(fn: (groupJid: string) => Promise<boolean>): void {
    this.processMessagesFn = fn;
  }

  setHostModeChecker(_fn: (groupJid: string) => boolean): void {}

  setLifecycleEmitter(
    fn: (groupJid: string, state: string, detail?: string) => void,
  ): void {
    this.lifecycleEmitter = fn;
  }

  setSerializationKeyResolver(fn: (groupJid: string) => string): void {
    this.serializationKeyResolver = fn;
  }

  setOnMaxRetriesExceeded(fn: (groupJid: string) => void): void {
    this.onMaxRetriesExceededFn = fn;
  }

  addOnContainerExitListener(fn: (groupJid: string) => void): void {
    this.onContainerExitListeners.push(fn);
  }

  setUserConcurrentLimitChecker(
    fn: (groupJid: string) => { allowed: boolean },
  ): void {
    this.userConcurrentLimitFn = fn;
  }

  /**
   * 标记 group 发生了上下文溢出错误，跳过指数退避重试
   */
  markContextOverflow(groupJid: string): void {
    this.contextOverflowGroups.add(groupJid);
    logger.warn(
      { groupJid },
      'Marked group as context overflow - will skip retry backoff',
    );
  }

  private clearRetryTimer(state: GroupState): void {
    if (state.retryTimer !== null) {
      clearTimeout(state.retryTimer);
      state.retryTimer = null;
    }
    state.retryCount = 0;
  }

  private getSerializationKey(groupJid: string): string {
    const key = this.serializationKeyResolver?.(groupJid)?.trim();
    return key || groupJid;
  }

  private findActiveRunnerFor(groupJid: string): string | null {
    const key = this.getSerializationKey(groupJid);
    for (const [jid, state] of this.groups.entries()) {
      if (!state.active) continue;
      if (this.getSerializationKey(jid) === key) return jid;
    }
    return null;
  }

  private hasCapacityFor(groupJid: string): boolean {
    if (groupJid.length === 0) return false;
    if (this.activeCount >= getSystemSettings().maxConcurrentRuntimes) {
      return false;
    }

    // User-level concurrent runtime limit. The old checker name is kept to
    // avoid widening the migration diff across index/config routes.
    if (this.userConcurrentLimitFn) {
      const result = this.userConcurrentLimitFn(groupJid);
      if (!result.allowed) return false;
    }
    return true;
  }

  private resolveActiveState(groupJid: string): ActiveGroupState | null {
    const own = this.getGroup(groupJid);
    if (own.active && own.groupFolder) return own as ActiveGroupState;

    const activeRunner = this.findActiveRunnerFor(groupJid);
    if (!activeRunner) return null;
    const shared = this.getGroup(activeRunner);
    if (!shared.active || !shared.groupFolder) return null;
    return shared as ActiveGroupState;
  }

  /** 检查指定 JID 是否有自己直接启动的活跃 runner（非通过 folder 共享匹配） */
  hasDirectActiveRunner(groupJid: string): boolean {
    const state = this.groups.get(groupJid);
    return state?.active === true;
  }

  enqueueMessageCheck(groupJid: string): void {
    if (this.shuttingDown) return;

    const state = this.getGroup(groupJid);

    const activeRunner = this.findActiveRunnerFor(groupJid);
    if (state.active || (activeRunner && activeRunner !== groupJid)) {
      state.pendingMessages = true;
      this.waitingGroups.add(groupJid);
      const detail =
        activeRunner && activeRunner !== groupJid
          ? '当前共享工作区正在处理其它渠道的 Turn'
          : '当前工作区仍在处理上一轮消息';
      this.lifecycleEmitter?.(groupJid, 'queued', detail);
      logger.debug(
        { groupJid, activeRunner: activeRunner || groupJid },
        'Group runner active, message queued',
      );
      return;
    }

    if (!this.hasCapacityFor(groupJid)) {
      state.pendingMessages = true;
      this.waitingGroups.add(groupJid);
      const max = getSystemSettings().maxConcurrentRuntimes;
      const current = this.activeCount;
      this.lifecycleEmitter?.(
        groupJid,
        'capacity_wait',
        `${current}/${max} 个 Runtime 运行中`,
      );
      logger.debug(
        {
          groupJid,
          activeCount: this.activeCount,
          maxConcurrentRuntimes: max,
        },
        'At concurrency limit, message queued',
      );
      return;
    }

    this.waitingGroups.delete(groupJid);
    this.runForGroup(groupJid, 'messages');
  }

  /**
   * Enqueue an arbitrary async function to run with queue serialization.
   * Used for sub-agent conversations and terminal warmup.
   */
  enqueueTask(groupJid: string, taskId: string, fn: () => Promise<void>): void {
    if (this.shuttingDown) return;

    const state = this.getGroup(groupJid);

    // Prevent double-queuing of the same task
    if (state.pendingTasks.some((t) => t.id === taskId)) {
      logger.debug({ groupJid, taskId }, 'Task already queued, skipping');
      return;
    }

    const activeRunner = this.findActiveRunnerFor(groupJid);
    if (state.active || (activeRunner && activeRunner !== groupJid)) {
      state.pendingTasks.push({ id: taskId, groupJid, fn });
      this.waitingGroups.add(groupJid);
      logger.debug(
        { groupJid, taskId, activeRunner: activeRunner || groupJid },
        'Group runner active, task queued',
      );
      return;
    }

    if (!this.hasCapacityFor(groupJid)) {
      state.pendingTasks.push({ id: taskId, groupJid, fn });
      this.waitingGroups.add(groupJid);
      return;
    }

    // Run immediately
    this.waitingGroups.delete(groupJid);
    this.runTask(groupJid, { id: taskId, groupJid, fn });
  }

  registerProcess(
    groupJid: string,
    proc: ChildProcess,
    runtimeIdentifier: string | null,
    groupFolder?: string,
    runtimeLabel?: string,
    agentId?: string,
  ): void {
    const state = this.getGroup(groupJid);
    state.process = proc;
    state.runtimeIdentifier = runtimeIdentifier || runtimeLabel || null;
    state.runtimeLabel = runtimeLabel || runtimeIdentifier || null;
    if (groupFolder) state.groupFolder = groupFolder;
    state.agentId = agentId || null;
  }

  /**
   * Resolve IPC input directory for a group state.
   * Sub-agents use a nested path: data/ipc/{folder}/agents/{agentId}/input/
   */
  private resolveIpcInputDir(state: ActiveGroupState): string {
    if (state.agentId) {
      return path.join(
        DATA_DIR,
        'ipc',
        state.groupFolder,
        'agents',
        state.agentId,
        'input',
      );
    }
    return path.join(DATA_DIR, 'ipc', state.groupFolder, 'input');
  }

  /**
   * Send a follow-up message to the active runtime via IPC file.
   * Analyzes message intent and may interrupt the current query.
   *
   * Returns:
   * - 'sent': message written to IPC (continue intent)
   * - 'no_active': no active container/process for this group
   * - 'interrupted_stop': stop intent detected, query interrupted, message NOT written
   * - 'interrupted_correction': correction intent detected, query interrupted, message written
   */
  sendMessage(
    groupJid: string,
    text: string,
    images?: Array<{ data: string; mimeType?: string }>,
    intent: MessageIntent = 'continue',
    onInjected?: () => void,
  ): SendMessageResult {
    const state = this.resolveActiveState(groupJid);
    if (!state) return 'no_active';

    if (intent === 'stop') {
      this.interruptQuery(groupJid);
      logger.info(
        { groupJid, intent },
        'Stop intent detected, interrupting query without IPC message',
      );
      return 'interrupted_stop';
    }

    if (intent === 'correction') {
      this.interruptQuery(groupJid);
      logger.info(
        { groupJid, intent },
        'Correction intent detected, interrupting query and writing IPC message',
      );
      // Fall through to write the IPC message so the agent sees the correction after restart
    }

    const inputDir = this.resolveIpcInputDir(state);
    try {
      fs.mkdirSync(inputDir, { recursive: true });
      const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}.json`;
      const filepath = path.join(inputDir, filename);
      const tempPath = `${filepath}.tmp`;
      fs.writeFileSync(
        tempPath,
        JSON.stringify({
          type: 'message',
          text,
          images,
          ackTargets: [groupJid],
          ackSourceChannels: extractSourceChannels(text),
        }),
      );
      fs.renameSync(tempPath, filepath);
      onInjected?.();
      return intent === 'correction' ? 'interrupted_correction' : 'sent';
    } catch {
      return 'no_active';
    }
  }

  /**
   * Signal the active runtime to wind down by writing a close sentinel.
   */
  closeStdin(groupJid: string): void {
    const state = this.resolveActiveState(groupJid);
    if (!state) return;

    const inputDir = this.resolveIpcInputDir(state);
    try {
      fs.mkdirSync(inputDir, { recursive: true });
      fs.writeFileSync(path.join(inputDir, '_close'), '');
    } catch {
      // ignore
    }
  }

  /**
   * Signal the active container to drain: finish current query then exit.
   * Unlike closeStdin which signals immediate exit, drain waits for the query to complete.
   * Used for turn boundaries when a different channel's message needs processing.
   */
  sendDrain(groupJid: string): boolean {
    const state = this.resolveActiveState(groupJid);
    if (!state) return false;

    const inputDir = this.resolveIpcInputDir(state);
    try {
      fs.mkdirSync(inputDir, { recursive: true });
      fs.writeFileSync(path.join(inputDir, '_drain'), '');
      logger.info(
        { groupJid, groupFolder: state.groupFolder },
        'Drain sentinel written',
      );
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Close all active runtimes so they restart with fresh credentials.
   * Called after OAuth token refresh to ensure running agents pick up new tokens.
   */
  closeAllActiveForCredentialRefresh(): number {
    let closed = 0;
    for (const [jid, state] of this.groups) {
      if (state.active && state.groupFolder) {
        const inputDir = this.resolveIpcInputDir(state as ActiveGroupState);
        try {
          fs.mkdirSync(inputDir, { recursive: true });
          fs.writeFileSync(path.join(inputDir, '_close'), '');
          closed++;
          logger.info(
            { groupJid: jid, groupFolder: state.groupFolder },
            'Sent close signal for credential refresh',
          );
        } catch {
          // ignore
        }
      }
    }
    if (closed > 0) {
      logger.info(
        { closed },
        'Closed active runtimes for credential refresh',
      );
    }
    return closed;
  }

  /**
   * Interrupt the current query for the same chat only (do not cross-interrupt
   * sibling chats that share a serialized runner/folder).
   *
   * Writes a _interrupt sentinel that agent-runner detects and calls
   * query.interrupt(). The container stays alive and accepts new messages.
   */
  interruptQuery(groupJid: string): boolean {
    // Use resolveActiveState so sibling JIDs (feishu/telegram sharing the
    // same folder as a web group) are correctly resolved to the active runner.
    const state = this.resolveActiveState(groupJid);
    if (!state) return false;

    this.clearRetryTimer(state);

    const inputDir = this.resolveIpcInputDir(state);
    try {
      fs.mkdirSync(inputDir, { recursive: true });
      try {
        fs.chmodSync(inputDir, 0o777);
      } catch {
        /* ignore */
      }
      fs.writeFileSync(path.join(inputDir, '_interrupt'), '');
      logger.info({ groupJid, inputDir }, 'Interrupt sentinel written');
      return true;
    } catch (err) {
      logger.warn(
        { groupJid, inputDir, err },
        'Failed to write interrupt sentinel',
      );
      return false;
    }
  }

  /**
   * Send a permission mode change command to a running runtime via IPC.
   * Returns true if the command was written successfully.
   */
  setPermissionMode(groupJid: string, mode: string): boolean {
    const state = this.resolveActiveState(groupJid);
    if (!state) return false;

    const inputDir = this.resolveIpcInputDir(state);
    try {
      fs.mkdirSync(inputDir, { recursive: true });
      const filename = `${Date.now()}-mode-${Math.random().toString(36).slice(2, 6)}.json`;
      const filepath = path.join(inputDir, filename);
      const tempPath = `${filepath}.tmp`;
      fs.writeFileSync(tempPath, JSON.stringify({ type: 'set_mode', mode }));
      fs.renameSync(tempPath, filepath);
      logger.info({ groupJid, mode }, 'Permission mode change IPC written');
      return true;
    } catch (err) {
      logger.warn({ groupJid, mode, err }, 'Failed to write mode change IPC');
      return false;
    }
  }

  /**
   * Force-stop a group's active runtime and clear queued work.
   * Returns a promise that resolves when the runtime has fully exited.
   */
  async stopGroup(
    groupJid: string,
    options?: { force?: boolean },
  ): Promise<void> {
    const force = options?.force ?? false;
    const requestedState = this.getGroup(groupJid);
    requestedState.pendingMessages = false;
    requestedState.pendingTasks = [];
    this.clearRetryTimer(requestedState);

    const activeRunner = this.findActiveRunnerFor(groupJid);
    const targetJid = activeRunner || groupJid;
    const state = this.getGroup(targetJid);
    if (targetJid !== groupJid) {
      state.pendingMessages = false;
      state.pendingTasks = [];
      this.clearRetryTimer(state);
    }
    this.waitingGroups.delete(groupJid);
    this.waitingGroups.delete(targetJid);

    if (state.groupFolder) {
      this.closeStdin(targetJid);
    }

    if (force) {
      if (state.process && !state.process.killed) {
        killProcessTree(state.process, 'SIGKILL');
      }

      if (state.active) {
        const start = Date.now();
        while (state.active && Date.now() - start < 5000) {
          await new Promise((r) => setTimeout(r, 100));
        }
      }
    } else {
      if (state.process && !state.process.killed) {
        killProcessTree(state.process, 'SIGTERM');
      }

      // Wait for state.active to become false (runForGroup/runTask finally block)
      if (state.active) {
        const maxWait = 10000;
        const start = Date.now();
        while (state.active && Date.now() - start < maxWait) {
          await new Promise((r) => setTimeout(r, 100));
        }
      }

      if (state.active && state.process) {
        killProcessTree(state.process, 'SIGKILL');
        const killStart = Date.now();
        while (state.active && Date.now() - killStart < 5000) {
          await new Promise((r) => setTimeout(r, 100));
        }
      }
    }

    if (state.active) {
      logger.error(
        { groupJid: targetJid },
        'Runtime still active after force-kill in stopGroup',
      );
      throw new Error(`Failed to stop runtime for group ${targetJid}`);
    }
  }

  /**
   * Stop the running runtime, wait for it to finish, then start a new one.
   */
  async restartGroup(groupJid: string): Promise<void> {
    const activeRunner = this.findActiveRunnerFor(groupJid);
    const targetJid = activeRunner || groupJid;
    const state = this.getGroup(targetJid);

    if (state.restarting) {
      logger.warn(
        { groupJid: targetJid },
        'Restart already in progress, skipping',
      );
      return;
    }
    state.restarting = true;

    try {
      if (state.groupFolder) {
        this.closeStdin(targetJid);
      }

      if (state.process && !state.process.killed) {
        killProcessTree(state.process, 'SIGTERM');
      }

      // Wait for runForGroup to finish and reset state
      const maxWait = 20000;
      const start = Date.now();
      while (state.active && Date.now() - start < maxWait) {
        await new Promise((r) => setTimeout(r, 200));
      }

      if (state.active) {
        logger.warn(
          { groupJid: targetJid },
          'Timeout waiting for runtime to stop, force-killing',
        );
        if (state.process) {
          killProcessTree(state.process, 'SIGKILL');
          const killStart = Date.now();
          while (state.active && Date.now() - killStart < 5000) {
            await new Promise((r) => setTimeout(r, 200));
          }
        }
      }

      if (state.active) {
        logger.error(
          { groupJid: targetJid },
          'Runtime still active after force-kill in restartGroup',
        );
        throw new Error(`Failed to restart runtime for group ${targetJid}`);
      }

      logger.info({ groupJid: targetJid }, 'Restarting runtime');
      this.enqueueMessageCheck(groupJid);
    } finally {
      state.restarting = false;
    }
  }

  removeGroupState(groupJid: string): void {
    const state = this.groups.get(groupJid);
    if (!state) return;
    if (state.active || state.process || state.pendingMessages || state.pendingTasks.length > 0) {
      logger.warn(
        {
          groupJid,
          active: state.active,
          hasProcess: !!state.process,
          pendingMessages: state.pendingMessages,
          pendingTasks: state.pendingTasks.length,
        },
        'Refused to remove runtime state while work is still pending',
      );
      return;
    }
    this.clearRetryTimer(state);
    this.waitingGroups.delete(groupJid);
    this.contextOverflowGroups.delete(groupJid);
    this.groups.delete(groupJid);
  }

  private async runForGroup(
    groupJid: string,
    reason: 'messages' | 'drain',
  ): Promise<void> {
    const state = this.getGroup(groupJid);
    state.active = true;
    state.pendingMessages = false;
    // Pre-set groupFolder so resolveActiveState() works immediately,
    // before registerProcess() is called after the agent process spawns.
    // Without this, there is a window where active=true but groupFolder=null,
    // causing sendMessage() to return 'no_active' and silently queue messages.
    state.groupFolder = this.getSerializationKey(groupJid);
    this.waitingGroups.delete(groupJid);
    this.lifecycleEmitter?.(
      groupJid,
      'starting',
      reason === 'drain' ? '上一轮已结束，正在接手这一轮' : '正在启动当前 Turn',
    );
    this.activeCount++;
    logger.debug(
      {
        groupJid,
        reason,
        activeCount: this.activeCount,
      },
      'Starting runtime for group',
    );

    try {
      if (this.processMessagesFn) {
        const success = await this.processMessagesFn(groupJid);
        if (success) {
          state.retryCount = 0;
        } else {
          this.scheduleRetry(groupJid, state);
        }
      }
    } catch (err) {
      logger.error({ groupJid, err }, 'Error processing messages for group');
      this.scheduleRetry(groupJid, state);
    } finally {
      state.active = false;
      state.process = null;
      state.runtimeIdentifier = null;
      state.runtimeLabel = null;
      state.groupFolder = null;
      state.agentId = null;
      this.activeCount--;
      for (const listener of this.onContainerExitListeners) {
        try {
          listener(groupJid);
        } catch (err) {
          logger.error({ groupJid, err }, 'onContainerExit listener failed');
        }
      }
      try {
        this.drainGroup(groupJid);
      } catch (err) {
        logger.error({ groupJid, err }, 'drainGroup failed');
      }
    }
  }

  private async runTask(groupJid: string, task: QueuedTask): Promise<void> {
    const state = this.getGroup(groupJid);
    state.active = true;
    state.groupFolder = this.getSerializationKey(groupJid);
    this.waitingGroups.delete(groupJid);
    this.activeCount++;
    logger.debug(
      {
        groupJid,
        taskId: task.id,
        activeCount: this.activeCount,
      },
      'Running queued task',
    );

    try {
      await task.fn();
    } catch (err) {
      logger.error({ groupJid, taskId: task.id, err }, 'Error running task');
    } finally {
      state.active = false;
      state.process = null;
      state.runtimeIdentifier = null;
      state.runtimeLabel = null;
      state.groupFolder = null;
      state.agentId = null;
      this.activeCount--;
      for (const listener of this.onContainerExitListeners) {
        try {
          listener(groupJid);
        } catch (err) {
          logger.error({ groupJid, err }, 'onContainerExit listener failed');
        }
      }
      try {
        this.drainGroup(groupJid);
      } catch (err) {
        logger.error({ groupJid, err }, 'drainGroup failed');
      }
    }
  }

  private scheduleRetry(groupJid: string, state: GroupState): void {
    // 清除可能存在的旧定时器（不重置 retryCount，因为这里在递增）
    if (state.retryTimer !== null) {
      clearTimeout(state.retryTimer);
      state.retryTimer = null;
    }

    // 检查是否为上下文溢出错误，如果是则跳过重试
    if (this.contextOverflowGroups.has(groupJid)) {
      logger.warn(
        { groupJid },
        'Skipping retry for context overflow error (agent already retried 3 times)',
      );
      state.retryCount = 0;
      this.contextOverflowGroups.delete(groupJid); // 清除标记
      return;
    }

    state.retryCount++;
    if (state.retryCount > MAX_RETRIES) {
      logger.error(
        { groupJid, retryCount: state.retryCount },
        'Max retries exceeded, dropping messages (will retry on next incoming message)',
      );
      state.retryCount = 0;
      try {
        this.onMaxRetriesExceededFn?.(groupJid);
      } catch (err) {
        logger.error({ groupJid, err }, 'onMaxRetriesExceeded callback failed');
      }
      return;
    }

    const delayMs = BASE_RETRY_MS * Math.pow(2, state.retryCount - 1);
    logger.info(
      { groupJid, retryCount: state.retryCount, delayMs },
      'Scheduling retry with backoff',
    );
    state.retryTimer = setTimeout(() => {
      state.retryTimer = null;
      if (!this.shuttingDown) {
        this.enqueueMessageCheck(groupJid);
      }
    }, delayMs);
  }

  private drainGroup(groupJid: string): void {
    if (this.shuttingDown) return;

    const state = this.getGroup(groupJid);
    const activeRunner = this.findActiveRunnerFor(groupJid);
    if (activeRunner && activeRunner !== groupJid) {
      this.waitingGroups.add(groupJid);
      return;
    }
    if (!this.hasCapacityFor(groupJid)) {
      this.waitingGroups.add(groupJid);
      return;
    }

    // Queued tasks first (they won't be re-discovered like messages)
    if (state.pendingTasks.length > 0) {
      const task = state.pendingTasks.shift()!;
      this.runTask(groupJid, task);
      return;
    }

    // Then pending messages
    if (state.pendingMessages) {
      this.runForGroup(groupJid, 'drain');
      return;
    }

    this.waitingGroups.delete(groupJid);

    // Nothing pending for this group; check if other groups are waiting for a slot
    this.drainWaiting();
  }

  private drainWaiting(): void {
    // Drain waiting groups one at a time, re-checking capacity after each launch.
    // runTask/runForGroup increment counters synchronously, so capacity checks
    // stay accurate even though the async work is not awaited.
    const candidates = [...this.waitingGroups];

    for (const jid of candidates) {
      const activeRunner = this.findActiveRunnerFor(jid);
      if (activeRunner && activeRunner !== jid) continue;
      if (!this.hasCapacityFor(jid)) continue;

      this.waitingGroups.delete(jid);
      const state = this.getGroup(jid);

      if (state.pendingTasks.length > 0) {
        const task = state.pendingTasks.shift()!;
        this.runTask(jid, task);
      } else if (state.pendingMessages) {
        this.runForGroup(jid, 'drain');
      }
      // If neither pending, skip this group
    }
  }

  getStatus(): {
    activeCount: number;
    waitingCount: number;
    waitingGroupJids: string[];
    groups: Array<{
      jid: string;
      active: boolean;
      pendingMessages: boolean;
      pendingTasks: number;
      runtimeIdentifier: string | null;
      runtimeLabel: string | null;
      groupFolder: string | null;
      agentId: string | null;
      sessionKey: string;
    }>;
  } {
    const groups: Array<{
      jid: string;
      active: boolean;
      pendingMessages: boolean;
      pendingTasks: number;
      runtimeIdentifier: string | null;
      runtimeLabel: string | null;
      groupFolder: string | null;
      agentId: string | null;
      sessionKey: string;
    }> = [];

    for (const [jid, state] of this.groups) {
      groups.push({
        jid,
        active: state.active,
        pendingMessages: state.pendingMessages,
        pendingTasks: state.pendingTasks.length,
        runtimeIdentifier: state.runtimeIdentifier,
        runtimeLabel: state.runtimeLabel,
        groupFolder: state.groupFolder,
        agentId: state.agentId,
        sessionKey: this.getSerializationKey(jid),
      });
    }

    return {
      activeCount: this.activeCount,
      waitingCount: this.waitingGroups.size,
      waitingGroupJids: Array.from(this.waitingGroups),
      groups,
    };
  }

  async shutdown(gracePeriodMs: number): Promise<void> {
    this.shuttingDown = true;

    // 清除所有待执行的重试定时器，防止关闭期间容器重启
    for (const state of this.groups.values()) {
      this.clearRetryTimer(state);
    }

    logger.info(
      {
        activeCount: this.activeCount,
        gracePeriodMs,
      },
      'SessionRuntimeQueue shutting down, waiting for runtimes',
    );

    // Wait for activeCount to reach zero or timeout
    const startTime = Date.now();
    while (this.activeCount > 0 && Date.now() - startTime < gracePeriodMs) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    // If still active after the grace period, force stop all runtimes.
    if (this.activeCount > 0) {
      logger.warn(
        {
          activeCount: this.activeCount,
        },
        'Grace period expired, force stopping runtimes',
      );

      const stopPromises: Promise<void>[] = [];
      for (const [jid, state] of this.groups) {
        if (state.process && !state.process.killed) {
          const proc = state.process;
          const promise = new Promise<void>((resolve) => {
            if (!killProcessTree(proc, 'SIGTERM')) {
              resolve();
              return;
            }
            setTimeout(() => {
              if (proc.exitCode === null && proc.signalCode === null) {
                killProcessTree(proc, 'SIGKILL');
              }
              resolve();
            }, 3000);
          });
          stopPromises.push(promise);
        }
      }

      await Promise.all(stopPromises);
    }

    logger.info(
      { activeCount: this.activeCount },
      'SessionRuntimeQueue shutdown complete',
    );
  }
}

export { SessionRuntimeQueue as GroupQueue };
