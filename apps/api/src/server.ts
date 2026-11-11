import { buildApp } from "./app.js";
import { createConfiguredClientReportTargetsRepository, createConfiguredRepository } from "./db/configured-repository.js";
import { createConfiguredScreenshotStorage } from "./storage/configured-storage.js";
import { createConfiguredPdfArtifactStorage } from "./storage/configured-pdf-artifact-storage.js";
import { PlaywrightPdfRenderer } from "./reports/pdf-renderer.js";
import { createConfiguredPdfDriveDelivery } from "./delivery/google-drive-delivery.js";
import { isLoopbackHost, loadLocalEnvironment, resolveServerPort } from "./server-config.js";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
// Local development reads the repository .env; variables already set in the environment always take precedence.
loadLocalEnvironment(resolve(repositoryRoot, ".env"));
const port = resolveServerPort(process.env.PORT);
const host = process.env.HOST ?? "127.0.0.1";

try {
  const repository = createConfiguredRepository(process.env);
  const clientReportTargetsRepository = createConfiguredClientReportTargetsRepository(process.env);
  const screenshotStorage = createConfiguredScreenshotStorage(process.env);
  const pdfArtifactStorage = createConfiguredPdfArtifactStorage(process.env);
  const allowedOrigins = process.env.EXTENSION_ORIGIN ? [process.env.EXTENSION_ORIGIN] : [];
  const pdfDriveDelivery = createConfiguredPdfDriveDelivery(process.env, resolve(repositoryRoot, ".env"));
  await buildApp({ logger: true, repository, clientReportTargetsRepository, screenshotStorage, pdfArtifactStorage, pdfRenderer: new PlaywrightPdfRenderer(process.env.REPORT_PDF_BROWSER_EXECUTABLE_PATH ? { executablePath: process.env.REPORT_PDF_BROWSER_EXECUTABLE_PATH } : {}), pdfDriveDelivery, googleDocSync: pdfDriveDelivery, allowedOrigins, enableLocalDevelopmentImports: process.env.NODE_ENV !== "production" && isLoopbackHost(host), localImportRequiresPersistentStorage: Boolean(process.env.DATABASE_URL) && process.env.REPORT_STORAGE_MODE !== "memory", repositoryRoot }).listen({ port, host });
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
