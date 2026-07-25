import { execFile } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export type RunnerAuthProbeType = 'none' | 'required_env' | 'json_file';

export interface RunnerAuthProbeJsonField {
  name: string;
  path: string[];
}

export interface RunnerAuthProbeFile {
  envPath?: string;
  relativeToEnv?: string;
  relativeToHome?: string;
  path?: string;
  requiredJsonPaths?: string[][];
  requiredAnyJsonPaths?: string[][];
  detailJsonFields?: RunnerAuthProbeJsonField[];
}

export interface RunnerAuthProbe {
  type: RunnerAuthProbeType;
  anyEnv?: string[];
  requiredEnv?: string[];
  files?: RunnerAuthProbeFile[];
}

export interface RunnerRuntimeContractForHealth {
  requiredCommands?: string[];
  requiredEnv?: string[];
  modelCatalog?: RunnerModelCatalog;
  auth?: 'none' | 'api_key' | 'oauth' | 'external_cli';
  authProbe?: RunnerAuthProbe;
  versionArgs?: string[];
}

export interface RunnerModelCatalog {
  type: 'codex_models_cache';
  envPath?: string;
  relativeToEnv?: string;
  extraRelativeToEnv?: string[];
  relativeToHome?: string;
  extraRelativeToHome?: string[];
  defaultModelProvider?: string;
  path?: string;
}

export interface RunnerDescriptorForHealth {
  id: string;
  defaultModel?: string;
  models?: RunnerModel[];
  runtimeContract: RunnerRuntimeContractForHealth;
}

export interface RunnerHealth {
  runnerId: string;
  available: boolean;
  commandDetected?: boolean;
  authenticated?: boolean;
  version?: string;
  details?: Record<string, unknown>;
  missingReasons?: string[];
}

export interface RunnerModel {
  id: string;
  label?: string;
  description?: string;
  modelProvider?: string;
  supportedThinkingEfforts?: string[];
  backendVariants?: Array<{
    id: string;
    label?: string;
    contextWindow?: number;
  }>;
}

interface CodexCachedModel {
  slug?: unknown;
  display_name?: unknown;
  description?: unknown;
  visibility?: unknown;
  priority?: unknown;
  context_window?: unknown;
  model_provider_id?: unknown;
  business_metadata?: unknown;
  supported_reasoning_levels?: unknown;
}

interface CodexCachedModelEntry {
  model: CodexCachedModel;
  modelProviderFromPath: string | undefined;
}

type RunnerModelWithPriority = RunnerModel & {
  priority: number;
  modelProviderStrength?: number;
};

function reasoningEffortsFromCachedModel(
  model: CodexCachedModel,
): string[] | undefined {
  if (!Array.isArray(model.supported_reasoning_levels)) return undefined;
  return Array.from(
    new Set(
      model.supported_reasoning_levels
        .map((level) => {
          if (!level || typeof level !== 'object' || Array.isArray(level)) {
            return '';
          }
          const effort = (level as Record<string, unknown>).effort;
          return typeof effort === 'string' ? effort.trim().toLowerCase() : '';
        })
        .filter(Boolean),
    ),
  );
}

function expandHomePath(value: string): string {
  if (value === '~') return os.homedir();
  if (value.startsWith('~/')) return path.join(os.homedir(), value.slice(2));
  return value;
}

function resolveProbeFilePath(
  file: RunnerAuthProbeFile,
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
): string | null {
  if (file.envPath && env[file.envPath]) {
    const base = expandHomePath(String(env[file.envPath]));
    return file.relativeToEnv ? path.join(base, file.relativeToEnv) : base;
  }
  if (file.path) return expandHomePath(file.path);
  if (file.relativeToHome) return path.join(os.homedir(), file.relativeToHome);
  return null;
}

function resolveModelCatalogPath(
  catalog: RunnerModelCatalog,
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
): string | null {
  if (catalog.envPath && env[catalog.envPath]) {
    const base = expandHomePath(String(env[catalog.envPath]));
    return catalog.relativeToEnv
      ? path.join(base, catalog.relativeToEnv)
      : base;
  }
  if (catalog.path) return expandHomePath(catalog.path);
  if (catalog.relativeToHome) {
    return path.join(os.homedir(), catalog.relativeToHome);
  }
  return null;
}

