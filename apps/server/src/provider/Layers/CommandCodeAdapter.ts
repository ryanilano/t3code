/**
 * CommandCodeAdapter - drives the Command Code CLI in print mode, one child
 * process per turn.
 *
 * `command-code -p` has no control channel: stdin is read once as prompt text
 * and nothing can be answered mid-run. So a turn is "spawn, stream NDJSON,
 * wait for exit", continuity comes from `--session <id>`, and interrupt is
 * SIGINT. Line translation lives in `commandCodeEvents.ts`.
 *
 * `sendTurn` returns when the process exits so the native session id from the
 * first turn reaches `ProviderService` in the returned resume cursor.
 *
 * @module provider/Layers/CommandCodeAdapter
 */
import * as NodeCrypto from "node:crypto";

import {
  type CommandCodeSettings,
  EventId,
  type ProviderRuntimeEvent,
  type ProviderSendTurnInput,
  type ProviderSession,
  ProviderInstanceId,
  type ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import {
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
} from "../Errors.ts";
import { collectStreamAsString, isCommandMissingCause } from "../providerSnapshot.ts";
import type {
  ProviderAdapterShape,
  ProviderThreadTurnSnapshot,
} from "../Services/ProviderAdapter.ts";
import type { ProviderAdapterError } from "../Errors.ts";
import {
  buildCommandCodeTurnArgs,
  COMMAND_CODE_APPROVAL_NOTICE,
  COMMAND_CODE_PROVIDER,
  commandCodeAllowsYolo,
  finishCommandCodeTurn,
  makeCommandCodeTurnState,
  translateCommandCodeLine,
  type CommandCodeTurnOutcome,
} from "./commandCodeEvents.ts";
import type { EventNdjsonLogger } from "./EventNdjsonLogger.ts";

const PROVIDER = COMMAND_CODE_PROVIDER;
const COMMAND_CODE_RESUME_VERSION = 1 as const;
/** Command Code flushes its session and prints the result line on SIGINT; give it this long. */
const INTERRUPT_FORCE_KILL_AFTER = "5 seconds";
const STDERR_MAX_BYTES = 16_384;

export interface CommandCodeAdapterOptions {
  readonly environment?: NodeJS.ProcessEnv;
  readonly nativeEventLogger?: EventNdjsonLogger;
  readonly instanceId?: ProviderInstanceId;
  /** Context window of the default model, from the latest status probe. */
  readonly contextWindow?: Effect.Effect<number | undefined>;
}

interface CommandCodeResumeCursor {
  readonly schemaVersion: typeof COMMAND_CODE_RESUME_VERSION;
  readonly sessionId: string;
}

function parseCommandCodeResume(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== COMMAND_CODE_RESUME_VERSION) return undefined;
  return typeof record.sessionId === "string" && record.sessionId.trim()
    ? record.sessionId.trim()
    : undefined;
}

interface ActiveTurn {
  readonly turnId: TurnId;
  interruptRequested: boolean;
  child: ChildProcessSpawner.ChildProcessHandle | undefined;
}

interface CommandCodeSessionContext {
  readonly threadId: ThreadId;
  session: ProviderSession;
  nativeSessionId: string | undefined;
  activeTurn: ActiveTurn | undefined;
  readonly turns: Array<ProviderThreadTurnSnapshot>;
  stopped: boolean;
}

const nowIso = () => DateTime.formatIso(DateTime.nowUnsafe());

const stamp = () => ({
  eventId: EventId.make(NodeCrypto.randomUUID()),
  createdAt: nowIso(),
});

