// Mints a Google Drive refresh token for the OAuth client in .env and saves it into .env.
// Never prints client secrets, authorization codes, or tokens.
// Usage (from the project root): node scripts/google-oauth-login.mjs [path/to/.env]
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";

const envPath = path.resolve(process.argv[2] ?? path.join(path.dirname(fileURLToPath(import.meta.url)), "..", ".env"));
if (!fs.existsSync(envPath)) { console.log(`OAUTH LOGIN: FAIL (.env not found at ${envPath})`); process.exit(1); }
const text = fs.readFileSync(envPath, "utf8");
const env = {};
for (const line of text.split(/\r?\n/)) {
  const m = line.match(/^[ \t]*(?:export[ \t]+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (m) env[m[1]] = m[2].trim().replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1");
}
if (!env.GOOGLE_OAUTH_CLIENT_ID || !env.GOOGLE_OAUTH_CLIENT_SECRET) { console.log("OAUTH LOGIN: FAIL (GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET missing in .env)"); process.exit(1); }

const PORT = 53682;
const REDIRECT = `http://127.0.0.1:${PORT}/`;
const TIMEOUT_MS = 5 * 60_000;
const state = crypto.randomBytes(16).toString("hex");
const verifier = crypto.randomBytes(48).toString("base64url");
const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
const auth = new URL("https://accounts.google.com/o/oauth2/v2/auth");
auth.search = new URLSearchParams({
  client_id: env.GOOGLE_OAUTH_CLIENT_ID, redirect_uri: REDIRECT, response_type: "code",
  scope: "https://www.googleapis.com/auth/drive", access_type: "offline", prompt: "consent",
  state, code_challenge: challenge, code_challenge_method: "S256",
}).toString();

const tokenRequest = (params) => fetch("https://oauth2.googleapis.com/token", {
  method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ client_id: env.GOOGLE_OAUTH_CLIENT_ID, client_secret: env.GOOGLE_OAUTH_CLIENT_SECRET, ...params }),
});

let done = false;
const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, REDIRECT);
  // Only Google's redirect (carrying code or error) ends the flow; favicon/prefetch requests are ignored.
  if (url.pathname !== "/" || done || (!url.searchParams.has("code") && !url.searchParams.has("error"))) { response.writeHead(404).end(); return; }
  done = true;
  const finish = (ok, message) => {
    response.writeHead(ok ? 200 : 400, { "content-type": "text/plain", connection: "close" }).end(`${message}\n`);
    console.log(message); clearTimeout(timer); server.close(); process.exitCode = ok ? 0 : 1;
  };
  try {
    if (url.searchParams.get("state") !== state) return finish(false, "OAUTH LOGIN: FAIL (state mismatch; nothing was changed)");
    if (url.searchParams.get("error")) return finish(false, `OAUTH LOGIN: FAIL (Google returned ${url.searchParams.get("error")}; nothing was changed)`);
    const exchange = await tokenRequest({ code: url.searchParams.get("code"), code_verifier: verifier, redirect_uri: REDIRECT, grant_type: "authorization_code" });
    const tokens = await exchange.json();
    if (!exchange.ok || !tokens.refresh_token) return finish(false, `OAUTH LOGIN: FAIL (code exchange: ${tokens.error ?? "no refresh token returned"}; nothing was changed)`);
    // Prove the new token refreshes with this exact client before saving it.
    const check = await tokenRequest({ refresh_token: tokens.refresh_token, grant_type: "refresh_token" });
    if (!check.ok) return finish(false, `OAUTH LOGIN: FAIL (new token did not refresh: ${(await check.json()).error}; nothing was changed)`);
    const line = `GOOGLE_OAUTH_REFRESH_TOKEN=${tokens.refresh_token}`;
    const pattern = /^[ \t]*GOOGLE_OAUTH_REFRESH_TOKEN=.*$/m;
    const next = pattern.test(text) ? text.replace(pattern, () => line) : `${text.replace(/\n?$/, "\n")}${line}\n`;
    fs.copyFileSync(envPath, `${envPath}.bak`); fs.chmodSync(`${envPath}.bak`, 0o600);
    const temp = `${envPath}.tmp-${process.pid}`;
    fs.writeFileSync(temp, next, { mode: 0o600 }); fs.renameSync(temp, envPath);
    finish(true, "OAUTH LOGIN: PASS · TOKEN REFRESH: PASS · new refresh token saved to .env (previous .env kept as .env.bak). You can close the browser tab.");
  } catch (error) { finish(false, `OAUTH LOGIN: FAIL (${error instanceof Error ? error.message.slice(0, 120) : "unexpected error"}; nothing was changed)`); }
});
const timer = setTimeout(() => { console.log("OAUTH LOGIN: FAIL (no sign-in within 5 minutes; nothing was changed)"); process.exit(1); }, TIMEOUT_MS);
server.on("error", (error) => {
  console.log(error.code === "EADDRINUSE" ? `OAUTH LOGIN: FAIL (port ${PORT} is already in use; close the other sign-in helper and retry)` : `OAUTH LOGIN: FAIL (${error.message.slice(0, 120)})`);
  process.exit(1);
});
// Asks Google whether it accepts this exact authorization request before any browser opens; a rejection is
// reported with Google's own reason (the URL itself is never printed).
async function preflight() {
  const response = await fetch(auth, { redirect: "manual" });
  const location = response.headers.get("location");
  const target = location ? new URL(location, auth) : null;
  if (response.status >= 400) return `Google answered HTTP ${response.status} to the authorization request`;
  if (!target || !target.pathname.includes("/error")) return null;
  const encoded = target.searchParams.get("authError");
  const reason = encoded ? Buffer.from(encoded, "base64").toString("latin1").replace(/[^\x20-\x7e]+/g, " ").trim().slice(0, 200) : target.searchParams.get("error") ?? "unknown";
  return `Google rejected the authorization request: ${reason}`;
}
// A fresh incognito Chrome window keeps other signed-in Google accounts and stale sign-in cookies out of the flow.
const CHROME = "/Applications/Google Chrome.app";
function openSignIn() {
  if (!process.argv.includes("--no-incognito") && fs.existsSync(CHROME)) {
    console.log("Opening Google sign-in in a new Chrome incognito window.");
    execFile("open", ["-na", CHROME, "--args", "--incognito", auth.toString()]);
  } else {
    console.log("Opening Google sign-in in your default browser.");
    execFile("open", [auth.toString()]);
  }
}
server.listen(PORT, "127.0.0.1", async () => {
  const rejected = await preflight().catch((error) => `Google could not be reached: ${error instanceof Error ? error.message.slice(0, 120) : "unknown error"}`);
  if (rejected) { console.log(`OAUTH LOGIN: FAIL (${rejected}; nothing was changed)`); process.exit(1); }
  console.log("Preflight: Google accepted the authorization request (client, redirect URI, scope, PKCE).");
  console.log(`Waiting on ${REDIRECT} for up to 5 minutes.`);
  console.log("Sign in with the account that owns the Monthly Reports folder and allow Drive access.");
  openSignIn();
});
