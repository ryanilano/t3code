import * as NodeAssert from "node:assert/strict";

import { describe, it } from "vite-plus/test";

import { commandCodeModels, parseCommandCodeStatus } from "./CommandCodeProvider.ts";

describe("parseCommandCodeStatus", () => {
  it("reads the status --json line", () => {
    NodeAssert.deepEqual(
      parseCommandCodeStatus(
        '{"authenticated":true,"version":"1.65.0","user":"someone","model":"deepseek/deepseek-v4-flash","context_window":1000000}\n',
      ),
      {
        authenticated: true,
        version: "1.65.0",
        user: "someone",
        model: "deepseek/deepseek-v4-flash",
        context_window: 1000000,
      },
    );
    NodeAssert.equal(parseCommandCodeStatus("Error: not a json line"), undefined);
    NodeAssert.equal(parseCommandCodeStatus('{"version":"1.65.0"}'), undefined);
  });
});

describe("commandCodeModels", () => {
  it("marks the CLI default and adds it when the hand list lacks it", () => {
    const known = commandCodeModels(
      { defaultModel: "", customModels: [] },
      "deepseek/deepseek-v4-pro",
    );
    NodeAssert.deepEqual(
      known.filter((model) => model.isDefault).map((model) => model.slug),
      ["deepseek/deepseek-v4-pro"],
    );

    const unknown = commandCodeModels({ defaultModel: "", customModels: [] }, "vendor/new-model");
    NodeAssert.equal(unknown[0]?.slug, "vendor/new-model");
    NodeAssert.equal(unknown[0]?.isDefault, true);

    const configured = commandCodeModels(
      { defaultModel: "zai-org/GLM-5.3", customModels: ["my/custom"] },
      "deepseek/deepseek-v4-flash",
    );
    NodeAssert.deepEqual(
      configured.filter((model) => model.isDefault).map((model) => model.slug),
      ["zai-org/GLM-5.3"],
    );
    NodeAssert.equal(configured.at(-1)?.slug, "my/custom");
  });
});
