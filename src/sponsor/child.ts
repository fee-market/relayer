import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const RELAYER_DIR = fileURLToPath(new URL("../..", import.meta.url));

/**
 * Run one of the existing sponsor CLIs (src/sponsor/<script>) as a child process with extra env.
 * Children are used because `config` is read from the environment once at import time, and the sponsor id
 * can change in the middle of onboarding (right after registration).
 */
export function runSponsorScript(script: string, args: string[], env: Record<string, string> = {}, capture = false) {
  const res = spawnSync("npx", ["tsx", fileURLToPath(new URL(`./${script}`, import.meta.url)), ...args], {
    cwd: RELAYER_DIR,
    env: { ...process.env, ...env },
    stdio: capture ? ["inherit", "pipe", "inherit"] : "inherit",
    encoding: "utf8",
  });
  return { ok: res.status === 0, stdout: (res.stdout as string | null) ?? "" };
}
