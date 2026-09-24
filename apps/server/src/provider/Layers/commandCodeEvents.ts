/**
 * Pure pieces of the Command Code print-mode adapter: the argv builder (which
 * owns the `--yolo` rule), the NDJSON line translator, and the end-of-turn
 * classifier. Nothing here touches a process, so every rule is unit-testable
 * against hand-written fixtures.
 *
 * `command-code -p … --output-format json` prints one `{"type":"event",
 * "event":<AgentEvent>}` line per harness event and a final
 * `{"type":"result",…}` line. The exit code classifies failures.
 *
 * @module provider/Layers/commandCodeEvents
 */
import {
  type CanonicalItemType,
  type EventId,
  ProviderDriverKind,
  ProviderItemId,
  type ProviderRuntimeEvent,
  type RuntimeMode,
  RuntimeItemId,
  type ThreadId,
  type TurnId,
  type TurnTokenUsage,
} from "@t3tools/contracts";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";

export const COMMAND_CODE_PROVIDER = ProviderDriverKind.make("commandCode");

/** Shown on every turn that runs without `--yolo`. Print mode never asks for approval. */
export const COMMAND_CODE_APPROVAL_NOTICE =
  "Command Code cannot ask for approval in this mode. Switch to Full Access to allow edits and shell.";

/** Tools Command Code's print-mode gate blocks unless `--yolo` is passed. */
export const COMMAND_CODE_PRINT_GATED_TOOLS: ReadonlySet<string> = new Set([
  "edit_file",
  "write_file",
  "shell_command",
  "monitor_command",
  "kill_shell",
]);

/**
 * `--yolo` bypasses every Command Code permission check. Print mode has no
 * approval channel, so it is the only way to allow edits and shell, and it is
 * passed only when the user chose Full Access in T3.
 */
export function commandCodeAllowsYolo(runtimeMode: RuntimeMode): boolean {
  return runtimeMode === "full-access";
}

export interface CommandCodeTurnArgsInput {
  readonly prompt: string;
  readonly runtimeMode: RuntimeMode;
  /** Native session id (or unique prefix) from an earlier turn. */
  readonly sessionId?: string | undefined;
  readonly model?: string | undefined;
  readonly effort?: string | undefined;
}

/** argv for one print-mode turn. The prompt rides in `--print=` so a leading `-` is not read as a flag. */
export function buildCommandCodeTurnArgs(input: CommandCodeTurnArgsInput): ReadonlyArray<string> {
  const model = input.model?.trim();
  const effort = input.effort?.trim();
  const sessionId = input.sessionId?.trim();
  return [
    `--print=${input.prompt}`,
    "--output-format",
    "json",
    "--skip-onboarding",
    ...(sessionId ? ["--session", sessionId] : []),
    ...(model ? ["--model", model] : []),
    ...(effort ? ["--effort", effort] : []),
    ...(commandCodeAllowsYolo(input.runtimeMode) ? ["--yolo"] : []),
  ];
}

// ── Native line shapes ────────────────────────────────────────────────

export interface CommandCodeUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
}

export interface CommandCodeResultLine {
  readonly subtype: "success" | "max_turns" | "error" | string;
  readonly sessionId?: string | undefined;
  readonly stopReason?: string | undefined;
  readonly usage?: CommandCodeUsage | undefined;
  readonly durationMs?: number | undefined;
  readonly finalText: string;
  readonly error?: string | undefined;
}

interface OpenTool {
  readonly toolName: string;
  readonly input: Record<string, unknown>;
  readonly itemType: CanonicalItemType;
  readonly title: string;
  readonly detail: string | undefined;
}

export interface CommandCodeEventStamp {
  readonly eventId: EventId;
  readonly createdAt: string;
}

/**
 * Per-turn translator state. Mutable on purpose: one instance lives for one
 * child process and the translator threads it line by line.
 */
