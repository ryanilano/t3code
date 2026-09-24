import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import { CODE_PUPPY_DEFAULT_MODEL, CodePuppySettings } from "@t3tools/contracts";

import {
  buildCodePuppyModelsFromConfigOptions,
  buildInitialCodePuppyProviderSnapshot,
  checkCodePuppyProviderStatus,
} from "./CodePuppyProvider.ts";
import { writeFakeCli } from "../../testUtils/fakeCli.ts";

const decodeCodePuppySettings = Schema.decodeSync(CodePuppySettings);

describe("buildCodePuppyModelsFromConfigOptions", () => {
  it("lists the model option values and marks the session's current model as default", () => {
    const models = buildCodePuppyModelsFromConfigOptions([
      {
        id: "model",
        name: "Model",
        category: "model",
        type: "select",
        currentValue: "qwen-fleet",
        options: [
          { value: "glm-fleet", name: "glm-fleet" },
          { value: "qwen-fleet", name: "Qwen Fleet" },
          { value: "glm-fleet", name: "duplicate" },
        ],
      },
      {
        id: "enable_streaming",
        name: "Streaming responses",
        type: "select",
        currentValue: "on",
        options: [{ value: "on", name: "On" }],
      },
    ]);
    expect(models.map((model) => [model.slug, model.name, model.isDefault ?? false])).toEqual([
      ["glm-fleet", "glm-fleet", false],
      ["qwen-fleet", "Qwen Fleet", true],
    ]);
    expect(models[1]?.aliases).toEqual([CODE_PUPPY_DEFAULT_MODEL]);
  });
});

describe("buildInitialCodePuppyProviderSnapshot", () => {
  it.effect("is disabled by default, since Code Puppy is opt-in", () =>
    Effect.gen(function* () {
      const snapshot = yield* buildInitialCodePuppyProviderSnapshot(decodeCodePuppySettings({}));
      expect(snapshot.enabled).toBe(false);
      expect(snapshot.status).toBe("disabled");
      expect(snapshot.models.map((model) => model.slug)).toEqual([CODE_PUPPY_DEFAULT_MODEL]);
    }),
  );
});

it.layer(NodeServices.layer)("checkCodePuppyProviderStatus", (it) => {
  it.effect("reports the CLI as not installed when the binary path does not resolve", () =>
    Effect.gen(function* () {
      const snapshot = yield* checkCodePuppyProviderStatus(
        decodeCodePuppySettings({
          enabled: true,
          binaryPath: "/definitely/not/installed/code-puppy",
        }),
      );
      expect(snapshot.enabled).toBe(true);
      expect(snapshot.installed).toBe(false);
      expect(snapshot.status).toBe("error");
      expect(snapshot.message).toMatch(/not installed|not on PATH|Failed to execute/);
    }),
  );

  it.effect("reports an installed CLI as unhealthy when --version exits non-zero", () =>
    Effect.gen(function* () {
      const snapshot = yield* Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-code-puppy-version-" });
          const binaryPath = writeFakeCli({
            directory: dir,
            name: "code-puppy",
            source: ['process.stderr.write("broken install\\n");', "process.exit(2);", ""].join(
              "\n",
            ),
          });
          return yield* checkCodePuppyProviderStatus(
            decodeCodePuppySettings({ enabled: true, binaryPath }),
          );
        }),
      );
      expect(snapshot.installed).toBe(true);
      expect(snapshot.status).toBe("error");
      expect(snapshot.message).toBe("Code Puppy CLI is installed but failed to run.");
    }),
  );
});
