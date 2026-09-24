import {
  type CommandCodeSettings,
  type ModelSelection,
  TextGenerationError,
} from "@t3tools/contracts";
import { sanitizeBranchFragment, sanitizeFeatureBranchName } from "@t3tools/shared/git";
import { extractJsonObject } from "@t3tools/shared/schemaJson";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { spawnAndCollect } from "../provider/providerSnapshot.ts";
import type * as TextGeneration from "./TextGeneration.ts";
import {
  buildBranchNamePrompt,
  buildCommitMessagePrompt,
  buildPrContentPrompt,
  buildThreadTitlePrompt,
} from "./TextGenerationPrompts.ts";
import {
  sanitizeCommitSubject,
  sanitizePrTitle,
  sanitizeThreadTitle,
} from "./TextGenerationUtils.ts";

const COMMAND_CODE_TEXT_TIMEOUT_MS = 180_000;

type Operation =
  | "generateCommitMessage"
  | "generatePrContent"
  | "generateBranchName"
  | "generateThreadTitle";

const ResultLine = Schema.Struct({
  type: Schema.Literal("result"),
  subtype: Schema.String,
  finalText: Schema.String,
  error: Schema.optional(Schema.String),
});
const decodeResultLine = Schema.decodeUnknownOption(Schema.fromJsonString(ResultLine));

/** The final `{"type":"result"}` line of `command-code -p --output-format json`. */
export function readCommandCodeFinalResult(stdout: string): typeof ResultLine.Type | undefined {
  const lines = stdout.split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]?.trim();
    if (!line?.startsWith('{"type":"result"')) continue;
    return Option.getOrUndefined(decodeResultLine(line));
  }
  return undefined;
}

/**
 * Text generation through one print-mode run. It never passes `--yolo`, so
 * the print gate keeps it read-only, and `--no-session` keeps it out of the
 * user's session history.
 */
export const makeCommandCodeTextGeneration = Effect.fn("makeCommandCodeTextGeneration")(function* (
  settings: CommandCodeSettings,
  environment: NodeJS.ProcessEnv = process.env,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const command = settings.binaryPath || "command-code";

  const runJson = <S extends Schema.Top>(input: {
    readonly operation: Operation;
    readonly cwd: string;
    readonly prompt: string;
    readonly outputSchema: S;
    readonly modelSelection: ModelSelection;
  }): Effect.Effect<S["Type"], TextGenerationError, S["DecodingServices"]> =>
    Effect.gen(function* () {
      const model = input.modelSelection.model.trim() || settings.defaultModel.trim();
      const args = [
        `--print=${input.prompt}`,
        "--output-format",
        "json",
        "--skip-onboarding",
        "--no-session",
        ...(model ? ["--model", model] : []),
      ];
      const spawnCommand = yield* resolveSpawnCommand(command, args, { env: environment });
      const output = yield* spawnAndCollect(
        command,
        ChildProcess.make(spawnCommand.command, spawnCommand.args, {
          cwd: input.cwd,
          env: environment,
          shell: spawnCommand.shell,
          stdin: "ignore",
        }),
      ).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.timeoutOption(COMMAND_CODE_TEXT_TIMEOUT_MS),
        Effect.mapError(
          (cause) =>
            new TextGenerationError({
              operation: input.operation,
              detail: "Failed to run the Command Code CLI.",
              cause,
            }),
        ),
      );
      if (Option.isNone(output)) {
        return yield* new TextGenerationError({
          operation: input.operation,
          detail: "Command Code request timed out.",
        });
      }
      const result = readCommandCodeFinalResult(output.value.stdout);
      const text = result?.finalText.trim();
      if (!result || result.subtype !== "success" || !text) {
        return yield* new TextGenerationError({
          operation: input.operation,
          detail:
            result?.error?.trim() ||
            `Command Code returned no usable output (exit code ${output.value.code}).`,
        });
      }
      return yield* Schema.decodeEffect(Schema.fromJsonString(input.outputSchema))(
        extractJsonObject(text),
      ).pipe(
        Effect.mapError(
          (cause) =>
            new TextGenerationError({
              operation: input.operation,
              detail: "Command Code returned invalid structured output.",
              cause,
            }),
        ),
      );
    });

  const generateCommitMessage: TextGeneration.TextGeneration["Service"]["generateCommitMessage"] =
    Effect.fn("CommandCodeTextGeneration.generateCommitMessage")(function* (input) {
      const { prompt, outputSchema } = buildCommitMessagePrompt({
        branch: input.branch,
        stagedSummary: input.stagedSummary,
        stagedPatch: input.stagedPatch,
        includeBranch: input.includeBranch === true,
        policy: input.policy,
      });
      const generated = yield* runJson({
        operation: "generateCommitMessage",
        cwd: input.cwd,
        prompt,
        outputSchema,
        modelSelection: input.modelSelection,
      });
      return {
        subject: sanitizeCommitSubject(generated.subject),
        body: generated.body.trim(),
        ...("branch" in generated && typeof generated.branch === "string"
          ? { branch: sanitizeFeatureBranchName(generated.branch) }
          : {}),
      };
    });

  const generatePrContent: TextGeneration.TextGeneration["Service"]["generatePrContent"] =
    Effect.fn("CommandCodeTextGeneration.generatePrContent")(function* (input) {
      const { prompt, outputSchema } = buildPrContentPrompt({
        baseBranch: input.baseBranch,
        headBranch: input.headBranch,
        commitSummary: input.commitSummary,
        diffSummary: input.diffSummary,
        diffPatch: input.diffPatch,
        policy: input.policy,
        changeRequestTemplate: input.changeRequestTemplate,
      });
      const generated = yield* runJson({
        operation: "generatePrContent",
        cwd: input.cwd,
        prompt,
        outputSchema,
        modelSelection: input.modelSelection,
      });
      return { title: sanitizePrTitle(generated.title), body: generated.body.trim() };
    });

  const generateBranchName: TextGeneration.TextGeneration["Service"]["generateBranchName"] =
    Effect.fn("CommandCodeTextGeneration.generateBranchName")(function* (input) {
      const { prompt, outputSchema } = buildBranchNamePrompt({
        message: input.message,
        attachments: input.attachments,
      });
      const generated = yield* runJson({
        operation: "generateBranchName",
        cwd: input.cwd,
        prompt,
        outputSchema,
        modelSelection: input.modelSelection,
      });
      return { branch: sanitizeBranchFragment(generated.branch) };
    });

  const generateThreadTitle: TextGeneration.TextGeneration["Service"]["generateThreadTitle"] =
    Effect.fn("CommandCodeTextGeneration.generateThreadTitle")(function* (input) {
      const { prompt, outputSchema } = buildThreadTitlePrompt({
        message: input.message,
        previousTitle: input.previousTitle,
        linkedContext: input.linkedContext,
        attachments: input.attachments,
      });
      const generated = yield* runJson({
        operation: "generateThreadTitle",
        cwd: input.cwd,
        prompt,
        outputSchema,
        modelSelection: input.modelSelection,
      });
      return {
        title: sanitizeThreadTitle(generated.title),
        ...(generated.needsRefinement ? { needsRefinement: true } : {}),
      } satisfies TextGeneration.ThreadTitleGenerationResult;
    });

  return {
    generateCommitMessage,
    generatePrContent,
    generateBranchName,
    generateThreadTitle,
  } satisfies TextGeneration.TextGeneration["Service"];
});
