import { describe, expect, it } from "@effect/vitest";
import { CODE_PUPPY_DEFAULT_MODEL } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";

import {
  applyCodePuppyAcpModelSelection,
  buildCodePuppyAcpSpawnInput,
  codePuppyAcpSpawnArgs,
  codePuppyModelOptions,
  currentCodePuppyModel,
} from "./CodePuppyAcpSupport.ts";

// Shape Code Puppy 0.0.867 returns from `session/new`.
const modelConfig = {
  id: "model",
  name: "Model",
  category: "model",
  type: "select",
  currentValue: "glm-fleet",
  options: [
    { value: "glm-fleet", name: "glm-fleet" },
    { value: "qwen-fleet", name: "qwen-fleet" },
  ],
} satisfies EffectAcpSchema.SessionConfigOption;
const modeConfig = {
  id: "mode",
  name: "Mode",
  category: "mode",
  type: "select",
  currentValue: "default",
  options: [{ value: "default", name: "Default" }],
} satisfies EffectAcpSchema.SessionConfigOption;

describe("codePuppyAcpSpawnArgs", () => {
  it("keeps approvals on in Supervised mode", () => {
    expect(codePuppyAcpSpawnArgs("approval-required")).toEqual(["--acp", "--yolo", "false"]);
  });

  it("turns approvals off in Full access mode", () => {
    expect(codePuppyAcpSpawnArgs("full-access")).toEqual(["--acp", "--yolo", "true"]);
  });

  it("maps the remaining runtime modes", () => {
    expect(codePuppyAcpSpawnArgs("auto-accept-edits")).toEqual(["--acp", "--yolo", "false"]);
    expect(codePuppyAcpSpawnArgs("auto")).toEqual(["--acp", "--yolo", "true"]);
    expect(codePuppyAcpSpawnArgs()).toEqual(["--acp", "--yolo", "false"]);
  });
});

describe("buildCodePuppyAcpSpawnInput", () => {
  it("uses the configured binary and falls back to code-puppy on PATH", () => {
    expect(
      buildCodePuppyAcpSpawnInput(
        { binaryPath: "/Users/me/.local/bin/code-puppy" },
        "/tmp/project",
        { HOME: "/Users/me" },
        "full-access",
      ),
    ).toEqual({
      command: "/Users/me/.local/bin/code-puppy",
      args: ["--acp", "--yolo", "true"],
      cwd: "/tmp/project",
      env: { HOME: "/Users/me" },
    });
    expect(buildCodePuppyAcpSpawnInput(undefined, "/tmp/project").command).toBe("code-puppy");
  });
});

describe("Code Puppy model config option", () => {
  it("reads the model list and current model, ignoring other select options", () => {
    const configOptions = [modeConfig, modelConfig];
    expect(codePuppyModelOptions(configOptions).map((option) => option.value)).toEqual([
      "glm-fleet",
      "qwen-fleet",
    ]);
    expect(currentCodePuppyModel(configOptions)).toBe("glm-fleet");
    expect(codePuppyModelOptions([modeConfig])).toEqual([]);
    expect(currentCodePuppyModel(undefined)).toBeUndefined();
  });
});

describe("applyCodePuppyAcpModelSelection", () => {
  const makeRuntime = (failure?: EffectAcpErrors.AcpError) => {
    const selections: string[] = [];
    const setModel = Effect.fn("CodePuppyAcpSupportTest.setModel")(function* (model: string) {
      if (failure) return yield* failure;
      selections.push(model);
    });
    return {
      runtime: { getConfigOptions: Effect.succeed([modelConfig, modeConfig]), setModel },
      selections,
    };
  };

  it.effect("switches the model through the config option", () =>
    Effect.gen(function* () {
      const { runtime, selections } = makeRuntime();
      const model = yield* applyCodePuppyAcpModelSelection({
        runtime,
        model: "qwen-fleet",
        mapError: (cause) => cause.message,
      });
      expect(selections).toEqual(["qwen-fleet"]);
      expect(model).toBe("qwen-fleet");
    }),
  );

  it.effect("keeps the session's current model for the default slug or no selection", () =>
    Effect.gen(function* () {
      const { runtime, selections } = makeRuntime();
      for (const requested of [CODE_PUPPY_DEFAULT_MODEL, undefined, "glm-fleet"]) {
        const model = yield* applyCodePuppyAcpModelSelection({
          runtime,
          model: requested,
          mapError: (cause) => cause.message,
        });
        expect(model).toBe("glm-fleet");
      }
      expect(selections).toEqual([]);
    }),
  );

  it.effect("rejects a model Code Puppy does not offer", () =>
    Effect.gen(function* () {
      const { runtime, selections } = makeRuntime();
      const error = yield* Effect.flip(
        applyCodePuppyAcpModelSelection({
          runtime,
          model: "gone-model",
          mapError: (cause) => cause.message,
        }),
      );
      expect(error).toContain("gone-model");
      expect(selections).toEqual([]);
    }),
  );

  it.effect("propagates set_config_option failures via mapError", () =>
    Effect.gen(function* () {
      const failure = EffectAcpErrors.AcpRequestError.invalidParams("session id not known");
      const { runtime } = makeRuntime(failure);
      const error = yield* Effect.flip(
        applyCodePuppyAcpModelSelection({
          runtime,
          model: "qwen-fleet",
          mapError: (cause) => cause.message,
        }),
      );
      expect(error).toBe(failure.message);
    }),
  );
});
