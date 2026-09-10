import { useEffect, useRef, useState } from "react";
import type { ApiClient } from "@tention/api-client";
import type { ReportDraft, ScreenshotType } from "@tention/report-schema";
import { formatCalendarRange } from "../../lib/dates/month-options.js";
import type { CaptureService, ActiveCaptureTab, CapturedImage } from "./capture-service.js";
import { mapDisplayedCropToImage, selectionFromDrag, type CropRectangle } from "./crop-geometry.js";

interface CaptureWorkflowProps {
  api: ApiClient;
  captureService: CaptureService;
  report: ReportDraft;
  screenshotType: ScreenshotType;
  label: string;
  onComplete(report: ReportDraft): void;
  onVersionConflict(): void;
  onCancel(): void;
}

type Stage = "instructions" | "crop" | "review";

export function CaptureWorkflow({ api, captureService, report, screenshotType, label, onComplete, onVersionConflict, onCancel }: CaptureWorkflowProps) {
  const [stage, setStage] = useState<Stage>("instructions");
  const [activeTab, setActiveTab] = useState<ActiveCaptureTab | null>(null);
  const [captured, setCaptured] = useState<CapturedImage | null>(null);
  const [selection, setSelection] = useState<CropRectangle | null>(null);
  const [displaySize, setDisplaySize] = useState<{ width: number; height: number } | null>(null);
  const [naturalSize, setNaturalSize] = useState<{ width: number; height: number } | null>(null);
  const [croppedImage, setCroppedImage] = useState<Blob | null>(null);
  const [croppedSize, setCroppedSize] = useState<CropRectangle | null>(null);
  const [periodConfirmed, setPeriodConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dragStart = useRef<{ x: number; y: number } | null>(null);
  const previewUrl = useObjectUrl(croppedImage);
  const period = formatCalendarRange(report.period.startDate, report.period.endDate);

  async function requestCapture() {
    setBusy(true); setError(null);
    try {
      const active = await captureService.getActiveTab();
      if (!active.isKlaviyo) { setActiveTab(active); return; }
      await capture();
    } catch (caught) { setError(message(caught, "The current tab could not be inspected.")); }
    finally { setBusy(false); }
  }

  async function capture() {
    setBusy(true); setError(null);
    try {
      const image = await captureService.captureVisibleTab();
      setCaptured(image); setSelection(null); setCroppedImage(null); setCroppedSize(null); setPeriodConfirmed(false); setStage("crop");
    } catch (caught) { setError(message(caught, "The current tab could not be captured.")); }
    finally { setBusy(false); }
  }

  function beginSelection(event: React.PointerEvent<HTMLDivElement>) {
    if (!displaySize) return;
    const point = pointInImage(event);
    dragStart.current = point;
    event.currentTarget.setPointerCapture(event.pointerId);
    setSelection(null);
  }
  function moveSelection(event: React.PointerEvent<HTMLDivElement>) {
    if (!dragStart.current || !displaySize) return;
    const point = pointInImage(event);
    setSelection(selectionFromDrag(dragStart.current.x, dragStart.current.y, point.x, point.y, displaySize.width, displaySize.height, 24));
  }
  function endSelection(event: React.PointerEvent<HTMLDivElement>) {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    dragStart.current = null;
  }
  function pointInImage(event: React.PointerEvent<HTMLDivElement>) {
    const bounds = event.currentTarget.getBoundingClientRect();
    return { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
  }

  async function continueToReview() {
    if (!captured || !selection || !displaySize || !naturalSize) return;
    setBusy(true); setError(null);
    try {
      const naturalCrop = mapDisplayedCropToImage(selection, displaySize.width, displaySize.height, naturalSize.width, naturalSize.height);
      setCroppedImage(await cropToPng(captured.dataUrl, naturalCrop));
      setCroppedSize(naturalCrop); setStage("review");
    } catch (caught) { setError(message(caught, "The screenshot crop could not be created.")); }
    finally { setBusy(false); }
  }

  async function approveAndUpload() {
    if (!croppedImage || !captured || !periodConfirmed) return;
    setBusy(true); setError(null);
    try {
      const updated = await api.uploadScreenshotImage(report.id, screenshotType, {
        expectedVersion: report.version, periodConfirmed: true,
        sourceUrl: captured.sourceUrl,
        image: croppedImage,
      });
      onComplete(updated);
    } catch (caught) {
      if (isVersionConflict(caught)) onVersionConflict();
      else setError(message(caught, "The approved screenshot could not be uploaded."));
    } finally { setBusy(false); }
  }

  function retake() {
    setStage("instructions"); setCaptured(null); setSelection(null); setCroppedImage(null); setCroppedSize(null); setPeriodConfirmed(false); setActiveTab(null); setError(null);
  }

  if (stage === "instructions") return <main className="capture-workflow">
    <section className="card report-hero"><p className="kicker">Capture {label}</p><h1>{report.client.name}</h1><p className="report-month">Expected report period: {period}</p></section>
    <section className="card"><h2>Open the correct Klaviyo screen</h2><p className="support-copy">The extension captures only the currently visible tab. It does not navigate or read Klaviyo data.</p>
      {activeTab && <div className="notice warning-notice"><p>This capture is intended for a Klaviyo page.</p><small>Current tab: {hostLabel(activeTab.sourceUrl)}</small><button disabled={busy} onClick={() => void capture()}>Capture anyway</button></div>}
      {error && <p role="alert" className="notice error-notice">{error}</p>}
      <div className="actions"><button className="primary" disabled={busy} onClick={() => void requestCapture()}>{busy ? "Checking…" : "Capture Current Tab"}</button><button onClick={onCancel}>Cancel</button></div>
    </section>
  </main>;

  if (stage === "crop" && captured) return <main className="capture-workflow">
    <section className="card"><p className="kicker">Crop screenshot</p><h1>{label}</h1><p className="support-copy">Drag across the exact Klaviyo card, chart, or table. Crop coordinates are mapped to the full PNG resolution.</p>
      <div className="crop-image" onPointerDown={beginSelection} onPointerMove={moveSelection} onPointerUp={endSelection} onPointerCancel={endSelection}>
        <img src={captured.dataUrl} alt="Captured browser tab" draggable={false} onLoad={(event) => {
          const image = event.currentTarget; const bounds = image.getBoundingClientRect();
          setDisplaySize({ width: bounds.width, height: bounds.height }); setNaturalSize({ width: image.naturalWidth, height: image.naturalHeight });
        }} />
        {selection && <span className="crop-selection" style={{ left: selection.x, top: selection.y, width: selection.width, height: selection.height }} />}
      </div>
      {error && <p role="alert" className="notice error-notice">{error}</p>}
      <div className="actions"><button onClick={() => setSelection(null)}>Reset</button><button onClick={retake}>Cancel</button><button className="primary" disabled={busy || !selection} onClick={() => void continueToReview()}>{busy ? "Cropping…" : "Continue"}</button></div>
    </section>
  </main>;

  return <main className="capture-workflow">
    <section className="card"><p className="kicker">Review screenshot</p><h1>{label}</h1><p className="support-copy">{report.client.name} · {period}</p>
      {previewUrl && <img className="crop-preview" src={previewUrl} alt={`Cropped ${label} screenshot`} />}
      <dl className="capture-details"><div><dt>Source</dt><dd>{hostLabel(captured?.sourceUrl ?? null)}</dd></div><div><dt>Dimensions</dt><dd>{croppedSize ? `${croppedSize.width} × ${croppedSize.height} PNG` : "—"}</dd></div><div><dt>Reporting Period</dt><dd>{period}</dd></div></dl>
      <label className="confirmation"><input type="checkbox" checked={periodConfirmed} onChange={(event) => setPeriodConfirmed(event.target.checked)} />I confirm this screenshot shows the selected report period.</label>
      <p className="support-copy">This is a human audit control; the extension does not verify dates from screenshot pixels.</p>
      {error && <p role="alert" className="notice error-notice">{error}</p>}
      <div className="actions"><button onClick={retake}>Retake</button><button className="primary" disabled={busy || !periodConfirmed} onClick={() => void approveAndUpload()}>{busy ? "Uploading…" : "Approve & Upload"}</button></div>
    </section>
  </main>;
}

async function cropToPng(dataUrl: string, crop: CropRectangle): Promise<Blob> {
  const image = await loadImage(dataUrl);
  const canvas = document.createElement("canvas");
  canvas.width = crop.width; canvas.height = crop.height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Canvas is unavailable.");
  context.drawImage(image, crop.x, crop.y, crop.width, crop.height, 0, 0, crop.width, crop.height);
  return new Promise((resolve, reject) => canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("PNG encoding failed.")), "image/png"));
}

function loadImage(source: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => { const image = new Image(); image.onload = () => resolve(image); image.onerror = () => reject(new Error("Screenshot image could not load.")); image.src = source; });
}
function useObjectUrl(blob: Blob | null): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => { if (!blob) { setUrl(null); return; } const value = URL.createObjectURL(blob); setUrl(value); return () => URL.revokeObjectURL(value); }, [blob]);
  return url;
}
function hostLabel(value: string | null): string { try { return value ? new URL(value).hostname : "Unavailable"; } catch { return "Unavailable"; } }
function isVersionConflict(error: unknown): error is { code: string } { return typeof error === "object" && error !== null && "code" in error && error.code === "REPORT_VERSION_CONFLICT"; }
function message(error: unknown, fallback: string): string { return error instanceof Error && error.message ? error.message : fallback; }
