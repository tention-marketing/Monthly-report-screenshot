export interface CropRectangle { x: number; y: number; width: number; height: number }

export function selectionFromDrag(startX: number, startY: number, endX: number, endY: number, displayWidth: number, displayHeight: number, minimum = 24): CropRectangle | null {
  const left = clamp(Math.min(startX, endX), 0, displayWidth);
  const top = clamp(Math.min(startY, endY), 0, displayHeight);
  const right = clamp(Math.max(startX, endX), 0, displayWidth);
  const bottom = clamp(Math.max(startY, endY), 0, displayHeight);
  if (right - left < minimum || bottom - top < minimum) return null;
  return { x: left, y: top, width: right - left, height: bottom - top };
}

/** Maps the displayed crop rectangle to natural PNG pixels; CSS pixels are never assumed to be image pixels. */
export function mapDisplayedCropToImage(selection: CropRectangle, displayWidth: number, displayHeight: number, naturalWidth: number, naturalHeight: number): CropRectangle {
  if (displayWidth <= 0 || displayHeight <= 0 || naturalWidth <= 0 || naturalHeight <= 0) throw new Error("Image dimensions must be positive.");
  const scaleX = naturalWidth / displayWidth;
  const scaleY = naturalHeight / displayHeight;
  const left = clamp(Math.floor(selection.x * scaleX), 0, naturalWidth - 1);
  const top = clamp(Math.floor(selection.y * scaleY), 0, naturalHeight - 1);
  const right = clamp(Math.ceil((selection.x + selection.width) * scaleX), left + 1, naturalWidth);
  const bottom = clamp(Math.ceil((selection.y + selection.height) * scaleY), top + 1, naturalHeight);
  return { x: left, y: top, width: right - left, height: bottom - top };
}

function clamp(value: number, lower: number, upper: number): number { return Math.min(Math.max(value, lower), upper); }
