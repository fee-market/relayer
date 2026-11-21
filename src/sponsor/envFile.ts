import { readFileSync, writeFileSync } from "node:fs";

const ENV_PATH = new URL("../../.env", import.meta.url);

/** Replace `KEY=...` in env-file text, or append it if missing. */
export function setEnv(text: string, key: string, value: string): string {
  const re = new RegExp(`^${key}=.*$`, "m");
  return re.test(text) ? text.replace(re, `${key}=${value}`) : `${text.trimEnd()}\n${key}=${value}\n`;
}

/** Persist one key into relayer/.env, preserving mode and the rest of the file. */
export function writeEnvKey(key: string, value: string): void {
  writeFileSync(ENV_PATH, setEnv(readFileSync(ENV_PATH, "utf8"), key, value), { mode: 0o600 });
}
