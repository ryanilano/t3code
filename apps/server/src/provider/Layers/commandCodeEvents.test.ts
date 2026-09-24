import * as NodeAssert from "node:assert/strict";
import * as NodeFs from "node:fs";
import * as NodePath from "node:path";

import { EventId, type ProviderRuntimeEvent, ThreadId, TurnId } from "@t3tools/contracts";
import { describe, it } from "vite-plus/test";

import {
  buildCommandCodeTurnArgs,
  COMMAND_CODE_PRINT_GATED_TOOLS,
  finishCommandCodeTurn,
  makeCommandCodeTurnState,
  translateCommandCodeLine,
  type CommandCodeTurnOutcome,
} from "./commandCodeEvents.ts";

// Hand-written fixtures in the shape `command-code -p --output-format json`
// prints: one {"type":"event"} line per AgentEvent, then one result line.
const event = (payload: Record<string, unknown>) =>
  JSON.stringify({ type: "event", event: payload });
const result = (payload: Record<string, unknown>) =>
  JSON.stringify({
    type: "result",
    usage: { inputTokens: 1200, outputTokens: 80, cacheReadTokens: 1000, cacheWriteTokens: 0 },
    durationMs: 900,
    finalText: "",
    ...payload,
  });

const HAPPY_TURN = [
  event({ type: "run_start", sessionId: "11111111-2222-3333-4444-555555555555" }),
  event({ type: "turn_start", turnNumber: 1 }),
  event({ type: "message_start" }),
  event({ type: "model_request_start", model: "deepseek/deepseek-v4-flash" }),
  event({ type: "thinking_start" }),
  event({ type: "thinking_delta", delta: "Look at the file." }),
  event({ type: "thinking_end", text: "Look at the file." }),
  event({ type: "text_delta", delta: "Reading " }),
  event({ type: "text_delta", delta: "it now." }),
  event({
    type: "model_request_end",
    model: "deepseek/deepseek-v4-flash",
    usage: { inputTokens: 600, outputTokens: 40, cacheReadTokens: 500, cacheWriteTokens: 0 },
    stopReason: "tool_use",
  }),
  event({
    type: "message_end",
    content: [
      { type: "text", text: "Reading it now." },
      { type: "tool_use", id: "call_1", name: "read_file", input: { file_path: "README.md" } },
    ],
  }),
  event({
    type: "tool_queued",
    toolCallId: "call_1",
    toolName: "read_file",
    input: { file_path: "README.md" },
  }),
  event({
    type: "tool_running",
    toolCallId: "call_1",
    toolName: "read_file",
    description: "Read README.md",
  }),
  event({
    type: "tool_completed",
    toolCallId: "call_1",
    toolName: "read_file",
    result: [{ type: "text", text: "# Title" }],
  }),
  event({ type: "turn_end", turnNumber: 1, hadToolCalls: true }),
  event({ type: "message_start" }),
  event({ type: "text_delta", delta: "The title is Title." }),
  event({ type: "message_end", content: [{ type: "text", text: "The title is Title." }] }),
  event({ type: "some_future_event", detail: 1 }),
  event({ type: "run_end", result: { stopReason: "end_turn" } }),
  result({
    subtype: "success",
    sessionId: "11111111-2222-3333-4444-555555555555",
    stopReason: "end_turn",
    finalText: "The title is Title.",
  }),
];

function makeState() {
  let counter = 0;
  return makeCommandCodeTurnState({
    threadId: ThreadId.make("thread-1"),
    turnId: TurnId.make("turn-1"),
    stamp: () => {
      counter += 1;
      return { eventId: EventId.make(`evt-${counter}`), createdAt: "2026-09-23T00:00:00.000Z" };
    },
  });
}

function run(lines: ReadonlyArray<string>, outcome: CommandCodeTurnOutcome) {
  const state = makeState();
  const events: ProviderRuntimeEvent[] = [];
  const ignored: string[] = [];
  for (const line of lines) {
    events.push(...translateCommandCodeLine(line, state));
    if (state.lastIgnored) ignored.push(state.lastIgnored);
  }
  events.push(...finishCommandCodeTurn(state, outcome));
  return { state, events, ignored };
}

function terminal(events: ReadonlyArray<ProviderRuntimeEvent>) {
  const completed = events.filter((entry) => entry.type === "turn.completed");
  NodeAssert.equal(completed.length, 1, "exactly one turn.completed");
  const [last] = completed;
  if (last?.type !== "turn.completed") throw new Error("unreachable");
  NodeAssert.equal(events.at(-1), last, "turn.completed is the final event");
  return last.payload;
}

