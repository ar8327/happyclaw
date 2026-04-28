/**
 * Streaming Block Accumulator
 *
 * 后端持续累积 Agent 每轮操作的 blocks（tool call、compact、hook、text、thinking），
 * 前端随时打开都能通过 API 获取完整的历史 + 实时状态。
 */

import crypto from 'crypto';
import type { StreamEvent } from './stream-event.types.js';

// ── 类型定义 ──

export interface StreamingBlock {
  id: string;
  type: 'thinking' | 'tool' | 'text' | 'status' | 'hook';
  timestamp: number;
  endTimestamp?: number;
  // tool
  toolName?: string;
  toolUseId?: string;
  toolInputSummary?: string;
  skillName?: string;
  duration?: number;
  // text
  content?: string;
  // thinking
  thinkingText?: string;
  // status
  statusText?: string;
  // hook
  hookName?: string;
  hookEvent?: string;
  hookOutcome?: string;
}

// ── 常量 ──

const MAX_BLOCKS = 200;
const MAX_TEXT_LENGTH = 2000;

function describeLifecycleEvent(event: StreamEvent): string | null {
  switch (event.phase) {
    case 'compact_started':
      return event.trigger === 'synthetic_threshold'
        ? '开始 synthetic compact'
        : '开始 compact';
    case 'compact_completed':
      return 'compact 完成';
    case 'archive_started':
      return '开始 archive';
    case 'archive_completed':
      return 'archive 完成';
    default:
      return null;
  }
}

// ── Accumulator ──

interface ActiveToolEntry {
  toolName: string;
  toolUseId: string;
  startTime: number;
  skillName?: string;
  toolInputSummary?: string;
}

export class StreamingBlockAccumulator {
  private completedBlocks: StreamingBlock[] = [];
  private activeTools = new Map<string, ActiveToolEntry>();

  // 当前打开的 text/thinking segment
  private currentTextStart: number | null = null;
  private currentThinkingStart: number | null = null;

  // 累积状态（用于 currentState 快照 + block 内容）
  private partialText = '';
  private thinkingText = '';
  private isThinking = false;
  private systemStatus: string | null = null;
  private activeHook: { hookName: string; hookEvent: string } | null = null;

  feed(event: StreamEvent): void {
    switch (event.eventType) {
      case 'text_delta': {
        // 如果之前在 thinking → finalize thinking block
        if (this.currentThinkingStart !== null) {
          this.finalizeThinkingBlock();
        }
        // 开始或继续 text segment
        if (this.currentTextStart === null) {
          this.currentTextStart = Date.now();
        }
        this.partialText += event.text || '';
        if (this.partialText.length > MAX_TEXT_LENGTH) {
          this.partialText = this.partialText.slice(-MAX_TEXT_LENGTH);
        }
        this.isThinking = false;
        break;
      }

      case 'thinking_delta': {
        // 如果之前在 text → finalize text block
        if (this.currentTextStart !== null) {
          this.finalizeTextBlock();
        }
        // 开始或继续 thinking segment
        if (this.currentThinkingStart === null) {
          this.currentThinkingStart = Date.now();
        }
        this.thinkingText += event.text || '';
        if (this.thinkingText.length > MAX_TEXT_LENGTH) {
          this.thinkingText = this.thinkingText.slice(-MAX_TEXT_LENGTH);
        }
        this.isThinking = true;
        break;
      }

      case 'tool_use_start': {
        // Finalize open text/thinking blocks
        this.finalizeTextBlock();
        this.finalizeThinkingBlock();
        this.isThinking = false;

        const toolUseId = event.toolUseId || crypto.randomUUID();
        this.activeTools.set(toolUseId, {
          toolName: event.toolName || 'unknown',
          toolUseId,
          startTime: Date.now(),
          skillName: event.skillName,
          toolInputSummary: event.toolInputSummary,
        });
        break;
      }

      case 'tool_use_end': {
        const toolUseId = event.toolUseId || '';
        const tool = this.activeTools.get(toolUseId);
        if (tool) {
          const now = Date.now();
          this.pushBlock({
            id: tool.toolUseId,
            type: 'tool',
            timestamp: tool.startTime,
            endTimestamp: now,
            toolName: tool.toolName,
            toolUseId: tool.toolUseId,
            toolInputSummary: tool.toolInputSummary,
            skillName: tool.skillName,
            duration: Math.round((now - tool.startTime) / 100) / 10, // 1 decimal
          });
          this.activeTools.delete(toolUseId);
        }
        break;
      }

      case 'tool_progress': {
        const toolUseId = event.toolUseId || '';
        const existing = this.activeTools.get(toolUseId);
        if (existing) {
          if (event.skillName) existing.skillName = event.skillName;
          if (event.toolInputSummary)
            existing.toolInputSummary = event.toolInputSummary;
        }
        break;
      }

      case 'status': {
        this.finalizeTextBlock();
        this.finalizeThinkingBlock();
        this.systemStatus = event.statusText || null;
        if (event.statusText) {
          this.pushBlock({
            id: crypto.randomUUID(),
            type: 'status',
            timestamp: Date.now(),
            statusText: event.statusText,
          });
        }
        break;
      }

      case 'lifecycle': {
        this.finalizeTextBlock();
        this.finalizeThinkingBlock();
        const lifecycleText = describeLifecycleEvent(event);
        this.systemStatus = lifecycleText;
        if (lifecycleText) {
          this.pushBlock({
            id: crypto.randomUUID(),
            type: 'status',
            timestamp: Date.now(),
            statusText: lifecycleText,
          });
        }
        break;
      }

      case 'hook_started': {
        this.activeHook = {
          hookName: event.hookName || '',
          hookEvent: event.hookEvent || '',
        };
        break;
      }

      case 'hook_response': {
        this.pushBlock({
          id: crypto.randomUUID(),
          type: 'hook',
          timestamp: Date.now(),
          hookName: event.hookName,
          hookEvent: event.hookEvent,
          hookOutcome: event.hookOutcome,
        });
        this.activeHook = null;
        break;
      }

      // 其他事件类型不产生 block
      default:
        break;
    }
  }