export interface CommandCodeTurnState {
  readonly threadId: ThreadId;
  readonly turnId: TurnId;
  readonly stamp: () => CommandCodeEventStamp;
  /** Model context window from `command-code status --json`, when known. */
  readonly contextWindow?: number | undefined;
  sessionId: string | undefined;
  model: string | undefined;
  messageIndex: number;
  assistantItemId: string | undefined;
  assistantText: string;
  reasoningIndex: number;
  reasoningItemId: string | undefined;
  readonly tools: Map<string, OpenTool>;
  sawSubagent: boolean;
  interrupted: boolean;
  runError: string | undefined;
  result: CommandCodeResultLine | undefined;
  /** Assistant content blocks in order, kept for `readThread`. */
  readonly transcript: Array<unknown>;
  /** Set when the last line was ignored, so the caller can debug-log it. */
  lastIgnored: string | undefined;
}

export function makeCommandCodeTurnState(input: {
  readonly threadId: ThreadId;
  readonly turnId: TurnId;
  readonly stamp: () => CommandCodeEventStamp;
  readonly sessionId?: string | undefined;
  readonly contextWindow?: number | undefined;
}): CommandCodeTurnState {
  return {
    threadId: input.threadId,
    turnId: input.turnId,
    stamp: input.stamp,
    contextWindow: input.contextWindow,
    sessionId: input.sessionId,
    model: undefined,
    messageIndex: 0,
    assistantItemId: undefined,
    assistantText: "",
    reasoningIndex: 0,
    reasoningItemId: undefined,
    tools: new Map(),
    sawSubagent: false,
    interrupted: false,
    runError: undefined,
    result: undefined,
    transcript: [],
    lastIgnored: undefined,
  };
}

// ── Helpers ──────────────────────────────────────────────────────────

const decodeJsonLine = Schema.decodeUnknownExit(Schema.fromJsonString(Schema.Unknown));
const encodeJson = Schema.encodeUnknownExit(Schema.fromJsonString(Schema.Unknown));

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(record: UnknownRecord, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function readNumber(record: UnknownRecord, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Contracts reject blank strings; trim, cap, and drop empties. */
function nonEmpty(value: string | undefined, max = 2_000): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  return trimmed.length > max ? `${trimmed.slice(0, max - 3)}...` : trimmed;
}

function nonNegativeInt(value: number | undefined): number {
  return value !== undefined && value > 0 ? Math.floor(value) : 0;
}

function stringifyForDetail(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  const encoded = encodeJson(value);
  return Exit.isSuccess(encoded) ? encoded.value : undefined;
}

/** Text of a string or an Anthropic-shaped content array. */
function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => {
      if (typeof block === "string") return block;
      if (isRecord(block) && block.type === "text" && typeof block.text === "string") {
        return block.text;
      }
      return "";
    })
    .join("");
}

function readUsage(value: unknown): CommandCodeUsage | undefined {
  if (!isRecord(value)) return undefined;
  return {
    inputTokens: nonNegativeInt(readNumber(value, "inputTokens")),
    outputTokens: nonNegativeInt(readNumber(value, "outputTokens")),
    cacheReadTokens: nonNegativeInt(readNumber(value, "cacheReadTokens")),
    cacheWriteTokens: nonNegativeInt(readNumber(value, "cacheWriteTokens")),
  };
}

export function classifyCommandCodeTool(toolName: string): CanonicalItemType {
  const name = toolName.toLowerCase();
  if (name.startsWith("mcp__")) return "mcp_tool_call";
  if (
    name === "shell_command" ||
    name === "monitor_command" ||
    name === "kill_shell" ||
    name === "shell_output" ||
    name === "bash" ||
    name === "bash_output"
  ) {
    return "command_execution";
  }
  if (name === "edit_file" || name === "write_file") return "file_change";
  if (name === "web_search" || name === "web_fetch") return "web_search";
  if (name === "agent") return "collab_agent_tool_call";
  return "dynamic_tool_call";
}

function titleForItemType(itemType: CanonicalItemType): string {
  switch (itemType) {
    case "command_execution":
      return "Command run";
    case "file_change":
      return "File change";
    case "mcp_tool_call":
      return "MCP tool call";
    case "collab_agent_tool_call":
      return "Subagent task";
    case "web_search":
      return "Web search";
    default:
      return "Tool call";
  }
}

function summarizeToolInput(toolName: string, input: UnknownRecord): string | undefined {
  const command = readString(input, "command");
  if (command?.trim()) return `${toolName}: ${command.trim()}`;
  const path =
    readString(input, "file_path") ?? readString(input, "path") ?? readString(input, "filePath");
  if (path?.trim()) return `${toolName}: ${path.trim()}`;
  const description = readString(input, "description") ?? readString(input, "prompt");
  if (description?.trim()) return description.trim();
  const serialized = stringifyForDetail(input);
  return serialized && serialized !== "{}" ? `${toolName}: ${serialized}` : toolName;
}

