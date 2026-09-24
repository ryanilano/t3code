/**
 * Command Code provider snapshot: install, login, and version come from one
 * `command-code status --json` call. That command is local and free;
 * `--list-models` can hit the network, so the model list is hand-maintained.
 *
 * @module provider/Layers/CommandCodeProvider
 */
import {
  type CommandCodeSettings,
  type ModelCapabilities,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import {
  AUTH_PROBE_TIMEOUT_MS,
  buildSelectOptionDescriptor,
  buildServerProvider,
  isCommandMissingCause,
  providerModelsFromSettings,
  spawnAndCollect,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";

const COMMAND_CODE_PRESENTATION = {
  displayName: "Command Code",
  supportsConversationRollback: false,
  badgeLabel: "Early Access",
  showInteractionModeToggle: false,
} as const;

const EMPTY_CAPABILITIES: ModelCapabilities = createModelCapabilities({ optionDescriptors: [] });

const EFFORT_LABELS: Record<string, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra High",
  max: "Max",
};

function effortCapabilities(efforts: ReadonlyArray<string>): ModelCapabilities {
  return createModelCapabilities({
    optionDescriptors: [
      buildSelectOptionDescriptor({
        id: "effort",
        label: "Reasoning",
        options: efforts.map((value) => ({ value, label: EFFORT_LABELS[value] ?? value })),
      }),
    ],
  });
}

/**
 * A short, hand-kept subset of Command Code's catalog. Effort levels follow
 * the per-model table in the v1.65 bundle. Users add anything else as a
 * custom model.
 */
const COMMAND_CODE_BUILT_IN_MODELS: ReadonlyArray<ServerProviderModel> = [
  ["deepseek/deepseek-v4-flash", "DeepSeek V4 Flash", ["high", "max"]],
  ["deepseek/deepseek-v4-pro", "DeepSeek V4 Pro", ["high", "max"]],
  ["moonshotai/Kimi-K3", "Kimi K3", ["low", "high", "max"]],
  ["zai-org/GLM-5.3", "GLM 5.3", ["low", "high", "max"]],
  ["claude-sonnet-5", "Claude Sonnet 5", ["low", "medium", "high", "xhigh", "max"]],
  ["gpt-5.5", "GPT-5.5", ["low", "medium", "high", "xhigh"]],
].map(([slug, name, efforts]) => ({
  slug: slug as string,
  name: name as string,
  isCustom: false,
  capabilities: effortCapabilities(efforts as ReadonlyArray<string>),
}));

const CommandCodeStatus = Schema.Struct({
  authenticated: Schema.Boolean,
  version: Schema.optional(Schema.String),
  user: Schema.optional(Schema.String),
  model: Schema.optional(Schema.String),
  context_window: Schema.optional(Schema.Finite),
});
export type CommandCodeStatus = typeof CommandCodeStatus.Type;

const decodeCommandCodeStatus = Schema.decodeUnknownExit(Schema.fromJsonString(CommandCodeStatus));

/** Parses `command-code status --json`. Returns undefined for anything else. */
export function parseCommandCodeStatus(stdout: string): CommandCodeStatus | undefined {
  const line = stdout
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .find((entry) => entry.startsWith("{"));
  if (!line) return undefined;
  const decoded = decodeCommandCodeStatus(line);
  return Exit.isSuccess(decoded) ? decoded.value : undefined;
}

/**
 * Built-ins plus custom models. The model the CLI reports as its default is
 * marked default, and added when the hand list does not carry it.
 */
export function commandCodeModels(
  settings: Pick<CommandCodeSettings, "customModels" | "defaultModel">,
  statusModel?: string,
): ReadonlyArray<ServerProviderModel> {
  const defaultSlug = settings.defaultModel.trim() || statusModel?.trim() || undefined;
  const builtIns =
    defaultSlug && !COMMAND_CODE_BUILT_IN_MODELS.some((model) => model.slug === defaultSlug)
      ? [
          {
            slug: defaultSlug,
            name: defaultSlug,
            isCustom: false,
            capabilities: EMPTY_CAPABILITIES,
          },
          ...COMMAND_CODE_BUILT_IN_MODELS,
        ]
      : COMMAND_CODE_BUILT_IN_MODELS;
  return providerModelsFromSettings(
    builtIns.map((model) => (model.slug === defaultSlug ? { ...model, isDefault: true } : model)),
    settings.customModels,
    EMPTY_CAPABILITIES,
  );
}

const disabledProbe = {
  installed: false,
  version: null,
  status: "warning",
  auth: { status: "unknown" },
  message: "Command Code is disabled in T3 Code settings.",
} as const;

export function buildInitialCommandCodeProviderSnapshot(
  settings: CommandCodeSettings,
): Effect.Effect<ServerProviderDraft> {
  return Effect.map(DateTime.now, (now) =>
    buildServerProvider({
      presentation: COMMAND_CODE_PRESENTATION,
      enabled: settings.enabled,
      checkedAt: DateTime.formatIso(now),
      models: commandCodeModels(settings),
      probe: settings.enabled
        ? {
            installed: true,
            version: null,
            status: "warning",
            auth: { status: "unknown" },
            message: "Checking Command Code CLI availability...",
          }
        : disabledProbe,
    }),
  );
}

export const checkCommandCodeProviderStatus = Effect.fn("checkCommandCodeProviderStatus")(
  function* (
    settings: CommandCodeSettings,
    environment: NodeJS.ProcessEnv = process.env,
    onStatus?: (status: CommandCodeStatus) => Effect.Effect<void>,
  ): Effect.fn.Return<ServerProviderDraft, never, ChildProcessSpawner.ChildProcessSpawner> {
    const checkedAt = DateTime.formatIso(yield* DateTime.now);
    const fallbackModels = commandCodeModels(settings);
    const build = (
      probe: Parameters<typeof buildServerProvider>[0]["probe"],
      models = fallbackModels,
    ) =>
      buildServerProvider({
        presentation: COMMAND_CODE_PRESENTATION,
        enabled: settings.enabled,
        checkedAt,
        models,
        probe,
      });

    if (!settings.enabled) return build(disabledProbe);

    const command = settings.binaryPath || "command-code";
    const statusResult = yield* Effect.gen(function* () {
      const spawnCommand = yield* resolveSpawnCommand(command, ["status", "--json"], {
        env: environment,
      });
      return yield* spawnAndCollect(
        command,
        ChildProcess.make(spawnCommand.command, spawnCommand.args, {
          env: environment,
          shell: spawnCommand.shell,
          stdin: "ignore",
        }),
      );
    }).pipe(Effect.timeoutOption(AUTH_PROBE_TIMEOUT_MS), Effect.result);

    if (Result.isFailure(statusResult)) {
      const missing = isCommandMissingCause(statusResult.failure);
      return build({
        installed: !missing,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: missing
          ? "Command Code CLI (`command-code`) is not installed or not on PATH."
          : "Failed to run `command-code status --json`.",
      });
    }
    if (Option.isNone(statusResult.success)) {
      return build({
        installed: true,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: "Command Code CLI timed out while running `command-code status --json`.",
      });
    }

    const output = statusResult.success.value;
    const status = parseCommandCodeStatus(output.stdout);
    if (!status) {
      yield* Effect.logWarning("Command Code status probe returned unexpected output.", {
        exitCode: output.code,
        stdoutLength: output.stdout.length,
        stderrLength: output.stderr.length,
      });
      return build({
        installed: true,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: "Command Code CLI is installed but `status --json` returned unexpected output.",
      });
    }
    if (onStatus) yield* onStatus(status);

    const version = status.version?.trim() || null;
    const models = commandCodeModels(settings, status.model);
    if (!status.authenticated) {
      return build(
        {
          installed: true,
          version,
          status: "error",
          auth: { status: "unauthenticated" },
          message: "Command Code CLI is installed but not logged in. Run `command-code login`.",
        },
        models,
      );
    }
    const user = status.user?.trim();
    return build(
      {
        installed: true,
        version,
        status: "ready",
        auth: {
          status: "authenticated",
          type: "cached_token",
          ...(user ? { label: user } : {}),
        },
      },
      models,
    );
  },
);
