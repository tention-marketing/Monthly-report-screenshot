import { existsSync, readFileSync } from "node:fs";
import type { ReportDraftRepository } from "@tention/report-domain";
import type { ReportDraft, ReportGoogleDoc, ReportPdfArtifact, ReportPdfDriveDelivery } from "@tention/report-schema";

/**
 * Google Drive delivery of a canonical PDF artifact: ROOT / <year> / <Month> / "<Client> - <Month> <year>.pdf".
 * Drive is an archive copy only. A failed delivery is recorded on the artifact and can be retried from the
 * already-generated PDF; it never touches the canonical artifact, the report, or Klaviyo capture.
 */
export interface PdfDriveDeliveryInput { year: number; month: number; fileName: string; bytes: Buffer }
export interface PdfDriveDeliveryResult { fileId: string; folderId: string; webViewLink: string | null; action: "created" | "updated" }
export interface PdfDriveDelivery { deliver(input: PdfDriveDeliveryInput): Promise<PdfDriveDeliveryResult> }

/**
 * Editable Google Doc copy in the same month folder. A Doc already recorded by Tention is updated in place only if its
 * Drive version still matches what Tention last wrote; otherwise someone edited it in Drive and it is not overwritten
 * unless the caller explicitly forces it.
 */
/**
 * `expected` is what Tention last wrote: its Doc ID, Drive's modifiedTime right after that write (or, for Docs written
 * before modifiedTime was recorded, the time Tention recorded the write), and Drive's version (kept as metadata only).
 */
export interface GoogleDocSyncInput {
  year: number; month: number; name: string; html: string; expected: { docId: string; version: string; modifiedTime?: string | null; writtenAt?: string | null } | null; force: boolean;
  /** The report's client: part of the Tention marker written onto the Doc, so a recreated report can recognise it. */
  clientId?: string;
  /** Explicit adoption of this exact existing Doc (same name, month folder and type), after a person chose it. */
  adoptDocId?: string | null;
}
export interface GoogleDocSyncResult { docId: string; folderId: string; webViewLink: string | null; version: string; modifiedTime: string | null; action: "created" | "updated"; managedBy: "created" | "record" | "marker" | "adopted" }

/**
 * Tention's marker on a Doc it writes (Drive appProperties: visible only to Tention's own OAuth app). Written in the same
 * request as the content, so it never counts as a later modification. Identifies the report by client and month, not by
 * report ID, so a report deleted and created again still recognises its Doc.
 */
const MARKER_TOLERANCE_MS = 120_000;
function tentionMarker(clientId: string, year: number, month: number, writtenAt: string): Record<string, string> {
  return { tentionManaged: "true", tentionClientId: clientId, tentionReportMonth: `${year}-${String(month).padStart(2, "0")}`, tentionWrittenAt: writtenAt };
}
export interface ReportGoogleDocSync { syncGoogleDoc(input: GoogleDocSyncInput): Promise<GoogleDocSyncResult> }

export class DriveDeliveryError extends Error {
  /** For a Doc Tention found but would not overwrite: where it is, so it can be opened (never secrets). */
  constructor(readonly code: string, message: string, readonly details: { docId?: string; webViewLink?: string | null; folderId?: string } = {}) { super(message); this.name = "DriveDeliveryError"; }
}

export interface GoogleDriveOAuthConfig { clientId: string; clientSecret: string; refreshToken: string; rootFolderId: string }

const FOLDER = "application/vnd.google-apps.folder";
const PDF = "application/pdf";
const GOOGLE_DOC = "application/vnd.google-apps.document";
const API = "https://www.googleapis.com/drive/v3";
const UPLOAD = "https://www.googleapis.com/upload/drive/v3";
const ALL_DRIVES = "supportsAllDrives=true";

export function driveMonthFolderName(month: number): string {
  return new Intl.DateTimeFormat("en-US", { month: "long", timeZone: "UTC" }).format(new Date(Date.UTC(2000, month - 1, 1)));
}