export function makeCommandCodeAdapter(
  settings: CommandCodeSettings,
  options?: CommandCodeAdapterOptions,
) {
  return Effect.gen(function* () {
    const boundInstanceId = options?.instanceId ?? ProviderInstanceId.make("commandCode");
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const path = yield* Path.Path;
    const serverConfig = yield* ServerConfig;
    const environment = options?.environment ?? process.env;
    const binaryPath = settings.binaryPath || "command-code";

    const sessions = new Map<ThreadId, CommandCodeSessionContext>();
    const runtimeEventPubSub = yield* PubSub.unbounded<ProviderRuntimeEvent>();
    const publish = (events: ReadonlyArray<ProviderRuntimeEvent>) =>
      events.length === 0
        ? Effect.void
        : PubSub.publishAll(runtimeEventPubSub, events).pipe(Effect.asVoid);

    const requireSession = (
      threadId: ThreadId,
    ): Effect.Effect<CommandCodeSessionContext, ProviderAdapterSessionNotFoundError> => {
      const ctx = sessions.get(threadId);
      return ctx && !ctx.stopped
        ? Effect.succeed(ctx)
        : Effect.fail(new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId }));
    };

    const killChild = (turn: ActiveTurn, signal: "SIGINT" | "SIGTERM") =>
      turn.child
        ? turn.child
            .kill({ killSignal: signal, forceKillAfter: INTERRUPT_FORCE_KILL_AFTER })
            .pipe(Effect.ignore)
        : Effect.void;

    const stopSessionInternal = (ctx: CommandCodeSessionContext) =>
      Effect.gen(function* () {
        if (ctx.stopped) return;
        ctx.stopped = true;
        sessions.delete(ctx.threadId);
        if (ctx.activeTurn) {
          ctx.activeTurn.interruptRequested = true;
          yield* killChild(ctx.activeTurn, "SIGTERM");
        }
        yield* publish([
          {
            ...stamp(),
            type: "session.exited",
            provider: PROVIDER,
            threadId: ctx.threadId,
            payload: { exitKind: "graceful" },
          },
        ]);
      });

    const startSession: ProviderAdapterShape<ProviderAdapterError>["startSession"] = (input) =>
      Effect.gen(function* () {
        if (input.provider !== undefined && input.provider !== PROVIDER) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "startSession",
            issue: `Expected provider '${PROVIDER}' but received '${input.provider}'.`,
          });
        }
        const rawCwd = input.cwd?.trim();
        if (!rawCwd) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "startSession",
            issue: "cwd is required and must be non-empty.",
          });
        }
        const existing = sessions.get(input.threadId);
        if (existing) yield* stopSessionInternal(existing);

        const nativeSessionId = parseCommandCodeResume(input.resumeCursor);
        const model =
          (input.modelSelection?.instanceId === boundInstanceId
            ? input.modelSelection.model.trim()
            : undefined) || settings.defaultModel.trim();
        const now = nowIso();
        const session: ProviderSession = {
          provider: PROVIDER,
          providerInstanceId: boundInstanceId,
          status: "ready",
          runtimeMode: input.runtimeMode,
          cwd: path.resolve(rawCwd),
          ...(model ? { model } : {}),
          threadId: input.threadId,
          ...(nativeSessionId
            ? {
                resumeCursor: {
                  schemaVersion: COMMAND_CODE_RESUME_VERSION,
                  sessionId: nativeSessionId,
                } satisfies CommandCodeResumeCursor,
              }
            : {}),
          createdAt: now,
          updatedAt: now,
        };
        sessions.set(input.threadId, {
          threadId: input.threadId,
          session,
          nativeSessionId,
          activeTurn: undefined,
          turns: [],
          stopped: false,
        });

        yield* publish([
          {
            ...stamp(),
            type: "session.started",
            provider: PROVIDER,
            threadId: input.threadId,
            payload: nativeSessionId ? { resume: { sessionId: nativeSessionId } } : {},
          },
          {
            ...stamp(),
            type: "session.state.changed",
            provider: PROVIDER,
            threadId: input.threadId,
            payload: { state: "ready", reason: "Command Code session ready" },
          },
          {
            ...stamp(),
            type: "thread.started",
            provider: PROVIDER,
            threadId: input.threadId,
            payload: nativeSessionId ? { providerThreadId: nativeSessionId } : {},
          },
        ]);
        return session;
      });

    /** Prompt text plus image paths. Print mode takes text only; the agent can open the files. */
    const buildPrompt = (input: ProviderSendTurnInput) =>
      Effect.gen(function* () {
        const text = input.input?.trim() ?? "";
        const imagePaths: Array<string> = [];
        for (const attachment of input.attachments ?? []) {
          if (attachment.type !== "image") continue;
          const attachmentPath = resolveAttachmentPath({
            attachmentsDir: serverConfig.attachmentsDir,
            attachment,
          });
          if (!attachmentPath) {
            return yield* new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "turn/start",
              detail: `Invalid attachment id '${attachment.id}'.`,
            });
          }
          imagePaths.push(attachmentPath);
        }
        const prompt = [
          text,
          ...(imagePaths.length > 0
            ? [`Attached images:\n${imagePaths.map((imagePath) => `- ${imagePath}`).join("\n")}`]
            : []),
        ]
          .filter(Boolean)
          .join("\n\n");
        if (!prompt) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "sendTurn",
            issue: "Turn requires non-empty text or attachments.",
          });
        }
        return prompt;
      });

    /** Spawn one print-mode process, stream its stdout through the translator, and wait for exit. */
    const runProcess = (
      ctx: CommandCodeSessionContext,
      activeTurn: ActiveTurn,
      state: ReturnType<typeof makeCommandCodeTurnState>,
      args: ReadonlyArray<string>,
    ) =>
      Effect.gen(function* () {
        const spawnCommand = yield* resolveSpawnCommand(binaryPath, args, { env: environment });
        const child = yield* spawner.spawn(
          ChildProcess.make(spawnCommand.command, spawnCommand.args, {
            ...(ctx.session.cwd ? { cwd: ctx.session.cwd } : {}),
            env: environment,
            shell: spawnCommand.shell,
            // Print mode reads stdin as prompt text when -p has no value. The
            // prompt is in argv, so give it nothing to wait on.
            stdin: "ignore",
          }),
        );
        activeTurn.child = child;
        if (activeTurn.interruptRequested) yield* killChild(activeTurn, "SIGINT");

        const handleLine = (line: string) =>
          Effect.gen(function* () {
            if (options?.nativeEventLogger && line.trim()) {
              yield* options.nativeEventLogger.write(
                { source: "command-code.stdout", line },
                ctx.threadId,
              );
            }
            const events = translateCommandCodeLine(line, state);
            if (state.lastIgnored !== undefined) {
              yield* Effect.logDebug("ignoring Command Code output line", {
                threadId: ctx.threadId,
                kind: state.lastIgnored,
              });
            }
            yield* publish(events);
          });

        const [, stderr, exitCode] = yield* Effect.all(
          [
            child.stdout.pipe(
              Stream.decodeText(),
              Stream.splitLines,
              Stream.runForEach(handleLine),
            ),
            collectStreamAsString(child.stderr, { maxBytes: STDERR_MAX_BYTES }),
            child.exitCode.pipe(Effect.map(Number)),
          ],
          { concurrency: "unbounded" },
        );
        return { stderr, exitCode };
      }).pipe(Effect.scoped);

    const sendTurn: ProviderAdapterShape<ProviderAdapterError>["sendTurn"] = (input) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(input.threadId);
        if (ctx.activeTurn) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "turn/start",
            detail:
              "Command Code is still running the previous turn. Stop it before sending another message.",
          });
        }
        const prompt = yield* buildPrompt(input);
        const selection =
          input.modelSelection?.instanceId === boundInstanceId ? input.modelSelection : undefined;
        const model = selection?.model.trim() || settings.defaultModel.trim() || undefined;
        const effort =
          getModelSelectionStringOptionValue(selection, "effort") ??
          (settings.effort.trim() || undefined);
        const turnId = TurnId.make(NodeCrypto.randomUUID());
        const activeTurn: ActiveTurn = { turnId, interruptRequested: false, child: undefined };
        ctx.activeTurn = activeTurn;
        ctx.session = {
          ...ctx.session,
          status: "running",
          activeTurnId: turnId,
          updatedAt: nowIso(),
          ...(model ? { model } : {}),
        };
        const runtimeMode = ctx.session.runtimeMode;
        const state = makeCommandCodeTurnState({
          threadId: input.threadId,
          turnId,
          stamp,
          sessionId: ctx.nativeSessionId,
          contextWindow: options?.contextWindow ? yield* options.contextWindow : undefined,
        });

        yield* publish([
          {
            ...stamp(),
            type: "turn.started",
            provider: PROVIDER,
            threadId: input.threadId,
            turnId,
            payload: { ...(model ? { model } : {}), ...(effort ? { effort } : {}) },
          },
          // No approval channel exists in print mode, so outside Full Access the
          // gate silently blocks edits and shell. Say so up front on every turn.
          ...(commandCodeAllowsYolo(runtimeMode)
            ? []
            : [
                {
                  ...stamp(),
                  type: "runtime.warning" as const,
                  provider: PROVIDER,
                  threadId: input.threadId,
                  turnId,
                  payload: { message: COMMAND_CODE_APPROVAL_NOTICE },
                },
              ]),
        ]);

        const args = buildCommandCodeTurnArgs({
          prompt,
          runtimeMode,
          sessionId: ctx.nativeSessionId,
          model,
          effort,
        });

        const settle = (outcome: CommandCodeTurnOutcome) =>
          Effect.gen(function* () {
            if (ctx.activeTurn !== activeTurn) return;
            const events = finishCommandCodeTurn(state, outcome);
            if (state.sessionId) ctx.nativeSessionId = state.sessionId;
            ctx.turns.push({
              id: turnId,
              items: [{ role: "user", content: prompt }, ...state.transcript],
            });
            ctx.activeTurn = undefined;
            const failed = events.find(
              (event) => event.type === "turn.completed" && event.payload.state === "failed",
            );
            const { activeTurnId: _settled, lastError: _previousError, ...rest } = ctx.session;
            ctx.session = {
              ...rest,
              status: "ready",
              updatedAt: nowIso(),
              ...(state.model ? { model: state.model } : {}),
              ...(ctx.nativeSessionId
                ? {
                    resumeCursor: {
                      schemaVersion: COMMAND_CODE_RESUME_VERSION,
                      sessionId: ctx.nativeSessionId,
                    } satisfies CommandCodeResumeCursor,
                  }
                : {}),
              ...(failed?.type === "turn.completed" && failed.payload.errorMessage
                ? { lastError: failed.payload.errorMessage }
                : {}),
            };
            yield* publish(events);
          });

        const exit = yield* runProcess(ctx, activeTurn, state, args).pipe(
          Effect.exit,
          // A torn-down sendTurn fiber still owes the thread a terminal event.
          Effect.onInterrupt(() => settle({ exitCode: undefined, interruptRequested: true })),
        );
        if (Exit.isSuccess(exit)) {
          yield* settle({
            exitCode: exit.value.exitCode,
            stderr: exit.value.stderr,
            interruptRequested: activeTurn.interruptRequested,
          });
        } else {
          const failure = Cause.squash(exit.cause);
          yield* Effect.logWarning("Command Code turn process failed", {
            threadId: input.threadId,
            cause: Cause.pretty(exit.cause),
          });
          yield* settle({
            exitCode: undefined,
            interruptRequested: activeTurn.interruptRequested,
            failure: isCommandMissingCause(failure)
              ? `Command Code CLI (\`${binaryPath}\`) is not installed or not on PATH.`
              : "Failed to run the Command Code CLI.",
          });
        }

        return {
          threadId: input.threadId,
          turnId,
          ...(ctx.session.resumeCursor !== undefined
            ? { resumeCursor: ctx.session.resumeCursor }
            : {}),
        };
      });

    const interruptTurn: ProviderAdapterShape<ProviderAdapterError>["interruptTurn"] = (
      threadId,
      turnId,
    ) =>
      Effect.gen(function* () {
        const ctx = sessions.get(threadId);
        const activeTurn = ctx?.activeTurn;
        if (!activeTurn) return;
        if (turnId !== undefined && activeTurn.turnId !== turnId) return;
        activeTurn.interruptRequested = true;
        // Command Code aborts the run on SIGINT, emits `interrupted`, and exits 130.
        yield* killChild(activeTurn, "SIGINT");
      });

    const unsupportedRequest = (method: string) =>
      Effect.fail(
        new ProviderAdapterRequestError({
          provider: PROVIDER,
          method,
          detail: "Command Code print mode never asks for approval or user input.",
        }),
      );

    const readThread: ProviderAdapterShape<ProviderAdapterError>["readThread"] = (threadId) =>
      requireSession(threadId).pipe(Effect.map((ctx) => ({ threadId, turns: [...ctx.turns] })));

    const rollbackThread: ProviderAdapterShape<ProviderAdapterError>["rollbackThread"] = (
      threadId,
      numTurns,
    ) =>
      Effect.gen(function* () {
        yield* requireSession(threadId);
        if (!Number.isInteger(numTurns) || numTurns < 1) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "rollbackThread",
            issue: "numTurns must be an integer >= 1.",
          });
        }
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "thread/rollback",
          detail: "Command Code print mode cannot roll back a session.",
        });
      });

    const stopAll = () =>
      Effect.forEach(Array.from(sessions.values()), stopSessionInternal, { discard: true });

    yield* Effect.addFinalizer(() =>
      stopAll().pipe(Effect.andThen(PubSub.shutdown(runtimeEventPubSub))),
    );

    return {
      provider: PROVIDER,
      capabilities: { sessionModelSwitch: "in-session", supportsConversationRollback: false },
      startSession,
      sendTurn,
      interruptTurn,
      respondToRequest: () => unsupportedRequest("respondToRequest"),
      respondToUserInput: () => unsupportedRequest("respondToUserInput"),
      stopSession: (threadId) =>
        Effect.suspend(() => {
          const ctx = sessions.get(threadId);
          return ctx ? stopSessionInternal(ctx) : Effect.void;
        }),
      listSessions: () =>
        Effect.sync(() => Array.from(sessions.values(), (ctx) => ({ ...ctx.session }))),
      hasSession: (threadId) =>
        Effect.sync(() => {
          const ctx = sessions.get(threadId);
          return ctx !== undefined && !ctx.stopped;
        }),
      readThread,
      rollbackThread,
      stopAll,
      streamEvents: Stream.fromPubSub(runtimeEventPubSub),
    } satisfies ProviderAdapterShape<ProviderAdapterError>;
  });
}
