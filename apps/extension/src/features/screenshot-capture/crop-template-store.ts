import type { ScreenshotType } from "@tention/report-schema";
import type { CropRectangle } from "./crop-geometry.js";

export interface NormalizedCropRectangle { xPct: number; yPct: number; widthPct: number; heightPct: number }
export interface CropTemplateStore { get(type: ScreenshotType): NormalizedCropRectangle | null; save(type: ScreenshotType, value: NormalizedCropRectangle): void }

export function normalizeCrop(selection: CropRectangle, width: number, height: number): NormalizedCropRectangle {
  if (width <= 0 || height <= 0) throw new Error("Image dimensions must be positive.");
  return validateNormalizedCrop({ xPct: selection.x / width, yPct: selection.y / height, widthPct: selection.width / width, heightPct: selection.height / height });
}

export function denormalizeCrop(value: NormalizedCropRectangle, width: number, height: number): CropRectangle {
  const crop = validateNormalizedCrop(value);
  return { x: Math.round(crop.xPct * width), y: Math.round(crop.yPct * height), width: Math.round(crop.widthPct * width), height: Math.round(crop.heightPct * height) };
}

export function validateNormalizedCrop(value: NormalizedCropRectangle): NormalizedCropRectangle {
  const xPct = clamp(value.xPct); const yPct = clamp(value.yPct);
  const widthPct = clamp(value.widthPct, 0, 1 - xPct); const heightPct = clamp(value.heightPct, 0, 1 - yPct);
  if (widthPct <= 0 || heightPct <= 0) throw new Error("Crop template must have a positive size.");
  return { xPct, yPct, widthPct, heightPct };
}

export function createSessionCropTemplateStore(storage: Storage | undefined = globalThis.sessionStorage): CropTemplateStore {
  const key = (type: ScreenshotType) => `tention.crop-template.${type}`;
  return {
    get(type) {
      try { const raw = storage?.getItem(key(type)); return raw ? validateNormalizedCrop(JSON.parse(raw) as NormalizedCropRectangle) : null; }
      catch { return null; }
    },
    save(type, value) { try { storage?.setItem(key(type), JSON.stringify(validateNormalizedCrop(value))); } catch { /* Session storage is an optional convenience. */ } },
  };
}

function clamp(value: number, lower = 0, upper = 1): number { return Math.min(Math.max(value, lower), upper); }