function base(state: CommandCodeTurnState) {
  return {
    ...state.stamp(),
    provider: COMMAND_CODE_PROVIDER,
    threadId: state.threadId,
    turnId: state.turnId,
  };
}

function closeAssistant(state: CommandCodeTurnState): ProviderRuntimeEvent[] {
  const itemId = state.assistantItemId;
  if (!itemId) return [];
  const detail = nonEmpty(state.assistantText, 100_000);
  state.assistantItemId = undefined;
  state.assistantText = "";
  return [
    {
      ...base(state),
      type: "item.completed",
      itemId: RuntimeItemId.make(itemId),
      payload: {
        itemType: "assistant_message",
        status: "completed",
        ...(detail ? { detail } : {}),
      },
    },
  ];
}

function openAssistant(state: CommandCodeTurnState): ProviderRuntimeEvent[] {
  if (state.assistantItemId) return [];
  const itemId = `${state.turnId}:assistant:${state.messageIndex}`;
  state.assistantItemId = itemId;
  state.assistantText = "";
  return [
    {
      ...base(state),
      type: "item.started",
      itemId: RuntimeItemId.make(itemId),
      payload: { itemType: "assistant_message", status: "inProgress" },
    },
  ];
}

function closeReasoning(state: CommandCodeTurnState, text?: string): ProviderRuntimeEvent[] {
  const itemId = state.reasoningItemId;
  if (!itemId) return [];
  state.reasoningItemId = undefined;
  const detail = nonEmpty(text, 100_000);
  return [
    {
      ...base(state),
      type: "item.completed",
      itemId: RuntimeItemId.make(itemId),
      payload: { itemType: "reasoning", status: "completed", ...(detail ? { detail } : {}) },
    },
  ];
}

function openReasoning(state: CommandCodeTurnState): ProviderRuntimeEvent[] {
  if (state.reasoningItemId) return [];
  state.reasoningIndex += 1;
  const itemId = `${state.turnId}:reasoning:${state.reasoningIndex}`;
  state.reasoningItemId = itemId;
  return [
    {
      ...base(state),
      type: "item.started",
      itemId: RuntimeItemId.make(itemId),
      payload: { itemType: "reasoning", status: "inProgress" },
    },
  ];
}

function toolItemEvent(
  state: CommandCodeTurnState,
  type: "item.started" | "item.updated" | "item.completed",
  toolCallId: string,
  tool: OpenTool,
  status: "inProgress" | "completed" | "failed" | "declined",
  extra?: { readonly detail?: string | undefined; readonly result?: string | undefined },
): ProviderRuntimeEvent {
  const detail = nonEmpty(extra?.detail ?? tool.detail, 400);
  const result = nonEmpty(extra?.result, 20_000);
  return {
    ...base(state),
    type,
    itemId: RuntimeItemId.make(toolCallId),
    providerRefs: { providerItemId: ProviderItemId.make(toolCallId) },
    payload: {
      itemType: tool.itemType,
      status,
      title: tool.title,
      ...(detail ? { detail } : {}),
      data: {
        toolName: tool.toolName,
        input: tool.input,
        ...(result ? { result } : {}),
      },
    },
  };
}

/** Tool state for a call whose `tool_queued` line was missed. */
function toolFor(
  state: CommandCodeTurnState,
  event: UnknownRecord,
): [string, OpenTool] | undefined {
  const toolCallId = nonEmpty(readString(event, "toolCallId"), 512);
  if (!toolCallId) return undefined;
  const existing = state.tools.get(toolCallId);
  if (existing) return [toolCallId, existing];
  const toolName = nonEmpty(readString(event, "toolName"), 160) ?? "tool";
  const itemType = classifyCommandCodeTool(toolName);
  const tool: OpenTool = {
    toolName,
    input: {},
    itemType,
    title: titleForItemType(itemType),
    detail: toolName,
  };
  state.tools.set(toolCallId, tool);
  return [toolCallId, tool];
}

