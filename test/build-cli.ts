import { execFileSync } from "node:child_process";

// CLI tests spawn real processes against dist/, so build it once per run.
// Through npm because node_modules/.bin moves to the umbrella after UM-006.
export default function setup(): void {
  execFileSync("npm", ["run", "--silent", "build"], { stdio: "inherit" });
}
