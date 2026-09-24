import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CommandCodeSettings,
  type ProviderRuntimeEvent,
  type RuntimeMode,
  ThreadId,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";

import { ServerConfig } from "../../config.ts";
import { makeCommandCodeAdapter } from "./CommandCodeAdapter.ts";
import { COMMAND_CODE_APPROVAL_NOTICE } from "./commandCodeEvents.ts";

const encoder = new TextEncoder();
const settings = Schema.decodeSync(CommandCodeSettings)({ enabled: true });

const turnStdout = (sessionId: string) =>
  [
    { type: "event", event: { type: "run_start", sessionId } },
    { type: "event", event: { type: "message_start" } },
    { type: "event", event: { type: "text_delta", delta: "Done." } },
    { type: "event", event: { type: "message_end", content: [{ type: "text", text: "Done." }] } },
    {
      type: "result",
      subtype: "success",
      sessionId,
      stopReason: "end_turn",
      usage: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 },
      durationMs: 5,
      finalText: "Done.",
    },
  ]
    .map((line) => JSON.stringify(line))
    .join("\n") + "\n";

/** Records every spawn and answers with one successful print-mode run. */
function recordingSpawner(sessionId: string) {
  const spawns: Array<ReadonlyArray<string>> = [];
  const spawner = ChildProcessSpawner.make((command) => {
    const { args } = command as unknown as { args: ReadonlyArray<string> };
    spawns.push(args);
    return Effect.succeed(
      ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(1),
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        unref: Effect.succeed(Effect.void),
        stdin: Sink.drain,
        stdout: Stream.make(encoder.encode(turnStdout(sessionId))),
        stderr: Stream.empty,
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      }),
    );
  });
  return { spawner, spawns };
}

const testLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-command-code-adapter-",
}).pipe(Layer.provideMerge(NodeServices.layer));

const runTwoTurns = (runtimeMode: RuntimeMode) =>
  Effect.gen(function* () {
    const { spawner, spawns } = recordingSpawner("abc-session");
    const adapter = yield* makeCommandCodeAdapter(settings).pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    );
    const threadId = ThreadId.make(`thread-${runtimeMode}`);
    const events: ProviderRuntimeEvent[] = [];
    const secondTurnDone = yield* Deferred.make<void>();
    let completedTurns = 0;
    const collector = yield* Stream.runForEach(adapter.streamEvents, (event) =>
      Effect.gen(function* () {
        events.push(event);
        if (event.type === "turn.completed") {
          completedTurns += 1;
          if (completedTurns === 2) yield* Deferred.succeed(secondTurnDone, undefined);
        }
      }),
    ).pipe(Effect.forkChild({ startImmediately: true }));

    yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode });
    const first = yield* adapter.sendTurn({ threadId, input: "first" });
    const second = yield* adapter.sendTurn({ threadId, input: "second" });
    yield* Deferred.await(secondTurnDone);
    yield* Fiber.interrupt(collector);
    return { spawns, events, first, second };
  }).pipe(Effect.scoped);

it.layer(testLayer)("CommandCodeAdapter", (it) => {
  it.effect("never passes --yolo outside full-access and warns on every turn", () =>
    Effect.gen(function* () {
      for (const runtimeMode of ["approval-required", "auto-accept-edits", "auto"] as const) {
        const { spawns, events } = yield* runTwoTurns(runtimeMode);
        assert.strictEqual(spawns.length, 2);
        for (const args of spawns) {
          assert.notInclude(args, "--yolo", runtimeMode);
        }
        const notices = events.filter(
          (event) =>
            event.type === "runtime.warning" &&
            event.payload.message === COMMAND_CODE_APPROVAL_NOTICE,
        );
        assert.strictEqual(notices.length, 2, `${runtimeMode} warns once per turn`);
      }
    }),
  );

  it.effect("passes --yolo in full-access without the notice", () =>
    Effect.gen(function* () {
      const { spawns, events } = yield* runTwoTurns("full-access");
      for (const args of spawns) {
        assert.include(args, "--yolo");
      }
      assert.isFalse(events.some((event) => event.type === "runtime.warning"));
    }),
  );

  it.effect("resumes the native session captured on the first turn", () =>
    Effect.gen(function* () {
      const { spawns, first, second, events } = yield* runTwoTurns("approval-required");
      assert.notInclude([...(spawns[0] ?? [])], "--session");
      assert.includeMembers([...(spawns[1] ?? [])], ["--session", "abc-session"]);
      assert.deepStrictEqual(first.resumeCursor, { schemaVersion: 1, sessionId: "abc-session" });
      assert.deepStrictEqual(second.resumeCursor, first.resumeCursor);
      const completed = events.filter((event) => event.type === "turn.completed");
      assert.deepStrictEqual(
        completed.map((event) => event.type === "turn.completed" && event.payload.state),
        ["completed", "completed"],
      );
    }),
  );
});
