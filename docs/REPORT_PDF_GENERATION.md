# Report preview and PDF generation

The API builds one deterministic `ReportDocumentModel` from report metadata and approved, period-confirmed screenshot assets. The same server-rendered HTML template powers the full-tab preview and the Playwright PDF renderer. The renderer embeds only locally retrieved screenshot bytes as data URLs; it never fetches provider URLs.

`generated` now means a persisted `application/pdf` artifact exists for the exact report source fingerprint. The generation endpoint, rather than the generic lifecycle endpoint, owns `START_GENERATION`, `GENERATION_SUCCEEDED`, and `GENERATION_FAILED`.

Local development uses `REPORT_ARTIFACT_STORAGE_DIR` (default: `data/report-artifacts`) for PDFs and `SCREENSHOT_STORAGE_DIR` (default: `data/screenshots`) for approved PNGs. Set `REPORT_PDF_BROWSER_EXECUTABLE_PATH` only when Chromium is installed outside Playwright's managed browser cache.

Railway must install a compatible Chromium runtime during its build image creation. With Playwright, use `npx playwright install --with-deps chromium` in the Docker/image build step, or provide a compatible installed executable through `REPORT_PDF_BROWSER_EXECUTABLE_PATH`. Do not run browser installation at request time. The service account must have read access to the browser and write access to both configured storage directories.
