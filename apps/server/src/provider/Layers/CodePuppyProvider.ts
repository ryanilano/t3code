import {
  CODE_PUPPY_DEFAULT_MODEL,
  type CodePuppySettings,
  type CustomModelSetting,
  type ModelCapabilities,
  type ServerProvider,
  type ServerProviderModel,
} from "@t3tools/contracts";
import type * as EffectAcpSchema from "effect-acp/schema";
import { causeErrorTag } from "@t3tools/shared/observability";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import { HttpClient } from "effect/unstable/http";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { createModelCapabilities } from "@t3tools/shared/model";
import { resolveSpawnCommand } from "@t3tools/shared/shell";

import {
  buildServerProvider,
  isCommandMissingCause,
  parseGenericCliVersion,
  providerModelsFromSettings,
  spawnAndCollect,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";
import {
  enrichProviderSnapshotWithVersionAdvisory,
  type ProviderMaintenanceCapabilities,
} from "../providerMaintenance.ts";
import {
  codePuppyModelOptions,
  currentCodePuppyModel,
  makeCodePuppyAcpRuntime,
} from "../acp/CodePuppyAcpSupport.ts";

const CODE_PUPPY_PRESENTATION = {
  displayName: "Code Puppy",
  supportsConversationRollback: false,
  badgeLabel: "Early Access",
  showInteractionModeToggle: false,
} as const;
const EMPTY_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [],
});

// `code-puppy --version` boots a Python interpreter; about 1.5 s warm, longer cold.
const VERSION_PROBE_TIMEOUT_MS = 10_000;
// initialize, authenticate and session/new are local round trips. Code Puppy boots Python first.
const CODE_PUPPY_ACP_PROBE_TIMEOUT_MS = 20_000;

/** Fallback when the model list cannot be read: keep whatever model the session starts on. */
const CODE_PUPPY_BUILT_IN_MODELS: ReadonlyArray<ServerProviderModel> = [
  {
    slug: CODE_PUPPY_DEFAULT_MODEL,
    name: "Code Puppy default",
    isCustom: false,
    capabilities: EMPTY_CAPABILITIES,
  },
];

function codePuppyModelsFromSettings(
  customModels: ReadonlyArray<CustomModelSetting> | undefined,
  builtInModels: ReadonlyArray<ServerProviderModel> = CODE_PUPPY_BUILT_IN_MODELS,
): ReadonlyArray<ServerProviderModel> {
  return providerModelsFromSettings(builtInModels, customModels ?? [], EMPTY_CAPABILITIES);
}

/**
 * Models from the `model` select config option on `session/new`. The session's current
 * model is the default and answers to the `code-puppy` slug.
 */
export function buildCodePuppyModelsFromConfigOptions(
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption> | null | undefined,
): ReadonlyArray<ServerProviderModel> {
  const current = currentCodePuppyModel(configOptions);
  const seen = new Set<string>();
  return codePuppyModelOptions(configOptions).flatMap((entry): ServerProviderModel[] => {
    const slug = entry.value.trim();
    if (!slug || seen.has(slug)) return [];
    seen.add(slug);
    return [
      {
        slug,
        name: entry.name.trim() || slug,
        isCustom: false,
        ...(slug === current ? { isDefault: true, aliases: [CODE_PUPPY_DEFAULT_MODEL] } : {}),
        capabilities: EMPTY_CAPABILITIES,
      },
    ];
  });
}

export function buildInitialCodePuppyProviderSnapshot(
  settings: CodePuppySettings,
): Effect.Effect<ServerProviderDraft> {
  return Effect.gen(function* () {
    const checkedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
    return buildServerProvider({
      presentation: CODE_PUPPY_PRESENTATION,
      enabled: settings.enabled,
      checkedAt,
      models: codePuppyModelsFromSettings(settings.customModels),
      probe: {
        installed: settings.enabled,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: settings.enabled
          ? "Checking Code Puppy CLI availability..."
          : "Code Puppy is disabled in T3 Code settings.",
      },
    });
  });
}

const runCodePuppyCliCommand = (
  settings: CodePuppySettings,
  args: ReadonlyArray<string>,
  environment: NodeJS.ProcessEnv,
) =>
  Effect.gen(function* () {
    const command = settings.binaryPath || "code-puppy";
    const spawnCommand = yield* resolveSpawnCommand(command, args, { env: environment });
    return yield* spawnAndCollect(
      command,
      ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        env: environment,
        shell: spawnCommand.shell,
      }),
    );
  });

/**
 * Code Puppy only advertises models on `session/new`, so the probe opens one session in
 * approval mode and never prompts it. Code Puppy has no login, so `authenticate` is a no-op.
 */
const discoverCodePuppyModelsViaAcp = (
  settings: CodePuppySettings,
  environment: NodeJS.ProcessEnv,
  cwd: string,
) =>
  Effect.gen(function* () {
    const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const acp = yield* makeCodePuppyAcpRuntime({
      codePuppySettings: settings,
      environment,
      childProcessSpawner,
      cwd,
      runtimeMode: "approval-required",
      clientInfo: { name: "t3-code-provider-probe", version: "0.0.0" },
    });
    const started = yield* acp.start();
    return buildCodePuppyModelsFromConfigOptions(started.sessionSetupResult.configOptions);
  }).pipe(Effect.scoped);

