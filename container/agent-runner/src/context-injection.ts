/**
 * 共享的上下文增量投递。
 *
 * ContextBundle 每轮都会重新构造，但把整份 bundle 每轮重传给模型有两个代价：
 * 载体是 system 时会打断 prompt cache 前缀，载体是会话历史时会不断累积副本。
 * 这里按 section 内容 hash 计算「本轮真正需要重投的段」，claude（user_prefix）
 * 与 codex（thread/inject_items）共用同一份计划与渲染，避免两个 runner 各写一套。
 *
 * 语义约定：
 * - 内容变化的 section 会带 `supersedesPrevious`，渲染时显式作废更早的同名副本。
 * - 消失的 section 会投递一条失效说明，避免模型继续引用已撤下的上下文。
 */

import crypto from 'crypto';

import type { ContextSection } from 'agentdock-agent-runner-core';

export interface ContextInjectionSection {
  id: string;
  content: string;
  /** 此前已投递过同名 section 的旧副本，本次是替换版本。 */
  supersedesPrevious?: boolean;
}

export interface ContextInjectionPlan {
  changed: ContextInjectionSection[];
  nextHashes: Map<string, string>;
}

export interface ContextInjectionOptions {
  /** 会话锚点发生变化（换 thread / 换 provider session），此前投递的副本一律不可复用。 */
  threadChanged: boolean;
  /** 全新会话：static 与 session 段由载体本身（instructions 文件 / system prompt）提供，无需重复投递。 */
  freshThread: boolean;
}

export function planContextInjection(
  previousHashes: ReadonlyMap<string, string>,
  sections: ContextSection[],
  options: ContextInjectionOptions,
): ContextInjectionPlan {
  const nextHashes = new Map<string, string>(
    sections.map((section) => [
      section.id,
      crypto.createHash('sha256').update(section.content).digest('hex'),
    ]),
  );
  const changed: ContextInjectionSection[] = sections
    .filter((section) => {
      if (
        options.freshThread &&
        options.threadChanged &&
        section.stability !== 'turn'
      ) {
        return false;
      }
      return (
        options.threadChanged ||
        previousHashes.get(section.id) !== nextHashes.get(section.id)
      );
    })
    .map((section) => ({
      id: section.id,
      content: section.content,
      // 换 thread 后模型看不到旧副本，标注 supersedes 只会制造噪声
      supersedesPrevious:
        !options.threadChanged && previousHashes.has(section.id),
    }));
  if (!options.freshThread) {
    for (const previousId of previousHashes.keys()) {
      if (nextHashes.has(previousId)) continue;
      changed.push({
        id: previousId,
        content: `The previous HappyClaw context section "${previousId}" no longer applies. Ignore its earlier content.`,
      });
    }
  }
  return { changed, nextHashes };
}

/**
 * 把待投递的 section 渲染成一段文本。
 * codex 作为 developer message 的正文，claude 作为用户消息的前缀。
 */
export function renderContextInjectionText(
  sections: ContextInjectionSection[],
): string {
  return sections
    .map((section) => {
      const attrs = section.supersedesPrevious
        ? ` section="${section.id}" supersedes-previous="true"`
        : ` section="${section.id}"`;
      const notice = section.supersedesPrevious
        ? '[此段取代此前同名 section 的旧副本，以本段为准，忽略更早的副本。]\n'
        : '';
      return `<happyclaw-context${attrs}>\n${notice}${section.content}\n</happyclaw-context>`;
    })
    .join('\n\n');
}