function expandWildcardPath(pattern: string): string[] {
  if (!pattern.includes('*')) return [pattern];
  const segments = path.resolve(pattern).split(path.sep);
  const roots = segments[0] === '' ? [path.sep] : [segments[0]];
  const rest = segments.slice(1);
  return rest.reduce<string[]>((bases, segment) => {
    if (segment !== '*') return bases.map((base) => path.join(base, segment));
    return bases.flatMap((base) => {
      try {
        return fs
          .readdirSync(base, { withFileTypes: true })
          .filter((entry) => entry.isDirectory())
          .map((entry) => path.join(base, entry.name));
      } catch {
        return [];
      }
    });
  }, roots);
}

function resolveModelCatalogPaths(
  catalog: RunnerModelCatalog,
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
): string[] {
  const paths = new Set<string>();
  const primary = resolveModelCatalogPath(catalog, env);
  if (primary) paths.add(primary);
  if (catalog.envPath && env[catalog.envPath]) {
    const base = expandHomePath(String(env[catalog.envPath]));
    for (const relativePath of catalog.extraRelativeToEnv || []) {
      for (const filePath of expandWildcardPath(
        path.join(base, relativePath),
      )) {
        paths.add(filePath);
      }
    }
  }
  for (const relativePath of catalog.extraRelativeToHome || []) {
    for (const filePath of expandWildcardPath(
      path.join(os.homedir(), relativePath),
    )) {
      paths.add(filePath);
    }
  }
  return Array.from(paths);
}

function modelProviderFromCachePath(cachePath: string): string | undefined {
  const segments = path.normalize(cachePath).split(path.sep).filter(Boolean);
  const providerIndex = segments.lastIndexOf('model-provider');
  if (providerIndex >= 0 && providerIndex + 1 < segments.length) {
    return segments[providerIndex + 1] || undefined;
  }
  const catalogIndex = segments.lastIndexOf('model-catalog');
  if (catalogIndex >= 0 && catalogIndex + 1 < segments.length) {
    return segments[catalogIndex + 1] || undefined;
  }
  return undefined;
}

