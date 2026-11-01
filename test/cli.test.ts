import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { runCli } from "./run-cli.js";

describe("SV-001 scaffold", () => {
  it("has the three module folders", () => {
    for (const dir of ["src/graph", "src/mincostflow", "src/submit"]) {
      expect(existsSync(dir)).toBe(true);
    }
  });

  it("accepts an epoch argument", async () => {
    const result = await runCli(["--epoch", "42"]);
    expect(result.stderr).toContain("epoch 42");
    expect(result.code).toBe(0);
  });

  it("rejects a missing epoch", async () => {
    const result = await runCli([]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("--epoch");
  });

  it.each(["abc", "-1", "1.5", "99999999999999999999"])("rejects epoch %s", async (epoch) => {
    const result = await runCli([`--epoch=${epoch}`]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("--epoch");
  });
});
