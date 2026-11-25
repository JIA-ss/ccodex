import { describe, expect, it } from "vitest";
import { isLocalBuild } from "../../src/management/commands.js";

describe("local builds", () => {
  it("knows a local build by its version", () => {
    expect(isLocalBuild("0.5.24-local.20261125.abc1234")).toBe(true);
    expect(isLocalBuild("0.5.24")).toBe(false);
    expect(isLocalBuild("0.6.0-next.1")).toBe(false);
  });
});