/** Deterministic per client + report month, so a regenerated report replaces its Drive copy. */
export function driveFileName(draft: Pick<ReportDraft, "client" | "reportMonth">): string {
  return `${googleDocName(draft)}.pdf`;
}

/** The editable Doc shares the PDF's deterministic name, without the extension. */
export function googleDocName(draft: Pick<ReportDraft, "client" | "reportMonth">): string {
  // Drive accepts most characters; control characters and path separators are removed and whitespace collapsed.
  const name = draft.client.name.replace(/[\u0000-\u001f\u007f/\\]+/g, " ").replace(/\s+/g, " ").trim() || "Client";
  return `${name} - ${driveMonthFolderName(draft.reportMonth.month)} ${draft.reportMonth.year}`;
}

function quote(value: string): string { return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`; }

export class GoogleDrivePdfDelivery implements PdfDriveDelivery, ReportGoogleDocSync {
  constructor(private readonly config: GoogleDriveOAuthConfig, private readonly fetchImpl: typeof fetch = fetch, private readonly now: () => Date = () => new Date()) {}

  async deliver(input: PdfDriveDeliveryInput): Promise<PdfDriveDeliveryResult> {
    const token = await this.accessToken();
    const monthId = await this.monthFolder(token, input.year, input.month);

    const existing = await this.children(token, monthId, input.fileName, `mimeType = '${PDF}'`);
    if (existing.length > 1) throw new DriveDeliveryError("DRIVE_DUPLICATE_FILES", `The ${driveMonthFolderName(input.month)} folder already holds ${existing.length} copies of "${input.fileName}"; resolve them in Drive before retrying.`);
    let fileId: string; let action: "created" | "updated";
    if (existing[0]) {
      fileId = existing[0].id; action = "updated";
      await this.request(token, `${UPLOAD}/files/${encodeURIComponent(fileId)}?uploadType=media&${ALL_DRIVES}&fields=id`, { method: "PATCH", headers: { "content-type": PDF }, body: new Uint8Array(input.bytes) });
    } else {
      const boundary = `tention-${crypto.randomUUID()}`;
      const metadata = JSON.stringify({ name: input.fileName, mimeType: PDF, parents: [monthId] });
      const body = Buffer.concat([
        Buffer.from(`--${boundary}\r\ncontent-type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n--${boundary}\r\ncontent-type: ${PDF}\r\n\r\n`),
        input.bytes, Buffer.from(`\r\n--${boundary}--`),
      ]);
      const created = await this.request<{ id: string }>(token, `${UPLOAD}/files?uploadType=multipart&${ALL_DRIVES}&fields=id`, { method: "POST", headers: { "content-type": `multipart/related; boundary=${boundary}` }, body: new Uint8Array(body) });
      fileId = created.id; action = "created";
    }

    // Read back: the right name, a PDF, in the month folder, of the uploaded size, and the only copy.
    const file = await this.request<{ name: string; mimeType: string; parents?: string[]; size?: string; webViewLink?: string }>(token,
      `${API}/files/${encodeURIComponent(fileId)}?${ALL_DRIVES}&fields=name,mimeType,parents,size,webViewLink`);
    const copies = await this.children(token, monthId, input.fileName, `mimeType = '${PDF}'`);
    if (file.name !== input.fileName || file.mimeType !== PDF || !file.parents?.includes(monthId) || Number(file.size) !== input.bytes.byteLength || copies.length !== 1) {
      throw new DriveDeliveryError("DRIVE_UPLOAD_UNVERIFIED", "The uploaded Drive file could not be verified after upload.");
    }
    return { fileId, folderId: monthId, webViewLink: file.webViewLink ?? null, action };
  }

  async syncGoogleDoc(input: GoogleDocSyncInput): Promise<GoogleDocSyncResult> {
    const token = await this.accessToken();
    const monthId = await this.monthFolder(token, input.year, input.month);
    const existing = await this.children(token, monthId, input.name, `mimeType = '${GOOGLE_DOC}'`);
    if (existing.length > 1) throw new DriveDeliveryError("GOOGLE_DOC_DUPLICATES", `The ${driveMonthFolderName(input.month)} folder already holds ${existing.length} Docs named "${input.name}"; resolve them in Drive before retrying.`);
    const boundary = `tention-${crypto.randomUUID()}`;
    const multipart = (metadata: object) => new Uint8Array(Buffer.concat([
      Buffer.from(`--${boundary}\r\ncontent-type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\ncontent-type: text/html; charset=UTF-8\r\n\r\n`),
      Buffer.from(input.html, "utf8"), Buffer.from(`\r\n--${boundary}--`),
    ]));
    const headers = { "content-type": `multipart/related; boundary=${boundary}` };
    let docId: string; let action: "created" | "updated"; let managedBy: GoogleDocSyncResult["managedBy"];
    const marker = input.clientId ? tentionMarker(input.clientId, input.year, input.month, this.now().toISOString()) : null;
    if (existing[0]) {
      docId = existing[0].id;
      const current = await this.request<{ name?: string; mimeType?: string; parents?: string[]; version?: string; modifiedTime?: string; webViewLink?: string; appProperties?: Record<string, string> }>(token,
        `${API}/files/${encodeURIComponent(docId)}?${ALL_DRIVES}&fields=name,mimeType,parents,version,modifiedTime,webViewLink,appProperties`);
      const found = { docId, webViewLink: current.webViewLink ?? null, folderId: monthId };
      const byRecord = input.expected?.docId === docId;
      const props = current.appProperties ?? {};
      const byMarker = Boolean(input.clientId) && props.tentionManaged === "true" && props.tentionClientId === input.clientId && props.tentionReportMonth === marker?.tentionReportMonth;
      const adopting = Boolean(input.adoptDocId) && input.adoptDocId === docId;
      if (input.adoptDocId && !adopting) throw new DriveDeliveryError("GOOGLE_DOC_ADOPTION_REFUSED", `The Doc chosen for adoption is not the one named "${input.name}" in the ${driveMonthFolderName(input.month)} folder; nothing was changed.`, found);
      if (adopting && (current.name !== input.name || current.mimeType !== GOOGLE_DOC || !current.parents?.includes(monthId))) {
        throw new DriveDeliveryError("GOOGLE_DOC_ADOPTION_REFUSED", `Only the native Google Doc named "${input.name}" in the ${driveMonthFolderName(input.month)} folder can be adopted; nothing was changed.`, found);
      }
      if (!input.force && !adopting) {
        if (!byRecord && !byMarker) throw new DriveDeliveryError("GOOGLE_DOC_NOT_TENTION_MANAGED", `Existing Google Doc "${input.name}" found but not verified as Tention-managed; it was not overwritten.`, found);
        // Only a real modification counts as an edit: modifiedTime changes for edits, while `version` also moves for
        // Drive's invisible processing. Without any recorded time, fail closed on the version as before.
        const edited = byRecord
          ? input.expected!.modifiedTime ? current.modifiedTime !== input.expected!.modifiedTime
            : input.expected!.writtenAt && current.modifiedTime ? Date.parse(current.modifiedTime) > Date.parse(input.expected!.writtenAt)
              : current.version !== input.expected!.version
          // Recognised by its marker only (e.g. the report was created again): edited if modified after Tention's write.
          : !current.modifiedTime || !props.tentionWrittenAt || Date.parse(current.modifiedTime) > Date.parse(props.tentionWrittenAt) + MARKER_TOLERANCE_MS;
        if (edited) throw new DriveDeliveryError("GOOGLE_DOC_EDITED_IN_DRIVE", `"${input.name}" was edited in Google Drive after Tention last wrote it; it was not overwritten.`, found);
      }
      // Re-importing HTML into the existing Doc replaces its content and keeps its file ID, link, and sharing; the marker
      // is written in the same request.
      await this.request(token, `${UPLOAD}/files/${encodeURIComponent(docId)}?uploadType=multipart&${ALL_DRIVES}&fields=id`, { method: "PATCH", headers, body: multipart(marker ? { appProperties: marker } : {}) });
      action = "updated"; managedBy = adopting ? "adopted" : byRecord ? "record" : byMarker ? "marker" : "record";
    } else {
      const created = await this.request<{ id: string }>(token, `${UPLOAD}/files?uploadType=multipart&${ALL_DRIVES}&fields=id`, { method: "POST", headers, body: multipart({ name: input.name, mimeType: GOOGLE_DOC, parents: [monthId], ...(marker ? { appProperties: marker } : {}) }) });
      docId = created.id; action = "created"; managedBy = "created";
    }
    // Read back: a native, editable Google Doc with the right name in the month folder, and the only one.
    const doc = await this.request<{ name: string; mimeType: string; parents?: string[]; version?: string; modifiedTime?: string; webViewLink?: string; capabilities?: { canEdit?: boolean }; appProperties?: Record<string, string> }>(token,
      `${API}/files/${encodeURIComponent(docId)}?${ALL_DRIVES}&fields=name,mimeType,parents,version,modifiedTime,webViewLink,capabilities(canEdit),appProperties`);
    const copies = await this.children(token, monthId, input.name, `mimeType = '${GOOGLE_DOC}'`);
    const markerStored = !marker || (doc.appProperties?.tentionManaged === "true" && doc.appProperties.tentionClientId === marker.tentionClientId && doc.appProperties.tentionReportMonth === marker.tentionReportMonth);
    if (doc.name !== input.name || doc.mimeType !== GOOGLE_DOC || !doc.parents?.includes(monthId) || !doc.capabilities?.canEdit || !doc.version || copies.length !== 1 || !markerStored) {
      throw new DriveDeliveryError("GOOGLE_DOC_UNVERIFIED", "The Google Doc could not be verified after writing it.");
    }
    return { docId, folderId: monthId, webViewLink: doc.webViewLink ?? null, version: doc.version, modifiedTime: doc.modifiedTime ?? null, action, managedBy };
  }

  /** ROOT / <year> / <Month>, found or created deterministically from the report month. */
  private async monthFolder(token: string, year: number, month: number): Promise<string> {
    const root = await this.request<{ mimeType?: string; capabilities?: { canAddChildren?: boolean } }>(token,
      `${API}/files/${encodeURIComponent(this.config.rootFolderId)}?${ALL_DRIVES}&fields=mimeType,capabilities(canAddChildren)`);
    if (root.mimeType !== FOLDER || !root.capabilities?.canAddChildren) throw new DriveDeliveryError("DRIVE_ROOT_NOT_WRITABLE", "The configured Google Drive root folder is not a writable folder.");
    const yearId = await this.ensureFolder(token, this.config.rootFolderId, String(year));
    return this.ensureFolder(token, yearId, driveMonthFolderName(month));
  }

  private async ensureFolder(token: string, parentId: string, name: string): Promise<string> {
    const existing = await this.children(token, parentId, name, `mimeType = '${FOLDER}'`);
    if (existing.length > 1) throw new DriveDeliveryError("DRIVE_DUPLICATE_FOLDERS", `Drive holds ${existing.length} folders named "${name}" in the same place; resolve them before retrying.`);
    if (existing[0]) return existing[0].id;
    const created = await this.request<{ id: string }>(token, `${API}/files?${ALL_DRIVES}&fields=id`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name, mimeType: FOLDER, parents: [parentId] }) });
    return created.id;
  }

  private async children(token: string, parentId: string, name: string, typeClause: string): Promise<Array<{ id: string }>> {
    const q = `${quote(parentId)} in parents and name = ${quote(name)} and ${typeClause} and trashed = false`;
    const result = await this.request<{ files: Array<{ id: string }> }>(token, `${API}/files?${ALL_DRIVES}&includeItemsFromAllDrives=true&corpora=allDrives&fields=files(id)&q=${encodeURIComponent(q)}`);
    return result.files ?? [];
  }

  private async accessToken(): Promise<string> {
    const response = await this.fetchImpl("https://oauth2.googleapis.com/token", {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: this.config.clientId, client_secret: this.config.clientSecret, refresh_token: this.config.refreshToken, grant_type: "refresh_token" }),
    }).catch(() => { throw new DriveDeliveryError("DRIVE_UNREACHABLE", "Google could not be reached."); });
    const body = await response.json().catch(() => ({})) as { access_token?: string; error?: string };
    if (!response.ok || !body.access_token) throw new DriveDeliveryError("DRIVE_AUTH_FAILED", `Google Drive authorization failed (${body.error ?? response.status}).`);
    return body.access_token;
  }

  private async request<T = unknown>(token: string, url: string, init: RequestInit = {}): Promise<T> {
    const response = await this.fetchImpl(url, { ...init, headers: { ...(init.headers as Record<string, string> | undefined), authorization: `Bearer ${token}` } })
      .catch(() => { throw new DriveDeliveryError("DRIVE_UNREACHABLE", "Google Drive could not be reached."); });
    const body = await response.json().catch(() => ({})) as { error?: { message?: string } };
    if (!response.ok) throw new DriveDeliveryError("DRIVE_REQUEST_FAILED", `Google Drive request failed (${response.status}${body.error?.message ? `: ${body.error.message.slice(0, 160)}` : ""}).`);
    return body as T;
  }
}

const DRIVE_KEYS = ["GOOGLE_OAUTH_CLIENT_ID", "GOOGLE_OAUTH_CLIENT_SECRET", "GOOGLE_OAUTH_REFRESH_TOKEN", "GOOGLE_DRIVE_ROOT_FOLDER_ID"] as const;

/**
 * Drive delivery is enabled only when all four Google settings exist. They come from the process environment, or —
 * for local development — from the repository .env (only these four keys are read from it; nothing else changes).
 */
export function createConfiguredPdfDriveDelivery(environment: NodeJS.ProcessEnv, envFile?: string): GoogleDrivePdfDelivery | null {
  const fromFile: Record<string, string> = {};
  if (envFile && existsSync(envFile)) {
    for (const line of readFileSync(envFile, "utf8").split(/\r?\n/)) {
      const match = line.match(/^[ \t]*(?:export[ \t]+)?([A-Z0-9_]+)=(.*)$/);
      if (match && (DRIVE_KEYS as readonly string[]).includes(match[1]!)) fromFile[match[1]!] = match[2]!.trim().replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1");
    }
  }
  const value = (key: typeof DRIVE_KEYS[number]) => environment[key]?.trim() || fromFile[key] || "";
  if (DRIVE_KEYS.some((key) => !value(key))) return null;
  return new GoogleDrivePdfDelivery({ clientId: value("GOOGLE_OAUTH_CLIENT_ID"), clientSecret: value("GOOGLE_OAUTH_CLIENT_SECRET"), refreshToken: value("GOOGLE_OAUTH_REFRESH_TOKEN"), rootFolderId: value("GOOGLE_DRIVE_ROOT_FOLDER_ID") });
}

/** Delivers one canonical artifact and records the outcome on it. Never throws for a Drive failure. */
export async function deliverArtifactToDrive(
  repository: ReportDraftRepository, delivery: PdfDriveDelivery, draft: ReportDraft, artifact: ReportPdfArtifact, bytes: Buffer, now: () => Date,
): Promise<ReportPdfArtifact> {
  const fileName = driveFileName(draft);
  const attemptedAt = now().toISOString();
  let record: ReportPdfDriveDelivery;
  try {
    const result = await delivery.deliver({ year: draft.reportMonth.year, month: draft.reportMonth.month, fileName, bytes });
    record = { driveUploadStatus: "uploaded", driveFileName: fileName, driveFileId: result.fileId, driveFolderId: result.folderId, driveWebViewLink: result.webViewLink, driveUploadedAt: now().toISOString(), driveUploadAction: result.action, driveErrorCode: null, driveAttemptedAt: attemptedAt };
  } catch (error) {
    const code = error instanceof DriveDeliveryError ? error.code : "DRIVE_UPLOAD_FAILED";
    record = { driveUploadStatus: "failed", driveFileName: fileName, driveFileId: null, driveFolderId: null, driveWebViewLink: null, driveUploadedAt: null, driveUploadAction: null, driveErrorCode: code, driveAttemptedAt: attemptedAt };
  }
  return repository.saveArtifactDriveDelivery(draft.id, artifact.id, record);
}

/**
 * Writes the editable Google Doc for one canonical artifact (same approved report model as its PDF) and records the
 * outcome on that artifact. The last Doc Tention wrote for this report is the only one it updates without force.
 * Never throws for a Drive failure.
 */
export async function syncArtifactGoogleDoc(
  repository: ReportDraftRepository, sync: ReportGoogleDocSync, draft: ReportDraft, artifact: ReportPdfArtifact, html: string, now: () => Date, force = false, adoptDocId: string | null = null,
): Promise<ReportPdfArtifact> {
  const name = googleDocName(draft);
  const attemptedAt = now().toISOString();
  const previous = (await repository.listArtifacts(draft.id))
    .map(({ googleDoc }) => googleDoc)
    // A failed attempt keeps the last successfully written Doc identity and version, so either status carries it.
    .filter((doc): doc is ReportGoogleDoc => doc?.googleDocName === name && Boolean(doc.googleDocId && doc.googleDocVersion && doc.googleDocUpdatedAt))
    .sort((left, right) => right.googleDocUpdatedAt!.localeCompare(left.googleDocUpdatedAt!))[0];
  let record: ReportGoogleDoc;
  try {
    const result = await sync.syncGoogleDoc({ year: draft.reportMonth.year, month: draft.reportMonth.month, name, html, expected: previous ? { docId: previous.googleDocId!, version: previous.googleDocVersion!, modifiedTime: previous.googleDocModifiedTime ?? null, writtenAt: previous.googleDocUpdatedAt } : null, force, clientId: draft.client.id, adoptDocId });
    record = { googleDocStatus: "synced", googleDocName: name, googleDocId: result.docId, googleDocFolderId: result.folderId, googleDocWebViewLink: result.webViewLink, googleDocUpdatedAt: now().toISOString(), googleDocVersion: result.version, googleDocModifiedTime: result.modifiedTime, googleDocManagedBy: result.managedBy, googleDocCandidateId: null, googleDocCandidateWebViewLink: null, googleDocAction: result.action, googleDocErrorCode: null, googleDocAttemptedAt: attemptedAt };
  } catch (error) {
    const code = error instanceof DriveDeliveryError ? error.code : "GOOGLE_DOC_FAILED";
    const found = error instanceof DriveDeliveryError ? error.details : {};
    // A Doc found but not proven Tention's is never recorded as this report's Doc; it is offered to open and adopt.
    const candidate = code === "GOOGLE_DOC_NOT_TENTION_MANAGED" && found.docId ? { googleDocCandidateId: found.docId, googleDocCandidateWebViewLink: found.webViewLink ?? null } : {};
    record = { ...candidate, googleDocStatus: "failed", googleDocName: name, // A Tention Doc refused only because a person edited it is still this report's Doc: keep it openable.
      googleDocId: previous?.googleDocId ?? (code === "GOOGLE_DOC_EDITED_IN_DRIVE" ? found.docId ?? null : null), googleDocFolderId: previous?.googleDocFolderId ?? found.folderId ?? null,
      googleDocWebViewLink: previous?.googleDocWebViewLink ?? (code === "GOOGLE_DOC_EDITED_IN_DRIVE" ? found.webViewLink ?? null : null), googleDocUpdatedAt: previous?.googleDocUpdatedAt ?? null, googleDocVersion: previous?.googleDocVersion ?? null, googleDocModifiedTime: previous?.googleDocModifiedTime ?? null, googleDocAction: null, googleDocErrorCode: code, googleDocAttemptedAt: attemptedAt };
  }
  return repository.saveArtifactGoogleDoc(draft.id, artifact.id, record);
}
