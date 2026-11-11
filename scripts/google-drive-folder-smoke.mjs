// Google Drive folder smoke test: finds or creates ROOT/2026/October only, twice, and checks for duplicates.
// Never prints secrets, never uploads, never deletes. Usage: node scripts/google-drive-folder-smoke.mjs [path/to/.env]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const envPath = path.resolve(process.argv[2] ?? path.join(path.dirname(fileURLToPath(import.meta.url)), "..", ".env"));
const env = {};
for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
  const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (m) env[m[1]] = m[2].trim().replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1");
}
const ROOT = env.GOOGLE_DRIVE_ROOT_FOLDER_ID;
const FOLDER = "application/vnd.google-apps.folder";
const API = "https://www.googleapis.com/drive/v3";
const ALL_DRIVES = "supportsAllDrives=true";

async function accessToken() {
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: env.GOOGLE_OAUTH_CLIENT_ID, client_secret: env.GOOGLE_OAUTH_CLIENT_SECRET, refresh_token: env.GOOGLE_OAUTH_REFRESH_TOKEN, grant_type: "refresh_token" }),
  });
  const body = await response.json();
  if (!response.ok) throw new Error(`TOKEN_REFRESH_FAILED ${response.status} ${body.error ?? ""} ${body.error_description ?? ""}`);
  return { token: body.access_token, scope: body.scope };
}

process.on("uncaughtException", (error) => { console.log("FAIL:", error.message); process.exit(1); });
const { token, scope } = await accessToken();
console.log("TOKEN REFRESH: PASS · scopes:", scope);
async function drive(path, init = {}) {
  const response = await fetch(`${API}${path}`, { ...init, headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...(init.headers ?? {}) } });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`DRIVE ${response.status} ${body.error?.message ?? ""}`);
  return body;
}
const quote = (value) => `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
async function childFolders(parentId, name) {
  const q = `${quote(parentId)} in parents and name = ${quote(name)} and mimeType = '${FOLDER}' and trashed = false`;
  const result = await drive(`/files?${ALL_DRIVES}&includeItemsFromAllDrives=true&corpora=allDrives&fields=files(id,name,parents)&q=${encodeURIComponent(q)}`);
  return result.files;
}
async function ensureFolder(parentId, name) {
  const existing = await childFolders(parentId, name);
  if (existing.length > 1) throw new Error(`DUPLICATE_FOLDER "${name}" under ${parentId}: ${existing.map((f) => f.id).join(", ")}`);
  if (existing.length === 1) return { id: existing[0].id, status: "REUSED" };
  const created = await drive(`/files?${ALL_DRIVES}&fields=id`, { method: "POST", body: JSON.stringify({ name, mimeType: FOLDER, parents: [parentId] }) });
  return { id: created.id, status: "CREATED" };
}

const root = await drive(`/files/${ROOT}?${ALL_DRIVES}&fields=id,name,mimeType,driveId,capabilities(canAddChildren)`);
console.log("ROOT ACCESS:", root.mimeType === FOLDER && root.capabilities?.canAddChildren ? "PASS" : "FAIL", `· "${root.name}" · ${root.driveId ? "Shared Drive" : "My Drive"} · canAddChildren=${root.capabilities?.canAddChildren}`);
if (!root.capabilities?.canAddChildren) process.exit(1);

const runs = [];
for (const run of [1, 2]) {
  const year = await ensureFolder(ROOT, "2026");
  const month = await ensureFolder(year.id, "October");
  runs.push({ year, month });
  console.log(`RUN ${run}: 2026=${year.status} (${year.id}) · October=${month.status} (${month.id})`);
}
const years = await childFolders(ROOT, "2026");
const months = await childFolders(runs[0].year.id, "October");
const novembers = await childFolders(runs[0].year.id, "November");
const yearMeta = await drive(`/files/${runs[0].year.id}?${ALL_DRIVES}&fields=parents`);
const monthMeta = await drive(`/files/${runs[0].month.id}?${ALL_DRIVES}&fields=parents`);
const sameIds = runs[0].year.id === runs[1].year.id && runs[0].month.id === runs[1].month.id;
console.log("2026 folders under root:", years.length, "· October folders under 2026:", months.length, "· November folders:", novembers.length);
console.log("2026 parent is root:", yearMeta.parents?.includes(ROOT), "· October parent is 2026:", monthMeta.parents?.includes(runs[0].year.id));
console.log("DUPLICATE TEST:", sameIds && years.length === 1 && months.length === 1 && runs[1].year.status === "REUSED" && runs[1].month.status === "REUSED" ? "PASS" : "FAIL");
