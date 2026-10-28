import { mkdir, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { resolve } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { stdin, stdout } from "node:process";
import { chromium } from "playwright";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const profileDirectory = resolve(repositoryRoot, process.env.TENTION_KLAVIYO_PROFILE_DIR ?? "data/klaviyo-test-browser-profile");
const marker = resolve(profileDirectory, ".tention-auth-initialized");
const diagnostics = resolve(profileDirectory, "login-diagnostics.json");

async function main(): Promise<void> {
  if (!stdin.isTTY) throw new Error("LIVE_ACCEPTANCE_BLOCKED_AUTH: run klaviyo:test-login from an interactive terminal to complete login/MFA.");
  await mkdir(profileDirectory, { recursive: true });
  let context: Awaited<ReturnType<typeof chromium.launchPersistentContext>> | undefined;
  try {
    context = await chromium.launchPersistentContext(profileDirectory, {
      headless: false,
      viewport: { width: 1440, height: 1000 },
      ...(process.env.TENTION_KLAVIYO_BROWSER_EXECUTABLE_PATH ? { executablePath: process.env.TENTION_KLAVIYO_BROWSER_EXECUTABLE_PATH } : {}),
    });
    const page = context.pages()[0] ?? await context.newPage();
    try { await page.goto("https://www.klaviyo.com/", { waitUntil: "domcontentloaded", timeout: 60_000 }); }
    catch (error) {
      await writeFile(diagnostics, `${JSON.stringify({ status: "LIVE_ACCEPTANCE_BLOCKED_BROWSER", createdAt: new Date().toISOString(), message: "Headed isolated browser closed before the Klaviyo login page became available.", browserExecutableOverride: Boolean(process.env.TENTION_KLAVIYO_BROWSER_EXECUTABLE_PATH) }, null, 2)}\n`, { mode: 0o600 });
      throw new Error("LIVE_ACCEPTANCE_BLOCKED_BROWSER: headed isolated browser closed before login. Set TENTION_KLAVIYO_BROWSER_EXECUTABLE_PATH to a local Chromium executable if the managed browser cannot remain open.", { cause: error });
    }
    const prompt = createInterface({ input: stdin, output: stdout });
    await prompt.question("Complete Klaviyo login/MFA in the isolated Tention test browser, then press Enter here to save this profile. ");
    prompt.close();
    await writeFile(marker, `${JSON.stringify({ initializedAt: new Date().toISOString(), purpose: "isolated-klaviyo-test-profile" })}\n`, { mode: 0o600 });
    console.log(JSON.stringify({ status: "KLAVIYO_TEST_LOGIN_READY", profileDirectory }));
  } finally { await context?.close(); }
}

void main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