describe("buildCommandCodeTurnArgs --yolo rule", () => {
  it("passes --yolo only in full-access", () => {
    for (const runtimeMode of ["approval-required", "auto-accept-edits", "auto"] as const) {
      const args = buildCommandCodeTurnArgs({ prompt: "hi", runtimeMode });
      NodeAssert.ok(!args.includes("--yolo"), `${runtimeMode} must not pass --yolo`);
      NodeAssert.ok(
        !args.includes("--dangerously-skip-permissions"),
        `${runtimeMode} must not bypass permissions`,
      );
    }
    NodeAssert.ok(
      buildCommandCodeTurnArgs({ prompt: "hi", runtimeMode: "full-access" }).includes("--yolo"),
    );
  });

  it("keeps the prompt out of flag parsing and resumes by session id", () => {
    const args = buildCommandCodeTurnArgs({
      prompt: "--not-a-flag",
      runtimeMode: "approval-required",
      sessionId: "abc",
      model: "deepseek/deepseek-v4-pro",
      effort: "high",
    });
    NodeAssert.deepEqual(args, [
      "--print=--not-a-flag",
      "--output-format",
      "json",
      "--skip-onboarding",
      "--session",
      "abc",
      "--model",
      "deepseek/deepseek-v4-pro",
      "--effort",
      "high",
    ]);
  });
});

