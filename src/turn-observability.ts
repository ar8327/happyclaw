import crypto from 'crypto';

import type { StreamEvent } from './stream-event.types.js';
import type { ActiveTurn } from './turn-manager.js';

export interface TurnObservabilityTimelineEvent {
  id: string;
  timestamp: number;
  kind: 'runner' | 'tool' | 'skill' | 'hook' | 'status';
  text: string;
}

export interface TurnObservabilityStreamingState {
  partialText: string;
  thinkingText: string;
  isThinking: boolean;
  activeTools: Array<{
    toolName: string;
    toolUseId: string;
    startTime: number;
    elapsedSeconds?: number;
    parentToolUseId?: string | null;
    isNested?: boolean;
    skillName?: string;
    toolInputSummary?: string;
    toolInput?: Record<string, unknown>;
  }>;
  activeHook: { hookName: string; hookEvent: string } | null;
  systemStatus: string | null;
  recentEvents: TurnObservabilityTimelineEvent[];
  todos?: Array<{
    id: string;
    content: string;
    status: 'pending' | 'in_progress' | 'completed';
  }>;
}

export interface TurnObservabilitySnapshot {
  turnId: string;
  chatJid: string;
  channel: string;
  messageCount: number;
  startedAt: string;
  runnerState: {
    state:
      | 'queued'
      | 'capacity_wait'
      | 'starting'
      | 'interrupting'
      | 'running'
      | 'interrupted'
      | 'completed'
      | 'error'
      | 'drained';
    detail?: string;
    updatedAt: string;
  } | null;
  pendingBuffer: Array<{ channel: string; count: number }>;
  lastEventAt?: string;
  lastInterruptAt?: string;
  streaming: TurnObservabilityStreamingState;
}

interface TurnRuntimeState extends TurnObservabilitySnapshot {}

const MAX_EVENT_LOG = 30;
const MAX_STREAMING_TEXT = 8000;

const EMPTY_STREAMING: TurnObservabilityStreamingState = {
  partialText: '',
  thinkingText: '',
  isThinking: false,
  activeTools: [],
  activeHook: null,
  systemStatus: null,
  recentEvents: [],
};

function makeEmptyState(turn: ActiveTurn): TurnRuntimeState {
  return {
    turnId: turn.id,
    chatJid: turn.chatJid,
    channel: turn.channel,
    messageCount: turn.messageIds.length,
    startedAt: new Date(turn.startedAt).toISOString(),
    runnerState: null,
    pendingBuffer: [],
    streaming: {
      partialText: '',
      thinkingText: '',
      isThinking: false,
      activeTools: [],
      activeHook: null,
      systemStatus: null,
      recentEvents: [],
    },
  };
}

function pushEvent(
  events: TurnObservabilityTimelineEvent[],
  kind: TurnObservabilityTimelineEvent['kind'],
  text: string,
): TurnObservabilityTimelineEvent[] {
  return [
    ...events,
    {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      timestamp: Date.now(),
      kind,
      text,
    },
  ].slice(-MAX_EVENT_LOG);
}

function runnerStateText(state: string, detail?: string): string {
  switch (state) {
    case 'queued':
      return detail ? `排队中 · ${detail}` : '排队中';
    case 'capacity_wait':
      return detail ? `等待资源 · ${detail}` : '等待资源';
    case 'starting':
      return detail ? `启动中 · ${detail}` : '启动中';
    case 'interrupting':
      return detail ? `正在中断 · ${detail}` : '正在中断';
    case 'running':
      return detail ? `执行中 · ${detail}` : '执行中';
    case 'interrupted':
      return detail ? `已中断 · ${detail}` : '已中断';
    case 'completed':
      return '已完成';
    case 'error':
      return detail ? `出错 · ${detail}` : '出错';
    case 'drained':
      return '已切换到下一轮';
    default:
      return state;
  }
}

class TurnObservabilityManager {
  private states = new Map<string, TurnRuntimeState>();

  private ensureState(folder: string, turn?: ActiveTurn | null): TurnRuntimeState | null {
    let state = this.states.get(folder) || null;
    if (!state && turn) {
      state = makeEmptyState(turn);
      this.states.set(folder, state);
    }
    if (state && turn) {
      state.turnId = turn.id;
      state.chatJid = turn.chatJid;
      state.channel = turn.channel;
      state.messageCount = turn.messageIds.length;
      state.startedAt = new Date(turn.startedAt).toISOString();
    }
    return state;
  }

  beginTurn(folder: string, turn: ActiveTurn): void {
    const existing = this.states.get(folder);
    const next = makeEmptyState(turn);
    if (existing?.pendingBuffer?.length) {
      next.pendingBuffer = [...existing.pendingBuffer];
    }
    this.states.set(folder, next);
  }