function denyTool(state: CommandCodeTurnState, event: UnknownRecord, reason: string | undefined) {
  const entry = toolFor(state, event);
  if (!entry) return [];
  const [toolCallId, tool] = entry;
  state.tools.delete(toolCallId);
  const denialReason = nonEmpty(reason, 2_000);
  return [
    toolItemEvent(
      state,
      "item.completed",
      toolCallId,
      tool,
      "declined",
      denialReason ? { detail: denialReason } : {},
    ),
    {
      ...base(state),
      type: "tool.denied",
      payload: {
        toolName: tool.toolName,
        toolUseId: toolCallId,
        ...(denialReason ? { reason: denialReason } : {}),
      },
    },
  ] satisfies ProviderRuntimeEvent[];
}

// ── Translator ───────────────────────────────────────────────────────

/**
 * Translate one stdout line. Unknown event types and unparseable lines return
 * `[]` and set `state.lastIgnored`; they are never fatal.
 */
export function translateCommandCodeLine(
  line: string,
  state: CommandCodeTurnState,
): ProviderRuntimeEvent[] {
  state.lastIgnored = undefined;
  const trimmed = line.trim();
  if (!trimmed) return [];
  const decoded = decodeJsonLine(trimmed);
  if (Exit.isFailure(decoded) || !isRecord(decoded.value)) {
    state.lastIgnored = "non-json";
    return [];
  }
  const record = decoded.value;
  if (record.type === "result") {
    return translateResult(record, state);
  }
  if (record.type !== "event" || !isRecord(record.event)) {
    state.lastIgnored = typeof record.type === "string" ? record.type : "unknown-line";
    return [];
  }
  return translateEvent(record.event, state);
}

function translateResult(record: UnknownRecord, state: CommandCodeTurnState) {
  const result: CommandCodeResultLine = {
    subtype: readString(record, "subtype") ?? "error",
    sessionId: readString(record, "sessionId"),
    stopReason: readString(record, "stopReason"),
    usage: readUsage(record.usage),
    durationMs: readNumber(record, "durationMs"),
    finalText: readString(record, "finalText") ?? "",
    error: readString(record, "error"),
  };
  state.result = result;
  if (result.sessionId) state.sessionId = result.sessionId;
  // The result is terminal output; close anything the event stream left open.
  return [...closeReasoning(state), ...closeAssistant(state)];
}

