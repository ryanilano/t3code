import * as NodeAssert from "node:assert/strict";

import { describe, it } from "vite-plus/test";

import { readCommandCodeFinalResult } from "./CommandCodeTextGeneration.ts";

describe("readCommandCodeFinalResult", () => {
  it("reads the final result line after the event stream", () => {
    const stdout = [
      '{"type":"event","event":{"type":"run_start","sessionId":"s"}}',
      '{"type":"event","event":{"type":"text_delta","delta":"{\\"title\\":\\"x\\"}"}}',
      '{"type":"result","subtype":"success","sessionId":"s","stopReason":"end_turn","usage":{"inputTokens":1,"outputTokens":1,"cacheReadTokens":0,"cacheWriteTokens":0},"durationMs":3,"finalText":"{\\"title\\":\\"x\\"}"}',
      "",
    ].join("\n");
    NodeAssert.deepEqual(readCommandCodeFinalResult(stdout), {
      type: "result",
      subtype: "success",
      finalText: '{"title":"x"}',
    });
  });

  it("keeps the error text of a failed run and ignores non-result output", () => {
    NodeAssert.equal(
      readCommandCodeFinalResult(
        '{"type":"result","subtype":"error","usage":{},"durationMs":1,"finalText":"","error":"Error: not logged in"}\n',
      )?.error,
      "Error: not logged in",
    );
    NodeAssert.equal(readCommandCodeFinalResult("plain text\n"), undefined);
  });
});
