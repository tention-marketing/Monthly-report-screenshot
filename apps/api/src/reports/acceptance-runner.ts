import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createScreenshotSourceProof, screenshotSectionMapping, type ScreenshotType } from "@tention/report-schema";
import { InMemoryClientReportTargetsRepository } from "@tention/report-domain";
import { buildApp } from "../app.js";
import { LocalFilesystemPdfArtifactStorage } from "../storage/pdf-artifact-storage.js";
import { LocalFilesystemScreenshotStorage } from "../storage/screenshot-storage.js";
import { PlaywrightPdfRenderer } from "./pdf-renderer.js";
import { rasterizePdfForQa, type PdfPageQaResult } from "./pdf-page-qa.js";

const NOW = new Date("2026-09-09T12:00:00Z");
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const OUTPUT_DIRECTORY = resolve(repositoryRoot, process.env.REPORT_ACCEPTANCE_OUTPUT_DIR ?? "output/synthetic-acceptance");
const PDF_OUTPUT = resolve(OUTPUT_DIRECTORY, "tention-pdf-acceptance-fixture.pdf");
const DIAGNOSTICS_OUTPUT = resolve(OUTPUT_DIRECTORY, "tention-pdf-acceptance-diagnostics.json");
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9J5c0AAAAASUVORK5CYII=", "base64");
const screenshotTypes = ["overview", "top_campaigns", "top_flows", "month_comparison", "campaign_performance", "flow_performance", "signup_form", "welcome_flow", "customer_split", "deliverability", "campaign_metrics", "flow_metrics"] as const satisfies readonly ScreenshotType[];
function acceptanceProof(type: ScreenshotType, period: Parameters<typeof createScreenshotSourceProof>[1]) {
  return createScreenshotSourceProof(type, period, type === "signup_form" ? { scope: "all_forms" }
    : type === "welcome_flow" ? { scope: "email_welcome_flows", entities: [{ id: "fixture-email-1", name: "Fixture Email Welcome 1", channel: "email" }, { id: "fixture-email-2", name: "Fixture Email Welcome 2", channel: "email" }] } : undefined);
}