export const checkCodePuppyProviderStatus = Effect.fn("checkCodePuppyProviderStatus")(function* (
  settings: CodePuppySettings,
  environment: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): Effect.fn.Return<
  ServerProviderDraft,
  never,
  ChildProcessSpawner.ChildProcessSpawner | Crypto.Crypto
> {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const fallbackModels = codePuppyModelsFromSettings(settings.customModels);
  const unhealthy = (probe: {
    readonly installed: boolean;
    readonly version: string | null;
    readonly message: string;
  }) =>
    buildServerProvider({
      presentation: CODE_PUPPY_PRESENTATION,
      enabled: settings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: { ...probe, status: "error", auth: { status: "unknown" } },
    });

  if (!settings.enabled) {
    return buildServerProvider({
      presentation: CODE_PUPPY_PRESENTATION,
      enabled: false,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Code Puppy is disabled in T3 Code settings.",
      },
    });
  }

  const versionResult = yield* runCodePuppyCliCommand(settings, ["--version"], environment).pipe(
    Effect.timeoutOption(VERSION_PROBE_TIMEOUT_MS),
    Effect.result,
  );

  if (Result.isFailure(versionResult)) {
    const error = versionResult.failure;
    yield* Effect.logWarning("Code Puppy CLI health check failed.", { errorTag: error._tag });
    const missing = isCommandMissingCause(error);
    return unhealthy({
      installed: !missing,
      version: null,
      message: missing
        ? "Code Puppy CLI (`code-puppy`) is not installed or not on PATH."
        : "Failed to execute Code Puppy CLI health check.",
    });
  }

  if (Option.isNone(versionResult.success)) {
    return unhealthy({
      installed: true,
      version: null,
      message: "Code Puppy CLI is installed but timed out while running `code-puppy --version`.",
    });
  }

  const versionOutput = versionResult.success.value;
  const version = parseGenericCliVersion(`${versionOutput.stdout}\n${versionOutput.stderr}`);
  if (versionOutput.code !== 0) {
    yield* Effect.logWarning("Code Puppy CLI version probe exited with a non-zero status.", {
      exitCode: versionOutput.code,
    });
    return unhealthy({
      installed: true,
      version,
      message: "Code Puppy CLI is installed but failed to run.",
    });
  }

  const acpExit = yield* discoverCodePuppyModelsViaAcp(settings, environment, cwd).pipe(
    Effect.timeoutOption(CODE_PUPPY_ACP_PROBE_TIMEOUT_MS),
    Effect.exit,
  );
  const acpModels = Exit.isSuccess(acpExit) ? Option.getOrElse(acpExit.value, () => []) : [];
  if (Exit.isFailure(acpExit) || Option.isNone(acpExit.value)) {
    yield* Effect.logWarning("Code Puppy ACP model probe failed or timed out.", {
      errorTag: Exit.isFailure(acpExit) ? causeErrorTag(acpExit.cause) : "Timeout",
    });
  }
  const discovered = acpModels.length > 0;

  return buildServerProvider({
    presentation: CODE_PUPPY_PRESENTATION,
    enabled: settings.enabled,
    checkedAt,
    models: discovered
      ? codePuppyModelsFromSettings(settings.customModels, acpModels)
      : fallbackModels,
    probe: {
      installed: true,
      version,
      // A failed model probe degrades the picker; chats can still start on the default model.
      status: discovered ? "ready" : "warning",
      // Code Puppy has no login. A session that lists models is ready to use.
      auth: discovered
        ? { status: "authenticated", type: "code-puppy", label: "Code Puppy config" }
        : { status: "unknown" },
      ...(discovered
        ? {}
        : {
            message:
              "Code Puppy CLI is installed but did not list its models over ACP. Model options may be incomplete.",
          }),
    },
  });
});

export const enrichCodePuppySnapshot = (input: {
  readonly snapshot: ServerProvider;
  readonly maintenanceCapabilities: ProviderMaintenanceCapabilities;
  readonly enableProviderUpdateChecks?: boolean;
  readonly publishSnapshot: (snapshot: ServerProvider) => Effect.Effect<void>;
  readonly httpClient: HttpClient.HttpClient;
}): Effect.Effect<void> =>
  enrichProviderSnapshotWithVersionAdvisory(input.snapshot, input.maintenanceCapabilities, {
    enableProviderUpdateChecks: input.enableProviderUpdateChecks,
  }).pipe(
    Effect.provideService(HttpClient.HttpClient, input.httpClient),
    Effect.flatMap((enrichedSnapshot) => input.publishSnapshot(enrichedSnapshot)),
    Effect.catchCause((cause) =>
      Effect.logWarning("Code Puppy version advisory enrichment failed", {
        errorTag: causeErrorTag(cause),
      }),
    ),
    Effect.asVoid,
  );
