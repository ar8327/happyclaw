import type {
  RuntimeInput,
  RuntimeLaunchProfile,
  RuntimeOutput,
} from './runtime-runner.js';

export interface RunMutation {
  promptPreamble?: string;
  profileOverride?: Partial<RuntimeLaunchProfile>;
}

export interface RunDirective<FollowUp = never> {
  followUps?: FollowUp[];
}

export interface RunResult<FollowUp = never> {
  output: RuntimeOutput | null;
  terminalOutput: RuntimeOutput | null;
  error: Error | null;
  effectiveInput: RuntimeInput;
  effectiveProfile?: RuntimeLaunchProfile;
  followUps: FollowUp[];
}

export interface RuntimeExecutionHook<Context, FollowUp = never> {
  readonly name: string;
  beforeRun?(ctx: Context): Promise<RunMutation | void> | RunMutation | void;
  onOutput?(ctx: Context, output: RuntimeOutput): Promise<void> | void;
  afterRun?(
    ctx: Context,
    result: RunResult<FollowUp>,
  ): Promise<RunDirective<FollowUp> | void> | RunDirective<FollowUp> | void;
  onShutdown?(ctx: Context): Promise<void> | void;
}

interface RuntimeExecutorRunArgs<Context> {
  input: RuntimeInput;
  ctx: Context;
  launchProfile?: RuntimeLaunchProfile;
  execute: (
    input: RuntimeInput,
    onOutput: (output: RuntimeOutput) => Promise<void>,
    launchProfile?: RuntimeLaunchProfile,
  ) => Promise<RuntimeOutput>;
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function mergeLaunchProfiles(
  baseProfile: RuntimeLaunchProfile | undefined,
  override: Partial<RuntimeLaunchProfile>,
): RuntimeLaunchProfile {
  return {
    ...(baseProfile || {}),
    ...override,
  };
}

export class RuntimeRequestExecutor<Context, FollowUp = never> {
  constructor(
    private readonly hooks: RuntimeExecutionHook<Context, FollowUp>[],
  ) {}

  async run(args: RuntimeExecutorRunArgs<Context>): Promise<RunResult<FollowUp>> {
    const promptPreambles: string[] = [];
    let effectiveProfile = args.launchProfile;

    for (const hook of this.hooks) {
      const mutation = await hook.beforeRun?.(args.ctx);
      if (mutation?.promptPreamble?.trim()) {
        promptPreambles.push(mutation.promptPreamble.trim());
      }
      if (mutation?.profileOverride) {
        effectiveProfile = mergeLaunchProfiles(
          effectiveProfile,
          mutation.profileOverride,
        );
      }
    }

    const effectiveInput: RuntimeInput = {
      ...args.input,
      prompt:
        promptPreambles.length > 0
          ? `${promptPreambles.join('\n\n')}\n\n${args.input.prompt}`
          : args.input.prompt,
    };

    let terminalOutput: RuntimeOutput | null = null;
    let output: RuntimeOutput | null = null;
    let executionError: Error | null = null;

    try {
      output = await args.execute(
        effectiveInput,
        async (runtimeOutput) => {
          if (
            runtimeOutput.status === 'success' ||
            runtimeOutput.status === 'error' ||
            runtimeOutput.status === 'closed' ||
            runtimeOutput.status === 'drained'
          ) {
            terminalOutput = runtimeOutput;
          }
          for (const hook of this.hooks) {
            await hook.onOutput?.(args.ctx, runtimeOutput);
          }
        },
        effectiveProfile,
      );
    } catch (error) {
      executionError = toError(error);
    }

    const result: RunResult<FollowUp> = {
      output,
      terminalOutput,
      error: executionError,
      effectiveInput,
      effectiveProfile,
      followUps: [],
    };

    let finalizeError: Error | null = null;
    for (const hook of this.hooks) {
      try {
        const directive = await hook.afterRun?.(args.ctx, result);
        if (directive?.followUps?.length) {
          result.followUps.push(...directive.followUps);
        }
      } catch (error) {
        finalizeError = toError(error);
        break;
      }
    }

    if (executionError && finalizeError) {
      throw new AggregateError(
        [executionError, finalizeError],
        'Runtime execution failed and afterRun hook cleanup also failed',
      );
    }
    if (executionError) {
      throw executionError;
    }
    if (finalizeError) {
      throw finalizeError;
    }
    return result;
  }

  async shutdown(ctx: Context): Promise<void> {
    for (const hook of this.hooks) {
      await hook.onShutdown?.(ctx);
    }
  }
}