  /** Finalize all open blocks and return the complete blocks list for this round. */
  finalize(): StreamingBlock[] {
    this.finalizeTextBlock();
    this.finalizeThinkingBlock();
    // Finalize any still-active tools (shouldn't happen normally)
    for (const tool of this.activeTools.values()) {
      const now = Date.now();
      this.pushBlock({
        id: tool.toolUseId,
        type: 'tool',
        timestamp: tool.startTime,
        endTimestamp: now,
        toolName: tool.toolName,
        toolUseId: tool.toolUseId,
        toolInputSummary: tool.toolInputSummary,
        skillName: tool.skillName,
        duration: Math.round((now - tool.startTime) / 100) / 10,
      });
    }
    this.activeTools.clear();
    return [...this.completedBlocks];
  }

  /** Reset for next round (new user message → agent reply cycle). */
  reset(): void {
    this.completedBlocks = [];
    this.activeTools.clear();
    this.currentTextStart = null;
    this.currentThinkingStart = null;
    this.partialText = '';
    this.thinkingText = '';
    this.isThinking = false;
    this.systemStatus = null;
    this.activeHook = null;
  }

  // ── Private helpers ──

  private pushBlock(block: StreamingBlock): void {
    this.completedBlocks.push(block);
    if (this.completedBlocks.length > MAX_BLOCKS) {
      this.completedBlocks = this.completedBlocks.slice(-MAX_BLOCKS);
    }
  }

  private finalizeTextBlock(): void {
    if (this.currentTextStart !== null && this.partialText) {
      this.pushBlock({
        id: crypto.randomUUID(),
        type: 'text',
        timestamp: this.currentTextStart,
        endTimestamp: Date.now(),
        content:
          this.partialText.length > MAX_TEXT_LENGTH
            ? this.partialText.slice(-MAX_TEXT_LENGTH)
            : this.partialText,
      });
    }
    this.currentTextStart = null;
    this.partialText = '';
  }

  private finalizeThinkingBlock(): void {
    if (this.currentThinkingStart !== null && this.thinkingText) {
      this.pushBlock({
        id: crypto.randomUUID(),
        type: 'thinking',
        timestamp: this.currentThinkingStart,
        endTimestamp: Date.now(),
        thinkingText:
          this.thinkingText.length > MAX_TEXT_LENGTH
            ? this.thinkingText.slice(-MAX_TEXT_LENGTH)
            : this.thinkingText,
      });
    }
    this.currentThinkingStart = null;
    this.thinkingText = '';
  }
}

// ── Manager (全局单例) ──

class StreamingBlocksManager {
  private accumulators = new Map<string, StreamingBlockAccumulator>();

  getOrCreate(folder: string): StreamingBlockAccumulator {
    let acc = this.accumulators.get(folder);
    if (!acc) {
      acc = new StreamingBlockAccumulator();
      this.accumulators.set(folder, acc);
    }
    return acc;
  }

  finalize(folder: string): StreamingBlock[] {
    const acc = this.accumulators.get(folder);
    if (!acc) return [];
    return acc.finalize();
  }

  reset(folder: string): void {
    const acc = this.accumulators.get(folder);
    if (acc) acc.reset();
  }

  remove(folder: string): void {
    this.accumulators.delete(folder);
  }
}

export const streamingBlocksManager = new StreamingBlocksManager();