function readPath(value: unknown, jsonPath: string[]): unknown {
  let current = value;
  for (const segment of jsonPath) {
    if (!current || typeof current !== 'object' || Array.isArray(current)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function hasValue(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === 'string') return value.length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value).length > 0;
  return true;
}

function maskDetailValue(name: string, value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const lower = name.toLowerCase();
  const sensitive =
    lower.includes('token') ||
    lower.includes('secret') ||
    lower.includes('key') ||
    lower.includes('account');
  if (!sensitive) return value;
  if (value.length <= 8) return '****';
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

function probeJsonFile(
  file: RunnerAuthProbeFile,
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
): {
  detected: boolean;
  authenticated: boolean;
  path?: string;
  details: Record<string, unknown>;
} {
  const filePath = resolveProbeFilePath(file, env);
  if (!filePath) return { detected: false, authenticated: false, details: {} };
  if (!fs.existsSync(filePath)) {
    return {
      detected: false,
      authenticated: false,
      path: filePath,
      details: {},
    };
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as unknown;
    const requiredJsonPaths = file.requiredJsonPaths || [];
    const requiredAnyJsonPaths = file.requiredAnyJsonPaths || [];
    const authenticated =
      requiredJsonPaths.every((jsonPath) =>
        hasValue(readPath(parsed, jsonPath)),
      ) &&
      (requiredAnyJsonPaths.length === 0 ||
        requiredAnyJsonPaths.some((jsonPath) =>
          hasValue(readPath(parsed, jsonPath)),
        ));
    const details: Record<string, unknown> = {};
    for (const field of file.detailJsonFields || []) {
      const value = readPath(parsed, field.path);
      if (value !== undefined) {
        details[field.name] = maskDetailValue(field.name, value);
      }
    }
    return { detected: true, authenticated, path: filePath, details };
  } catch {
    return {
      detected: true,
      authenticated: false,
      path: filePath,
      details: { parseError: true },
    };
  }
}

export function evaluateRunnerAuthProbe(
  probe: RunnerAuthProbe | undefined,
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): {
  authenticated: boolean;
  detected: boolean;
  details: Record<string, unknown>;
  missingReasons: string[];
} {
  if (!probe || probe.type === 'none') {
    return {
      authenticated: true,
      detected: true,
      details: {},
      missingReasons: [],
    };
  }

  const missingReasons: string[] = [];
  const requiredEnv = probe.requiredEnv || [];
  const missingRequiredEnv = requiredEnv.filter((name) => !env[name]);
  for (const name of missingRequiredEnv) {
    missingReasons.push(`缺少环境变量 ${name}`);
  }

  const anyEnv = probe.anyEnv || [];
  const authEnvDetected = anyEnv.filter((name) => !!env[name]);
  if (authEnvDetected.length > 0) {
    return {
      authenticated: missingRequiredEnv.length === 0,
      detected: true,
      details: { authEnvDetected },
      missingReasons,
    };
  }

  if (probe.type === 'required_env') {
    return {
      authenticated: missingRequiredEnv.length === 0,
      detected: missingRequiredEnv.length === 0,
      details: {},
      missingReasons,
    };
  }

  const fileResults = (probe.files || []).map((file) =>
    probeJsonFile(file, env),
  );
  const authenticatedFile = fileResults.find((result) => result.authenticated);
  const details: Record<string, unknown> = {
    files: fileResults.map((result) => ({
      path: result.path,
      detected: result.detected,
      authenticated: result.authenticated,
      details: result.details,
    })),
  };
  if (authenticatedFile) {
    Object.assign(details, authenticatedFile.details);
  } else {
    missingReasons.push('runner 尚未认证');
  }

  return {
    authenticated: !!authenticatedFile && missingRequiredEnv.length === 0,
    detected: fileResults.some((result) => result.detected),
    details,
    missingReasons,
  };
}

export function runnerAuthAvailable(
  descriptor: RunnerDescriptorForHealth | undefined,
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): boolean {
  if (!descriptor) return false;
  if (descriptor.runtimeContract.auth === 'none') return true;
  if (descriptor.runtimeContract.authProbe) {
    return evaluateRunnerAuthProbe(descriptor.runtimeContract.authProbe, env)
      .authenticated;
  }
  if (descriptor.runtimeContract.auth === 'api_key') {
    return (descriptor.runtimeContract.requiredEnv || []).every(
      (name) => !!env[name],
    );
  }
  return false;
}

async function detectCommandVersion(
  command: string,
  versionArgs: string[],
): Promise<string | undefined> {
  try {
    const result = await execFileAsync(command, versionArgs, {
      timeout: 3000,
      windowsHide: true,
    });
    return (result.stdout || result.stderr).trim().split('\n')[0] || undefined;
  } catch {
    return undefined;
  }
}

export function modelsForDescriptor(
  descriptor: RunnerDescriptorForHealth,
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): RunnerModel[] {
  const catalogModels = modelsFromCatalog(
    descriptor.runtimeContract.modelCatalog,
    env,
  );
  if (catalogModels.length > 0) {
    return catalogModels;
  }
  if (descriptor.models && descriptor.models.length > 0) {
    return descriptor.models;
  }
  return descriptor.defaultModel
    ? [{ id: descriptor.defaultModel, label: descriptor.defaultModel }]
    : [];
}

function modelsFromCatalog(
  catalog: RunnerModelCatalog | undefined,
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
): RunnerModel[] {
  if (!catalog) return [];
  if (catalog.type === 'codex_models_cache') {
    return modelsFromCodexCache(catalog, env);
  }
  return [];
}

function modelsFromCodexCache(
  catalog: RunnerModelCatalog,
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
): RunnerModel[] {
  const cachePaths = resolveModelCatalogPaths(catalog, env).filter(
    (cachePath) => fs.existsSync(cachePath),
  );
  if (cachePaths.length === 0) return [];

  try {
    const models = cachePaths.flatMap((cachePath) => {
      const parsed = JSON.parse(fs.readFileSync(cachePath, 'utf-8')) as {
        models?: unknown;
      };
      const modelProviderFromPath = modelProviderFromCachePath(cachePath);
      return Array.isArray(parsed.models)
        ? parsed.models.map((model) => ({ model, modelProviderFromPath }))
        : [];
    });
    const byId = new Map<string, RunnerModelWithPriority>();
    for (const model of models
      .filter((entry): entry is CodexCachedModelEntry => {
        const model = entry.model;
        if (!model || typeof model !== 'object' || Array.isArray(model)) {
          return false;
        }
        return model.visibility === 'list' && typeof model.slug === 'string';
      })
      .map((entry): RunnerModelWithPriority => {
        const { model } = entry;
        const variants =
          model.business_metadata &&
          typeof model.business_metadata === 'object' &&
          !Array.isArray(model.business_metadata)
            ? (model.business_metadata as Record<string, unknown>).variants
            : undefined;
        const variantsRecord =
          variants && typeof variants === 'object' && !Array.isArray(variants)
            ? (variants as Record<string, unknown>)
            : {};
        const standardContext =
          typeof variantsRecord.standard_context_window === 'number'
            ? variantsRecord.standard_context_window
            : typeof model.context_window === 'number'
              ? model.context_window
              : undefined;
        const maxContext =
          typeof variantsRecord.max_context_window === 'number'
            ? variantsRecord.max_context_window
            : undefined;
        const hasStandard = typeof variantsRecord.standard_key === 'string';
        const hasMax = typeof variantsRecord.max_key === 'string';
        const explicitModelProvider =
          typeof model.model_provider_id === 'string' &&
          model.model_provider_id.trim()
            ? model.model_provider_id.trim()
            : undefined;
        const modelProvider =
          explicitModelProvider ||
          entry.modelProviderFromPath ||
          catalog.defaultModelProvider;
        const modelProviderStrength = explicitModelProvider
          ? 3
          : entry.modelProviderFromPath
            ? 2
            : catalog.defaultModelProvider
              ? 1
              : 0;
        const supportedThinkingEfforts = reasoningEffortsFromCachedModel(model);
        return {
          id: String(model.slug),
          label:
            typeof model.display_name === 'string' && model.display_name.trim()
              ? model.display_name
              : String(model.slug),
          description:
            typeof model.description === 'string'
              ? model.description
              : undefined,
          ...(modelProvider ? { modelProvider } : {}),
          ...(supportedThinkingEfforts !== undefined
            ? { supportedThinkingEfforts }
            : {}),
          backendVariants:
            hasStandard || hasMax
              ? [
                  ...(hasStandard
                    ? [
                        {
                          id: 'standard',
                          label: 'Standard',
                          contextWindow: standardContext,
                        },
                      ]
                    : []),
                  ...(hasMax
                    ? [
                        {
                          id: 'max',
                          label: 'Max',
                          contextWindow: maxContext,
                        },
                      ]
                    : []),
                ]
              : undefined,
          priority:
            typeof model.priority === 'number' &&
            Number.isFinite(model.priority)
              ? model.priority
              : 999,
          modelProviderStrength,
        };
      })) {
      const existing = byId.get(model.id);
      if (!existing) {
        byId.set(model.id, model);
        continue;
      }
      const existingStrength = existing.modelProviderStrength || 0;
      const candidateStrength = model.modelProviderStrength || 0;
      if (candidateStrength > existingStrength) {
        existing.modelProvider = model.modelProvider;
        existing.modelProviderStrength = model.modelProviderStrength;
        existing.supportedThinkingEfforts =
          model.supportedThinkingEfforts === undefined
            ? undefined
            : [...model.supportedThinkingEfforts];
        existing.backendVariants = model.backendVariants
          ? [...model.backendVariants]
          : undefined;
      } else if (
        candidateStrength === existingStrength &&
        existing.modelProvider === model.modelProvider
      ) {
        if (
          existing.supportedThinkingEfforts === undefined &&
          model.supportedThinkingEfforts !== undefined
        ) {
          existing.supportedThinkingEfforts = [
            ...model.supportedThinkingEfforts,
          ];
        }
        if (!existing.backendVariants && model.backendVariants) {
          existing.backendVariants = [...model.backendVariants];
        }
      }
    }
    return Array.from(byId.values())
      .sort((a, b) => a.priority - b.priority)
      .map(
        ({
          priority: _priority,
          modelProviderStrength: _modelProviderStrength,
          ...model
        }) => model,
      );
  } catch {
    return [];
  }
}

export async function buildRunnerHealth(
  descriptor: RunnerDescriptorForHealth,
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): Promise<RunnerHealth> {
  const commands = descriptor.runtimeContract.requiredCommands || [];
  const versionArgs = descriptor.runtimeContract.versionArgs || ['--version'];
  const commandResults = await Promise.all(
    commands.map(async (command) => ({
      command,
      version: await detectCommandVersion(command, versionArgs),
    })),
  );
  const missingCommands = commandResults
    .filter((result) => !result.version)
    .map((result) => result.command);
  const commandDetected = missingCommands.length === 0;
  const authResult =
    descriptor.runtimeContract.auth === 'none'
      ? {
          authenticated: true,
          detected: true,
          details: {},
          missingReasons: [],
        }
      : evaluateRunnerAuthProbe(descriptor.runtimeContract.authProbe, env);
  const missingReasons = [
    ...missingCommands.map((command) => `找不到命令 ${command}`),
    ...authResult.missingReasons,
  ];

  return {
    runnerId: descriptor.id,
    available:
      commandDetected &&
      authResult.authenticated &&
      missingReasons.length === 0,
    commandDetected,
    authenticated: authResult.authenticated,
    version: commandResults.find((result) => result.version)?.version,
    details: {
      commands: commandResults,
      authDetected: authResult.detected,
      ...authResult.details,
    },
    missingReasons,
  };
}

export const descriptorModels = modelsForDescriptor;
export const descriptorHealthCheck = buildRunnerHealth;
