import {
  CODE_PUPPY_DEFAULT_MODEL,
  type CodePuppySettings,
  type RuntimeMode,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";

import * as AcpSessionRuntime from "./AcpSessionRuntime.ts";

/**
 * Code Puppy advertises no ACP auth methods and answers any `authenticate` with an
 * empty result, since it reads credentials from its own `~/.code_puppy` config. The
 * shared runtime always sends `authenticate`, so this id only has to be non-empty.
 */
const CODE_PUPPY_AUTH_METHOD_ID = "code-puppy";

type CodePuppyAcpRuntimeSettings = Pick<CodePuppySettings, "binaryPath">;

export interface CodePuppyAcpRuntimeInput extends Omit<
  AcpSessionRuntime.AcpSessionRuntimeOptions,
  "authMethodId" | "clientCapabilities" | "spawn"
> {
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly codePuppySettings: CodePuppyAcpRuntimeSettings | null | undefined;
  readonly environment?: NodeJS.ProcessEnv;
  readonly runtimeMode?: RuntimeMode;
}

/**
 * `--yolo true` lets Code Puppy run file writes and shell commands without asking.
 * Every other mode keeps approvals on, so writes and commands arrive as
 * `session/request_permission`. Code Puppy has no edits-only approval tier, so
 * auto-accept-edits also asks.
 */
export function codePuppyAcpSpawnArgs(runtimeMode?: RuntimeMode): ReadonlyArray<string> {
  switch (runtimeMode) {
    case "auto":
    case "full-access":
      return ["--acp", "--yolo", "true"];
    case "approval-required":
    case "auto-accept-edits":
    default:
      return ["--acp", "--yolo", "false"];
  }
}

export function buildCodePuppyAcpSpawnInput(
  codePuppySettings: CodePuppyAcpRuntimeSettings | null | undefined,
  cwd: string,
  environment?: NodeJS.ProcessEnv,
  runtimeMode?: RuntimeMode,
): AcpSessionRuntime.AcpSpawnInput {
  return {
    command: codePuppySettings?.binaryPath || "code-puppy",
    args: [...codePuppyAcpSpawnArgs(runtimeMode)],
    cwd,
    ...(environment ? { env: environment } : {}),
  };
}

export const makeCodePuppyAcpRuntime = (
  input: CodePuppyAcpRuntimeInput,
): Effect.Effect<
  AcpSessionRuntime.AcpSessionRuntime["Service"],
  EffectAcpErrors.AcpError,
  Crypto.Crypto | Scope.Scope
> =>
  Effect.gen(function* () {
    const acpContext = yield* Layer.build(
      AcpSessionRuntime.layer({
        ...input,
        spawn: buildCodePuppyAcpSpawnInput(
          input.codePuppySettings,
          input.cwd,
          input.environment,
          input.runtimeMode,
        ),
        authMethodId: CODE_PUPPY_AUTH_METHOD_ID,
      }).pipe(
        Layer.provide(
          Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, input.childProcessSpawner),
        ),
      ),
    );
    return yield* Effect.service(AcpSessionRuntime.AcpSessionRuntime).pipe(
      Effect.provide(acpContext),
    );
  });

/** Code Puppy exposes its models as the `model` select config option on `session/new`. */
function findCodePuppyModelConfig(
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption> | null | undefined,
) {
  const config = configOptions?.find(
    (option) => option.id === "model" || option.category === "model",
  );
  return config?.type === "select" ? config : undefined;
}

export function codePuppyModelOptions(
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption> | null | undefined,
): ReadonlyArray<{ readonly value: string; readonly name: string }> {
  const config = findCodePuppyModelConfig(configOptions);
  if (!config) return [];
  return config.options.flatMap((entry) => ("value" in entry ? [entry] : entry.options));
}

export function currentCodePuppyModel(
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption> | null | undefined,
): string | undefined {
  const current = findCodePuppyModelConfig(configOptions)?.currentValue;
  return typeof current === "string" && current.trim() ? current.trim() : undefined;
}

/**
 * Selects the requested model through `session/set_config_option`. The default slug
 * means "keep the session's current model" and is never sent over the wire. Returns
 * the model the session runs on afterwards.
 */
export const applyCodePuppyAcpModelSelection = Effect.fn("applyCodePuppyAcpModelSelection")(
  function* <E>(input: {
    readonly runtime: Pick<
      AcpSessionRuntime.AcpSessionRuntime["Service"],
      "getConfigOptions" | "setModel"
    >;
    readonly model: string | null | undefined;
    readonly mapError: (cause: EffectAcpErrors.AcpError) => E;
  }): Effect.fn.Return<string | undefined, E> {
    const configOptions = yield* input.runtime.getConfigOptions;
    const current = currentCodePuppyModel(configOptions);
    const requested = input.model?.trim();
    if (!requested || requested === CODE_PUPPY_DEFAULT_MODEL || requested === current) {
      return current;
    }
    if (!codePuppyModelOptions(configOptions).some((option) => option.value === requested)) {
      return yield* Effect.fail(
        input.mapError(
          EffectAcpErrors.AcpRequestError.invalidParams(
            `Code Puppy model '${requested}' is not configured. Select an available model.`,
          ),
        ),
      );
    }
    yield* input.runtime.setModel(requested).pipe(Effect.mapError(input.mapError));
    return requested;
  },
);
