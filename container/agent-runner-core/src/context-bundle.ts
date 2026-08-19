export type ContextStability = 'static' | 'session' | 'turn';

export type SectionId =
  | 'identity'
  | 'environment'
  | 'workspace-instructions'
  | 'global-instructions'
  | 'platform-guidelines'
  | 'context-summary'
  | 'channel-routing'
  | 'channel-routing-active'
  | 'memory-index'
  | 'skills-catalog'
  | `plugin:${string}`;

export interface ContextSection {
  id: SectionId;
  stability: ContextStability;
  content: string;
}

export interface ContextBundle {
  sections: ContextSection[];
}

export interface RenderContextBundleOptions {
  exclude?: Iterable<SectionId>;
  includeStabilities?: Iterable<ContextStability>;
}

export function renderContextBundle(
  bundle: ContextBundle,
  options?: RenderContextBundleOptions,
): string {
  const excluded = new Set(options?.exclude || []);
  const includedStabilities = options?.includeStabilities
    ? new Set(options.includeStabilities)
    : null;
  return bundle.sections
    .filter(
      (section) =>
        !excluded.has(section.id) &&
        (!includedStabilities || includedStabilities.has(section.stability)) &&
        section.content.length > 0,
    )
    .map((section) => section.content)
    .join('\n');
}