function translateEvent(event: UnknownRecord, state: CommandCodeTurnState): ProviderRuntimeEvent[] {
  const type = readString(event, "type") ?? "";
  switch (type) {
    case "run_start": {
      const sessionId = nonEmpty(readString(event, "sessionId"), 512);
      if (sessionId) state.sessionId = sessionId;
      return [];
    }
    case "message_start":
      state.messageIndex += 1;
      return [];
    case "model_request_start": {
      const model = nonEmpty(readString(event, "model"), 200);
      if (model) state.model = model;
      return [];
    }
    case "text_delta": {
      const delta = readString(event, "delta") ?? "";
      if (!delta) return [];
      const opened = [...closeReasoning(state), ...openAssistant(state)];
      state.assistantText += delta;
      return [
        ...opened,
        {
          ...base(state),
          type: "content.delta",
          itemId: RuntimeItemId.make(state.assistantItemId!),
          payload: { streamKind: "assistant_text", delta },
        },
      ];
    }
    case "thinking_start":
      return openReasoning(state);
    case "thinking_delta": {
      const delta = readString(event, "delta") ?? "";
      if (!delta) return [];
      const opened = openReasoning(state);
      return [
        ...opened,
        {
          ...base(state),
          type: "content.delta",
          itemId: RuntimeItemId.make(state.reasoningItemId!),
          payload: { streamKind: "reasoning_text", delta },
        },
      ];
    }
    case "thinking_end":
      return closeReasoning(state, readString(event, "text"));
    case "message_end": {
      const content = event.content;
      if (Array.isArray(content)) state.transcript.push(...content);
      // A reply that arrived whole (no text_delta) still needs a message row.
      const text = contentText(content);
      const events: ProviderRuntimeEvent[] = [...closeReasoning(state)];
      if (!state.assistantItemId && text.trim()) {
        events.push(...openAssistant(state));
        state.assistantText = text;
      }
      events.push(...closeAssistant(state));
      return events;
    }
    case "model_request_end": {
      const usage = readUsage(event.usage);
      if (!usage) return [];
      const used = usage.inputTokens + usage.outputTokens;
      if (used <= 0) return [];
      return [
        {
          ...base(state),
          type: "thread.token-usage.updated",
          payload: {
            usage: {
              usedTokens: used,
              lastUsedTokens: used,
              lastInputTokens: usage.inputTokens,
              lastCachedInputTokens: usage.cacheReadTokens,
              lastOutputTokens: usage.outputTokens,
              ...(state.contextWindow && state.contextWindow > 0
                ? { maxTokens: Math.floor(state.contextWindow) }
                : {}),
            },
          },
        },
      ];
    }
    case "tool_queued": {
      const toolCallId = nonEmpty(readString(event, "toolCallId"), 512);
      if (!toolCallId) return [];
      const toolName = nonEmpty(readString(event, "toolName"), 160) ?? "tool";
      const input = isRecord(event.input) ? event.input : {};
      const itemType = classifyCommandCodeTool(toolName);
      const tool: OpenTool = {
        toolName,
        input,
        itemType,
        title: titleForItemType(itemType),
        detail: summarizeToolInput(toolName, input),
      };
      state.tools.set(toolCallId, tool);
      return [
        ...closeReasoning(state),
        ...closeAssistant(state),
        toolItemEvent(state, "item.started", toolCallId, tool, "inProgress"),
      ];
    }
    case "tool_running": {
      const entry = toolFor(state, event);
      if (!entry) return [];
      const description = readString(event, "description");
      return [
        toolItemEvent(
          state,
          "item.updated",
          entry[0],
          entry[1],
          "inProgress",
          description ? { detail: description } : {},
        ),
      ];
    }
    case "tool_completed": {
      const entry = toolFor(state, event);
      if (!entry) return [];
      state.tools.delete(entry[0]);
      return [
        toolItemEvent(state, "item.completed", entry[0], entry[1], "completed", {
          result: contentText(event.result) || stringifyForDetail(event.result),
        }),
      ];
    }
    case "tool_errored": {
      const entry = toolFor(state, event);
      if (!entry) return [];
      state.tools.delete(entry[0]);
      const error = readString(event, "error") ?? stringifyForDetail(event.error);
      return [
        toolItemEvent(state, "item.completed", entry[0], entry[1], "failed", {
          result: error,
        }),
      ];
    }
    // Permission check denied the call. The whole batch then aborts.
    case "tool_denied":
      return denyTool(state, event, "Command Code denied this tool call.");
    // A beforeToolCall hook blocked the call. In print mode without --yolo
    // this is the permission gate for edits and shell; hookOutput says why.
    case "tool_hook_blocked":
      return denyTool(state, event, readString(event, "hookOutput"));
    case "subagent_start":
      state.sawSubagent = true;
      return [];
    case "notice": {
      const level = readString(event, "level");
      const message = nonEmpty(readString(event, "message"));
      if (!message || (level !== "warning" && level !== "error")) {
        state.lastIgnored = "notice";
        return [];
      }
      return [{ ...base(state), type: "runtime.warning", payload: { message } }];
    }
    case "run_error": {
      const error = event.error;
      state.runError =
        (isRecord(error) ? readString(error, "message") : undefined) ??
        (typeof error === "string" ? error : undefined) ??
        "Command Code run failed.";
      return [];
    }
    case "interrupted":
      state.interrupted = true;
      return [];
    // Bookkeeping with no T3 counterpart. Listed so they are not logged as unknown.
    case "run_end":
    case "turn_start":
    case "turn_end":
    case "message_update":
    case "tool_update":
    case "tool_hooks":
    case "subagent_progress":
    case "subagent_stop":
    case "api_retry":
    case "compaction_start":
    case "compaction_done":
    case "skill_loaded":
    case "session_titled":
    case "permission_mode_changed":
    case "config_setting_changed":
    case "continuation_recovery":
    case "tool_input_coerced":
    case "tool_input_repaired":
    case "mod_error":
      return [];
    default:
      state.lastIgnored = type || "untyped-event";
      return [];
  }
}

// ── End of turn ──────────────────────────────────────────────────────