  syncTurn(folder: string, turn: ActiveTurn | null): void {
    if (!turn) return;
    this.ensureState(folder, turn);
  }

  setPendingCounts(folder: string, counts: Map<string, number>): void {
    const state = this.states.get(folder);
    if (!state) return;
    state.pendingBuffer = Array.from(counts.entries())
      .filter(([, count]) => count > 0)
      .map(([channel, count]) => ({ channel, count }))
      .sort((a, b) => a.channel.localeCompare(b.channel));
  }

  setRunnerState(
    folder: string,
    stateName:
      | 'queued'
      | 'capacity_wait'
      | 'starting'
      | 'interrupting'
      | 'running'
      | 'interrupted'
      | 'completed'
      | 'error'
      | 'drained',
    detail?: string,
    turn?: ActiveTurn | null,
  ): void {
    const state = this.ensureState(folder, turn);
    if (!state) return;
    state.runnerState = {
      state: stateName,
      ...(detail ? { detail } : {}),
      updatedAt: new Date().toISOString(),
    };
    state.streaming.recentEvents = pushEvent(
      state.streaming.recentEvents,
      'runner',
      runnerStateText(stateName, detail),
    );
  }

  feedEvent(folder: string, event: StreamEvent, turn?: ActiveTurn | null): void {
    const state = this.ensureState(folder, turn);
    if (!state) return;

    const nowIso = new Date().toISOString();
    state.lastEventAt = nowIso;
    if (!state.runnerState || state.runnerState.state !== 'running') {
      state.runnerState = {
        state: 'running',
        updatedAt: nowIso,
      };
    } else {
      state.runnerState.updatedAt = nowIso;
    }

    const prev = state.streaming;
    const next: TurnObservabilityStreamingState = {
      partialText: prev.partialText,
      thinkingText: prev.thinkingText,
      isThinking: prev.isThinking,
      activeTools: [...prev.activeTools],
      activeHook: prev.activeHook ? { ...prev.activeHook } : null,
      systemStatus: prev.systemStatus,
      recentEvents: [...prev.recentEvents],
      ...(prev.todos ? { todos: prev.todos.map((t) => ({ ...t })) } : {}),
    };

    switch (event.eventType) {
      case 'text_delta': {
        const combined = prev.partialText + (event.text || '');
        next.partialText =
          combined.length > MAX_STREAMING_TEXT
            ? combined.slice(-MAX_STREAMING_TEXT)
            : combined;
        next.isThinking = false;
        break;
      }
      case 'thinking_delta': {
        const combined = prev.thinkingText + (event.text || '');
        next.thinkingText =
          combined.length > MAX_STREAMING_TEXT
            ? combined.slice(-MAX_STREAMING_TEXT)
            : combined;
        next.isThinking = true;
        break;
      }
      case 'tool_use_start': {
        next.isThinking = false;
        const toolUseId = event.toolUseId || crypto.randomUUID();
        const existing = prev.activeTools.find(
          (tool) => tool.toolUseId === toolUseId,
        );
        const tool = {
          toolName: event.toolName || 'unknown',
          toolUseId,
          startTime: Date.now(),
          parentToolUseId: event.parentToolUseId,
          isNested: event.isNested,
          skillName: event.skillName,
          toolInputSummary: event.toolInputSummary,
        };
        next.activeTools = existing
          ? prev.activeTools.map((item) =>
              item.toolUseId === toolUseId ? { ...item, ...tool } : item,
            )
          : [...prev.activeTools, tool];
        const isSkill = tool.toolName === 'Skill';
        const label = isSkill
          ? `技能 ${tool.skillName || 'unknown'}`
          : `工具 ${tool.toolName}`;
        const detailText = tool.toolInputSummary
          ? ` · ${tool.toolInputSummary}`
          : '';
        next.recentEvents = pushEvent(
          prev.recentEvents,
          isSkill ? 'skill' : 'tool',
          `${label}${detailText}`,
        );
        break;
      }
      case 'tool_use_end': {
        if (event.toolUseId) {
          const ended = prev.activeTools.find(
            (tool) => tool.toolUseId === event.toolUseId,
          );
          next.activeTools = prev.activeTools.filter(
            (tool) => tool.toolUseId !== event.toolUseId,
          );
          if (ended) {
            const rawSec = (Date.now() - ended.startTime) / 1000;
            const elapsedSec =
              rawSec % 1 === 0 ? rawSec.toFixed(0) : rawSec.toFixed(1);
            const isSkill = ended.toolName === 'Skill';
            const label = isSkill
              ? `技能 ${ended.skillName || 'unknown'}`
              : `工具 ${ended.toolName}`;
            next.recentEvents = pushEvent(
              prev.recentEvents,
              isSkill ? 'skill' : 'tool',
              `完成 ${label} · ${elapsedSec}s`,
            );
          }
        } else {
          next.activeTools = [];
        }
        break;
      }
      case 'tool_progress': {
        const existing = prev.activeTools.find(
          (tool) => tool.toolUseId === event.toolUseId,
        );
        if (existing) {
          next.activeTools = prev.activeTools.map((tool) =>
            tool.toolUseId === event.toolUseId
              ? {
                  ...tool,
                  elapsedSeconds: event.elapsedSeconds,
                  ...(event.skillName ? { skillName: event.skillName } : {}),
                  ...(event.toolInput ? { toolInput: event.toolInput } : {}),
                }
              : tool,
          );
        } else {
          next.activeTools = [
            ...prev.activeTools,
            {
              toolName: event.toolName || 'unknown',
              toolUseId: event.toolUseId || crypto.randomUUID(),
              startTime: Date.now(),
              parentToolUseId: event.parentToolUseId,
              isNested: event.isNested,
              elapsedSeconds: event.elapsedSeconds,
              ...(event.toolInput ? { toolInput: event.toolInput } : {}),
            },
          ];
        }
        break;
      }
      case 'hook_started': {
        next.activeHook = {
          hookName: event.hookName || '',
          hookEvent: event.hookEvent || '',
        };
        next.recentEvents = pushEvent(
          prev.recentEvents,
          'hook',
          `Hook 开始 · ${event.hookName || 'unknown'}`,
        );
        break;
      }
      case 'hook_progress': {
        next.activeHook = {
          hookName: event.hookName || '',
          hookEvent: event.hookEvent || '',
        };
        break;
      }
      case 'hook_response': {
        next.activeHook = null;
        next.recentEvents = pushEvent(
          prev.recentEvents,
          'hook',
          `Hook 结束 · ${event.hookName || 'unknown'} · ${event.hookOutcome || 'success'}`,
        );
        break;
      }
      case 'todo_update': {
        if (event.todos) {
          next.todos = event.todos.map((todo) => ({ ...todo }));
        }
        break;
      }
      case 'status': {
        next.systemStatus = event.statusText || null;
        if (event.statusText) {
          next.recentEvents = pushEvent(
            prev.recentEvents,
            'status',
            `状态 · ${event.statusText}`,
          );
          if (event.statusText === 'interrupted') {
            state.lastInterruptAt = nowIso;
            state.runnerState = {
              state: 'interrupted',
              updatedAt: nowIso,
            };
          }
        }
        break;
      }
      default:
        break;
    }

    state.streaming = next;
  }