describe("translateCommandCodeLine", () => {
  it("maps a happy turn with streamed text and one tool call", () => {
    const { state, events, ignored } = run(HAPPY_TURN, { exitCode: 0, interruptRequested: false });

    NodeAssert.equal(state.sessionId, "11111111-2222-3333-4444-555555555555");
    NodeAssert.deepEqual(ignored, ["some_future_event"]);

    const assistantText = events
      .filter((entry) => entry.type === "content.delta")
      .flatMap((entry) =>
        entry.type === "content.delta" && entry.payload.streamKind === "assistant_text"
          ? [entry.payload.delta]
          : [],
      )
      .join("");
    NodeAssert.equal(assistantText, "Reading it now.The title is Title.");

    const reasoning = events.find(
      (entry) => entry.type === "item.completed" && entry.payload.itemType === "reasoning",
    );
    NodeAssert.equal(
      reasoning?.type === "item.completed" && reasoning.payload.detail,
      "Look at the file.",
    );

    const assistantItems = events.filter(
      (entry) => entry.type === "item.completed" && entry.payload.itemType === "assistant_message",
    );
    NodeAssert.equal(assistantItems.length, 2, "one assistant item per model message");

    const toolEvents = events.filter((entry) => entry.itemId === "call_1");
    NodeAssert.deepEqual(
      toolEvents.map((entry) => entry.type),
      ["item.started", "item.updated", "item.completed"],
    );
    const toolDone = toolEvents.at(-1);
    NodeAssert.ok(toolDone?.type === "item.completed");
    NodeAssert.equal(toolDone.payload.status, "completed");
    NodeAssert.deepEqual(toolDone.payload.data, {
      toolName: "read_file",
      input: { file_path: "README.md" },
      result: "# Title",
    });

    const payload = terminal(events);
    NodeAssert.equal(payload.state, "completed");
    NodeAssert.equal(payload.stopReason, "end_turn");
    NodeAssert.deepEqual(payload.tokenUsage, {
      usageScope: "main_agent",
      usageStatus: "complete",
      inputTokens: 1200,
      outputTokens: 80,
      cachedInputTokens: 1000,
      hasSubagents: false,
    });
    NodeAssert.ok(events.every((entry) => entry.turnId === "turn-1"));
  });

  it("fails a max_turns result with the turn-limit reason", () => {
    const { events } = run(
      [
        event({ type: "run_start", sessionId: "s-1" }),
        event({ type: "message_start" }),
        event({ type: "text_delta", delta: "Partial" }),
        event({ type: "message_end", content: [{ type: "text", text: "Partial" }] }),
        result({
          subtype: "max_turns",
          sessionId: "s-1",
          stopReason: "max_turns",
          finalText: "Partial",
        }),
      ],
      {
        exitCode: 8,
        interruptRequested: false,
        stderr: "Warning: Reached maximum conversation turns (100).",
      },
    );
    const payload = terminal(events);
    NodeAssert.equal(payload.state, "failed");
    NodeAssert.equal(payload.stopReason, "max_turns");
    NodeAssert.match(payload.errorMessage ?? "", /turn limit/);
  });

  it("maps an error result's exit code to a clear failure reason", () => {
    const cases: ReadonlyArray<readonly [number, RegExp]> = [
      [3, /not signed in.*command-code login/],
      [4, /denied permission/],
      [5, /rate limited/],
      [10, /insufficient credits/],
    ];
    for (const [exitCode, reason] of cases) {
      const { events } = run(
        [result({ subtype: "error", finalText: "", error: "Error: upstream said no" })],
        { exitCode, interruptRequested: false },
      );
      const payload = terminal(events);
      NodeAssert.equal(payload.state, "failed", `exit ${exitCode}`);
      NodeAssert.match(payload.errorMessage ?? "", reason, `exit ${exitCode}`);
      NodeAssert.match(payload.errorMessage ?? "", /upstream said no/, `exit ${exitCode}`);
    }
  });

  it("marks an interrupted run interrupted and closes the open tool", () => {
    const { events } = run(
      [
        event({ type: "run_start", sessionId: "s-2" }),
        event({ type: "message_start" }),
        event({
          type: "tool_queued",
          toolCallId: "call_9",
          toolName: "grep",
          input: { pattern: "TODO" },
        }),
        event({ type: "interrupted" }),
        result({ subtype: "success", sessionId: "s-2", stopReason: "interrupted", finalText: "" }),
      ],
      { exitCode: 130, interruptRequested: true },
    );
    const closed = events.find(
      (entry) => entry.type === "item.completed" && entry.itemId === "call_9",
    );
    NodeAssert.ok(closed?.type === "item.completed");
    NodeAssert.equal(closed.payload.status, "declined");
    const payload = terminal(events);
    NodeAssert.equal(payload.state, "interrupted");
  });

  it("reports a tool blocked by the print permission gate as declined and denied", () => {
    const hookOutput =
      'Error: Tool "write_file" requires permissions. Use --yolo (or --dangerously-skip-permissions) to enable file writes and shell commands in print mode.';
    NodeAssert.ok(COMMAND_CODE_PRINT_GATED_TOOLS.has("write_file"));
    const { events } = run(
      [
        event({
          type: "tool_queued",
          toolCallId: "call_w",
          toolName: "write_file",
          input: { file_path: "a.txt", content: "x" },
        }),
        event({
          type: "tool_hook_blocked",
          toolCallId: "call_w",
          toolName: "write_file",
          hookOutput,
        }),
        result({
          subtype: "success",
          sessionId: "s-3",
          stopReason: "end_turn",
          finalText: "Could not write.",
        }),
      ],
      { exitCode: 0, interruptRequested: false },
    );
    const blocked = events.find(
      (entry) => entry.type === "item.completed" && entry.itemId === "call_w",
    );
    NodeAssert.ok(blocked?.type === "item.completed");
    NodeAssert.equal(blocked.payload.status, "declined");
    NodeAssert.equal(blocked.payload.itemType, "file_change");
    const denied = events.find((entry) => entry.type === "tool.denied");
    NodeAssert.ok(denied?.type === "tool.denied");
    NodeAssert.equal(denied.payload.toolName, "write_file");
    NodeAssert.equal(denied.payload.reason, hookOutput);
    NodeAssert.equal(terminal(events).state, "completed");
  });

  it("never throws on junk lines", () => {
    const state = makeState();
    for (const line of ["", "not json", "[1,2]", '{"type":"event"}', '{"type":"session"}']) {
      NodeAssert.deepEqual(translateCommandCodeLine(line, state), []);
    }
  });

  it("fails a run that exits before printing a result", () => {
    const { events } = run([], { exitCode: 1, interruptRequested: false, stderr: "boom\n" });
    const payload = terminal(events);
    NodeAssert.equal(payload.state, "failed");
    NodeAssert.equal(payload.errorMessage, "boom");
  });

  it("fails a real weekly-limit run (captured 2026-09-23, exit 5) with the CLI's own message", () => {
    const lines = NodeFs.readFileSync(
      NodePath.join(import.meta.dirname, "__fixtures__", "commandCode-weekly-limit.ndjson"),
      "utf8",
    )
      .split("\n")
      .filter((line) => line.length > 0);
    const { events, state } = run(lines, { exitCode: 5, interruptRequested: false });
    NodeAssert.equal(state.sessionId, "e28c4188-f81d-47c8-a93a-3c98d131c00e");
    const payload = terminal(events);
    NodeAssert.equal(payload.state, "failed");
    NodeAssert.match(payload.errorMessage ?? "", /rate limited/);
    NodeAssert.match(payload.errorMessage ?? "", /weekly usage limit/);
  });
});