interface AcceptanceDiagnostics {
  kind: "synthetic_acceptance_fixture";
  generatedAt: string;
  reportMonth: string;
  checks: Record<string, boolean>;
  generatedPdf: { path: string; byteSize: number; sha256: string; templateVersion: string; pageCountEstimate: number; pageQa: PdfPageQaResult };
  limitations: readonly string[];
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Acceptance assertion failed: ${message}`);
}

async function main(): Promise<void> {
  await mkdir(OUTPUT_DIRECTORY, { recursive: true });
  const renderer = new PlaywrightPdfRenderer();
  const clientTargets = new InMemoryClientReportTargetsRepository();
  await clientTargets.save("acceptance-fixture", {
    profile: null, businessReview: null, sourceUrls: null, primaryEmailList: null, primarySmsList: null, welcomeFlow: null,
    welcomeFlowListing: { mode: "email_welcome_flows", flows: [{ id: "fixture-email-1", name: "Fixture Email Welcome 1", channel: "email" }, { id: "fixture-email-2", name: "Fixture Email Welcome 2", channel: "email" }] },
    customerSegment: null, nonCustomerSegment: null, signupForms: { mode: "all", ids: [], names: [] },
  }, NOW);
  const app = buildApp({ requireClientSetupReady: false,
    now: () => new Date(NOW),
    screenshotStorage: new LocalFilesystemScreenshotStorage(resolve(OUTPUT_DIRECTORY, "screenshots")),
    pdfArtifactStorage: new LocalFilesystemPdfArtifactStorage(resolve(OUTPUT_DIRECTORY, "artifacts")),
    pdfRenderer: renderer,
    clientReportTargetsRepository: clientTargets,
  });

  try {
    const incomplete = await app.inject({
      method: "POST", url: "/api/v1/report-drafts",
      payload: { client: { id: "acceptance-incomplete", name: "Acceptance Incomplete", timezone: "Asia/Kolkata" }, reportMonth: { year: 2026, month: 9 }, sections: {} },
    });
    assert(incomplete.statusCode === 400 && incomplete.json().error === "REPORT_MONTH_INCOMPLETE", "incomplete report months are rejected");

    const created = await app.inject({
      method: "POST", url: "/api/v1/report-drafts",
      payload: {
        client: { id: "acceptance-fixture", name: "Acceptance Fixture - Not Client Data", timezone: "America/New_York" },
        reportMonth: { year: 2026, month: 8 },
        sections: Object.fromEntries(screenshotTypes.map((type) => [screenshotSectionMapping[type], "required"])),
      },
    });
    assert(created.statusCode === 201, "completed-month draft is created");
    let draft = created.json();
    assert(draft.period.startDate === "2026-08-01" && draft.period.endDate === "2026-08-31" && draft.period.previousStartDate === "2026-07-01" && draft.period.previousEndDate === "2026-07-31", "server derives exact calendar periods");

    for (const type of screenshotTypes) {
      const response = await app.inject({
        method: "PUT", url: `/api/v1/report-drafts/${draft.id}/screenshots/${type}/image`,
        payload: Buffer.concat([PNG, Buffer.from(`acceptance-${type}`)]),
        headers: {
          "content-type": "image/png",
          "x-expected-version": String(draft.version),
          "x-period-confirmed": "true",
          "x-source-url": type === "deliverability" ? "https://www.klaviyo.com/analytics/deliverability/email/score" : "https://www.klaviyo.com/dashboard",
          "x-capture-proof": JSON.stringify(acceptanceProof(type, draft.period)),
        },
      });
      assert(response.statusCode === 200, `${type} capture is accepted with matching source proof`);
      const acknowledgement = response.json();
      assert(acknowledgement.reportId === draft.id && acknowledgement.screenshotType === type
        && acknowledgement.approvalStatus === "approved" && acknowledgement.sourceProofAccepted === true
        && /^[a-f0-9]{64}$/.test(acknowledgement.sha256), `${type} upload returns a storage and source-proof acknowledgement`);
      const acknowledgedRecord = acknowledgement.report.screenshots.find(({ type: savedType }: { type: ScreenshotType }) => savedType === type);
      assert(acknowledgedRecord?.id === acknowledgement.screenshotRecordId && acknowledgedRecord.sha256 === acknowledgement.sha256
        && acknowledgedRecord.approved, `${type} acknowledgement identifies the saved approved screenshot record`);
      const canonical = await app.inject({ method: "GET", url: `/api/v1/report-drafts/${draft.id}` });
      assert(canonical.statusCode === 200, `${type} report draft reload succeeds after upload`);
      draft = canonical.json();
      assert(draft.screenshots.some(({ id, type: savedType, sha256 }: { id: string; type: ScreenshotType; sha256: string }) => id === acknowledgement.screenshotRecordId && savedType === type && sha256 === acknowledgement.sha256), `${type} screenshot remains present after canonical reload`);
    }

    for (const event of ["START_DATA_FETCH", "DATA_FETCH_SUCCEEDED", "SUBMIT_FOR_REVIEW"] as const) {
      const response = await app.inject({ method: "POST", url: `/api/v1/report-drafts/${draft.id}/events`, payload: { event, expectedVersion: draft.version } });
      assert(response.statusCode === 200, `${event} is accepted`);
      draft = response.json();
    }
    assert(draft.status === "ready_for_review", "validated captures reach review");

    const preview = await app.inject({ method: "GET", url: `/api/v1/report-drafts/${draft.id}/preview` });
    assert(preview.statusCode === 200 && preview.body.includes('data-report-layout="tention-monthly-v1"'), "preview is generated from the canonical layout");

    const generated = await app.inject({ method: "POST", url: `/api/v1/report-drafts/${draft.id}/generate`, payload: { expectedVersion: draft.version } });
    assert(generated.statusCode === 200 && generated.json().report.status === "generated", "real PDF generation reaches generated state");
    const artifact = generated.json().artifact;
    const pdf = await app.inject({ method: "GET", url: `/api/v1/report-drafts/${draft.id}/pdf?download=1` });
    assert(pdf.statusCode === 200 && pdf.rawPayload.subarray(0, 5).toString("ascii") === "%PDF-", "generated artifact is downloadable PDF bytes");
    await writeFile(PDF_OUTPUT, pdf.rawPayload);
    const pageQa = await rasterizePdfForQa(PDF_OUTPUT, OUTPUT_DIRECTORY);
    assert(pageQa.pageCount > 0 && pageQa.blankPages.length === 0, "every physical PDF page renders with visible content");

    const replacement = await app.inject({
      method: "PUT", url: `/api/v1/report-drafts/${draft.id}/screenshots/overview/image`,
      payload: Buffer.concat([PNG, Buffer.from("acceptance-overview-replacement")]),
      headers: {
        "content-type": "image/png",
        "x-expected-version": String(generated.json().report.version),
        "x-period-confirmed": "true",
        "x-source-url": "https://www.klaviyo.com/dashboard",
        "x-capture-proof": JSON.stringify(createScreenshotSourceProof("overview", draft.period)),
      },
    });
    assert(replacement.statusCode === 200 && replacement.json().report.status === "captures_incomplete", "required replacement invalidates capture review");
    const stale = await app.inject({ method: "GET", url: `/api/v1/report-drafts/${draft.id}/pdf-artifact` });
    assert(stale.statusCode === 404 && stale.json().error === "PDF_ARTIFACT_STALE", "replaced evidence makes the prior artifact stale");

    const diagnostics: AcceptanceDiagnostics = {
      kind: "synthetic_acceptance_fixture",
      generatedAt: new Date().toISOString(),
      reportMonth: "2026-08",
      checks: {
        completedMonthGate: true,
        exactCalendarPeriod: true,
        sourceProofBoundCaptures: true,
        captureReview: true,
        canonicalHtmlPreview: true,
        realPlaywrightPdf: true,
        pdfDownload: true,
        pdfPagesRendered: true,
        pdfContactSheet: true,
        staleArtifactAfterReplacement: true,
      },
      generatedPdf: {
        path: PDF_OUTPUT,
        byteSize: artifact.byteSize,
        sha256: artifact.sha256,
        templateVersion: artifact.templateVersion,
        pageCountEstimate: (pdf.rawPayload.toString("latin1").match(/\/Type\s*\/Page\b/g) ?? []).length,
        pageQa,
      },
      limitations: [
        "This is a synthetic acceptance fixture, not a client report and not numeric-data verification.",
        "The fixture uses approved one-pixel PNG evidence to exercise storage and layout wiring only.",
        "Live Chrome/Klaviyo capture, production PostgreSQL, and provider/API metric reconciliation are outside this runner.",
        "The saved PDF predates the intentional replacement that proves artifact staleness; do not distribute it as a current report.",
      ],
    };
    await writeFile(DIAGNOSTICS_OUTPUT, `${JSON.stringify(diagnostics, null, 2)}\n`);
    console.log(JSON.stringify(diagnostics, null, 2));
  } finally {
    await app.close();
    await renderer.close();
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