/** Documented `command-code -p` exit codes that need their own failure text. */
export function describeCommandCodeExit(exitCode: number): string | undefined {
  switch (exitCode) {
    case 3:
      return "Command Code is not signed in. Run `command-code login`, then try again.";
    case 4:
      return "Command Code was denied permission to run a tool.";
    case 5:
      return "Command Code is rate limited. Wait a moment, then try again.";
    case 6:
      return "Command Code could not reach its API. Check the network connection.";
    case 7:
      return "Command Code's API returned a server error. Try again later.";
    case 8:
      return "Command Code stopped at its turn limit. The response may be incomplete.";
    case 9:
      return "Command Code returned no response.";
    case 10:
      return "Command Code has insufficient credits for this request.";
    default:
      return undefined;
  }
}

export interface CommandCodeTurnOutcome {
  /** Process exit code, or undefined when the process never ran. */
  readonly exitCode: number | undefined;
  readonly interruptRequested: boolean;
  /** Tail of stderr, used only when stdout carried no reason. */
  readonly stderr?: string | undefined;
  /** Spawn or stream failure before any exit code. */
  readonly failure?: string | undefined;
}

function turnTokenUsage(state: CommandCodeTurnState): TurnTokenUsage | undefined {
  const usage = state.result?.usage;
  if (!usage) return undefined;
  // Command Code reports AI SDK totals: inputTokens already includes cache reads.
  return {
    usageScope: "main_agent",
    usageStatus: "complete",
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    ...(usage.cacheReadTokens > 0 ? { cachedInputTokens: usage.cacheReadTokens } : {}),
    ...(usage.cacheWriteTokens > 0 ? { cacheCreationTokens: usage.cacheWriteTokens } : {}),
    hasSubagents: state.sawSubagent,
  };
}

/** Close open items and emit the one terminal `turn.completed` for this turn. */
export function finishCommandCodeTurn(
  state: CommandCodeTurnState,
  outcome: CommandCodeTurnOutcome,
): ProviderRuntimeEvent[] {
  const events: ProviderRuntimeEvent[] = [...closeReasoning(state), ...closeAssistant(state)];
  const interrupted =
    outcome.interruptRequested ||
    state.interrupted ||
    outcome.exitCode === 130 ||
    state.result?.stopReason === "interrupted";
  for (const [toolCallId, tool] of state.tools) {
    events.push(
      toolItemEvent(
        state,
        "item.completed",
        toolCallId,
        tool,
        interrupted ? "declined" : "failed",
        {},
      ),
    );
  }
  state.tools.clear();

  const tokenUsage = turnTokenUsage(state);
  const result = state.result;
  const stopReason = nonEmpty(result?.stopReason, 200);
  const completed = (
    turnState: "completed" | "failed" | "interrupted",
    errorMessage?: string,
  ): ProviderRuntimeEvent => {
    const message = nonEmpty(errorMessage);
    return {
      ...base(state),
      type: "turn.completed",
      payload: {
        state: turnState,
        ...(stopReason ? { stopReason } : {}),
        ...(result?.usage ? { usage: result.usage } : {}),
        ...(message ? { errorMessage: message } : {}),
        ...(tokenUsage ? { tokenUsage } : {}),
      },
    };
  };

  if (interrupted) {
    events.push(completed("interrupted"));
    return events;
  }
  if (outcome.failure !== undefined) {
    events.push(completed("failed", outcome.failure));
    return events;
  }

  const exitCode = outcome.exitCode ?? 1;
  if (result?.subtype === "success" && exitCode === 0) {
    events.push(completed("completed"));
    return events;
  }

  // Exit code first: it is the documented classifier. Native text adds detail.
  const reason = describeCommandCodeExit(exitCode);
  const nativeDetail = nonEmpty(
    result?.error ?? state.runError ?? lastLine(outcome.stderr),
    1_000,
  )?.replace(/^Error:\s*/i, "");
  const message =
    reason && nativeDetail && !reason.includes(nativeDetail)
      ? `${reason} (${nativeDetail})`
      : (reason ??
        nativeDetail ??
        (result === undefined
          ? `Command Code exited with code ${exitCode} before reporting a result.`
          : `Command Code exited with code ${exitCode}.`));
  events.push(completed("failed", message));
  return events;
}

function lastLine(text: string | undefined): string | undefined {
  if (!text) return undefined;
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.at(-1);
}
