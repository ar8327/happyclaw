export type ContextStability = 'static' | 'session' | 'turn';

export type SectionId =
  | 'identity'
  | 'environment'
  | 'workspace-instructions'
  | 'global-instructions'
  | 'platform-guidelines'
  | 'context-summary'
  | 'channel-routing'
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
  globalInstructionsStyle?: 'section' | 'raw';
}

const GLOBAL_SECTION_PREFIX = '## Global Instructions\n\n';

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
    .map((section) => {
      if (
        section.id === 'global-instructions' &&
        options?.globalInstructionsStyle === 'raw' &&
        section.content.startsWith(GLOBAL_SECTION_PREFIX)
      ) {
        return section.content.slice(GLOBAL_SECTION_PREFIX.length, -1);
      }
      return section.content;
    })
    .join('\n');
}

export function splitRenderedContext(bundle: ContextBundle): {
  sessionStatic: string;
  turnDynamic: string;
} {
  return {
    sessionStatic: renderContextBundle(bundle, {
      includeStabilities: ['static', 'session'],
    }),
    turnDynamic: renderContextBundle(bundle, {
      includeStabilities: ['turn'],
    }),
  };
}
