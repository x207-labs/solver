import { execFileSync } from "node:child_process";

// CLI tests spawn real processes against dist/, so build it once per run.
export default function setup(): void {
  execFileSync("node_modules/.bin/tsc", ["-p", "tsconfig.json"], { stdio: "inherit" });
}
