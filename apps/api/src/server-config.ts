import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { parseEnv } from "node:util";

/** Railway and other platforms provide PORT; local development is deliberately stable. */
export function resolveServerPort(port: string | undefined): number {
  return port ? Number(port) : 4000;
}

export function isLoopbackHost(host: string): boolean {
  return host === "localhost" || host === "::1" || /^127(?:\.\d{1,3}){3}$/.test(host);
}

/** Storage directories that a .env may give as relative paths. */
const RELATIVE_PATH_KEYS = ["SCREENSHOT_STORAGE_DIR", "REPORT_ARTIFACT_STORAGE_DIR"] as const;

/**
 * Loads a local .env outside production. Existing environment variables are never overridden, and a relative storage
 * path taken from the file is resolved against the file's own directory, so it is the same whether npm starts the API
 * from the repository or from apps/api.
 */
export function loadLocalEnvironment(file: string, environment: NodeJS.ProcessEnv = process.env): boolean {
  if (environment.NODE_ENV === "production" || !existsSync(file)) return false;
  const preset = new Set(Object.keys(environment).filter((key) => environment[key] !== undefined));
  const loaded = parseEnv(readFileSync(file, "utf8"));
  for (const [key, value] of Object.entries(loaded)) {
    if (preset.has(key)) continue;
    environment[key] = (RELATIVE_PATH_KEYS as readonly string[]).includes(key) && value && !isAbsolute(value) ? resolve(dirname(file), value) : value;
  }
  return true;
}