  markInterrupted(folder: string, turn?: ActiveTurn | null, detail?: string): void {
    const state = this.ensureState(folder, turn);
    if (!state) return;
    const nowIso = new Date().toISOString();
    state.lastInterruptAt = nowIso;
    state.runnerState = {
      state: 'interrupted',
      ...(detail ? { detail } : {}),
      updatedAt: nowIso,
    };
    state.streaming.recentEvents = pushEvent(
      state.streaming.recentEvents,
      'runner',
      runnerStateText('interrupted', detail),
    );
  }

  get(folder: string): TurnObservabilitySnapshot | null {
    const state = this.states.get(folder);
    if (!state) return null;
    return {
      turnId: state.turnId,
      chatJid: state.chatJid,
      channel: state.channel,
      messageCount: state.messageCount,
      startedAt: state.startedAt,
      runnerState: state.runnerState ? { ...state.runnerState } : null,
      pendingBuffer: state.pendingBuffer.map((entry) => ({ ...entry })),
      ...(state.lastEventAt ? { lastEventAt: state.lastEventAt } : {}),
      ...(state.lastInterruptAt ? { lastInterruptAt: state.lastInterruptAt } : {}),
      streaming: {
        partialText: state.streaming.partialText,
        thinkingText: state.streaming.thinkingText,
        isThinking: state.streaming.isThinking,
        activeTools: state.streaming.activeTools.map((tool) => ({
          ...tool,
          ...(tool.toolInput
            ? { toolInput: { ...tool.toolInput } }
            : {}),
        })),
        activeHook: state.streaming.activeHook
          ? { ...state.streaming.activeHook }
          : null,
        systemStatus: state.streaming.systemStatus,
        recentEvents: state.streaming.recentEvents.map((event) => ({ ...event })),
        ...(state.streaming.todos
          ? {
              todos: state.streaming.todos.map((todo) => ({ ...todo })),
            }
          : {}),
      },
    };
  }

  clear(folder: string): void {
    this.states.delete(folder);
  }
}

export const turnObservabilityManager = new TurnObservabilityManager();
