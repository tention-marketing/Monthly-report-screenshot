import { mkdir, readdir, readFile, unlink, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { createCanvas, type Canvas } from "@napi-rs/canvas";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

export interface RenderedPdfPage {
  pageNumber: number;
  file: string;
  width: number;
  height: number;
  visibleInkSamples: number;
}

export interface PdfPageQaResult {
  pageCount: number;
  pages: RenderedPdfPage[];
  contactSheet: string;
  blankPages: number[];
}

/**
 * A deliberately conservative blank-page signal. A page is considered blank
 * only when its raster contains no visible non-white sample at all; pages with
 * merely a header, footer, or small visual are retained for human review.
 */
export function countVisibleInkSamples(pixels: Uint8ClampedArray, stride = 4): number {
  let count = 0;
  for (let offset = 0; offset < pixels.length; offset += stride * 4) {
    const [red, green, blue, alpha] = [pixels[offset]!, pixels[offset + 1]!, pixels[offset + 2]!, pixels[offset + 3]!];
    if (alpha > 0 && (red < 250 || green < 250 || blue < 250)) count += 1;
  }
  return count;
}

/** Remove only renderer-owned page rasters beyond the current PDF's page count. */
export async function pruneStalePdfPageRasters(pagesDirectory: string, pageCount: number): Promise<void> {
  for (const file of await readdir(pagesDirectory)) {
    const match = /^page-(\d+)\.png$/.exec(file);
    if (match && Number(match[1]) > pageCount) await unlink(join(pagesDirectory, file));
  }
}

function createRasterCanvas(width: number, height: number): Canvas {
  return createCanvas(width, height) as Canvas;
}

/** Renders every PDF page with PDF.js and writes inspectable PNG diagnostics. */
export async function rasterizePdfForQa(pdfPath: string, outputDirectory: string): Promise<PdfPageQaResult> {
  const bytes = await readFile(pdfPath);
  if (bytes.subarray(0, 5).toString("ascii") !== "%PDF-") throw new Error("PDF page QA requires valid PDF bytes.");
  const pagesDirectory = join(outputDirectory, "pdf-pages");
  await mkdir(pagesDirectory, { recursive: true });
  const loadingTask = getDocument({ data: new Uint8Array(bytes) });
  try {
    const document = await loadingTask.promise;
    if (document.numPages < 1) throw new Error("PDF page QA requires at least one physical page.");
    await pruneStalePdfPageRasters(pagesDirectory, document.numPages);
    const rendered: Array<RenderedPdfPage & { canvas: Canvas }> = [];
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const viewport = page.getViewport({ scale: 1.5 });
      const canvas = createRasterCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
      const context = canvas.getContext("2d");
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvas: canvas as unknown as HTMLCanvasElement, canvasContext: context as unknown as CanvasRenderingContext2D, viewport }).promise;
      const file = `page-${String(pageNumber).padStart(2, "0")}.png`;
      await writeFile(join(pagesDirectory, file), canvas.toBuffer("image/png"));
      rendered.push({ pageNumber, file: join("pdf-pages", file), width: canvas.width, height: canvas.height, visibleInkSamples: countVisibleInkSamples(context.getImageData(0, 0, canvas.width, canvas.height).data), canvas });
    }
    const maximumAspectRatio = Math.max(...rendered.map((page) => page.height / page.width));
    const cellWidth = 360;
    const labelHeight = 28;
    const cellHeight = Math.ceil(cellWidth * maximumAspectRatio) + labelHeight;
    const columns = 2;
    const rows = Math.ceil(rendered.length / columns);
    const sheet = createRasterCanvas(cellWidth * columns, cellHeight * rows);
    const sheetContext = sheet.getContext("2d");
    sheetContext.fillStyle = "#ffffff";
    sheetContext.fillRect(0, 0, sheet.width, sheet.height);
    rendered.forEach((page, index) => {
      const column = index % columns;
      const row = Math.floor(index / columns);
      const x = column * cellWidth;
      const y = row * cellHeight;
      const scale = Math.min(cellWidth / page.width, (cellHeight - labelHeight) / page.height);
      const width = Math.round(page.width * scale);
      const height = Math.round(page.height * scale);
      sheetContext.drawImage(page.canvas, x + Math.floor((cellWidth - width) / 2), y, width, height);
      sheetContext.fillStyle = "#232426";
      sheetContext.font = "14px sans-serif";
      sheetContext.fillText(`Page ${page.pageNumber}`, x + 8, y + cellHeight - 9);
    });
    const contactSheet = join(outputDirectory, "contact-sheet.png");
    await writeFile(contactSheet, sheet.toBuffer("image/png"));
    const pages = rendered.map(({ canvas: _canvas, ...page }) => page);
    return { pageCount: pages.length, pages, contactSheet: basename(contactSheet), blankPages: pages.filter((page) => page.visibleInkSamples === 0).map((page) => page.pageNumber) };
  } finally {
    await loadingTask.destroy().catch(() => undefined);
  }
}
