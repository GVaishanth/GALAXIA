/**
 * Item icons as images (Free Roam Prompt 10). DOM only: the 12x12 grids and
 * colours live in inventory/icons.ts (original art, data only); this module
 * rasterises them once per scale into small canvases (drawn in the sector
 * with smoothing off) and data URLs (shown in panels with
 * `image-rendering: pixelated`). Bounded caches; no external images.
 */
import type { ResourceId } from '../../catalogue/types.ts';
import type { SlotType } from '../../ships/types.ts';
import { ICON_SIZE, MODULE_ICONS, RESOURCE_ICONS, type IconArt } from '../icons.ts';
import { RESOURCES } from '../resources.ts';

const canvases = new Map<string, HTMLCanvasElement>();
const urls = new Map<string, string>();
/** Scales are small integers; ids are a fixed set: the caches stay tiny. */
const MAX_CACHED = 128;

function paint(art: IconArt, scale: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = ICON_SIZE * scale;
  c.height = ICON_SIZE * scale;
  const g = c.getContext('2d');
  if (!g) return c;
  for (let y = 0; y < ICON_SIZE; y++) {
    const row = art.grid[y] ?? '';
    for (let x = 0; x < ICON_SIZE; x++) {
      const ch = row[x];
      if (ch !== 'a' && ch !== 'b' && ch !== 'c' && ch !== 'd') continue;
      g.fillStyle = art.colors[ch];
      g.fillRect(x * scale, y * scale, scale, scale);
    }
  }
  return c;
}

function artOf(key: string): IconArt | undefined {
  if (key.startsWith('slot:')) return MODULE_ICONS[key.slice(5) as SlotType];
  return RESOURCE_ICONS[key as ResourceId];
}

/** The icon of a resource id (or `slot:<type>` for a module) rasterised at an integer scale. */
export function iconCanvas(key: string, scale: number): HTMLCanvasElement | null {
  const s = Math.max(1, Math.min(8, Math.round(scale)));
  const id = `${key}@${s}`;
  const hit = canvases.get(id);
  if (hit) return hit;
  const art = artOf(key);
  if (!art) return null;
  if (canvases.size >= MAX_CACHED) canvases.clear();
  const c = paint(art, s);
  canvases.set(id, c);
  return c;
}

/** Data URL of an icon (4x: 48 px, crisp when scaled with `image-rendering: pixelated`). */
export function iconUrl(key: string): string {
  const hit = urls.get(key);
  if (hit !== undefined) return hit;
  const c = iconCanvas(key, 4);
  let url = '';
  try {
    url = c ? c.toDataURL('image/png') : '';
  } catch {
    url = '';
  }
  urls.set(key, url);
  return url;
}

/** An <img> for an icon; decorative by default (the row text names the item). */
export function iconImg(key: string, className = 'fr-icon', alt = ''): HTMLImageElement {
  const img = document.createElement('img');
  img.className = className;
  img.width = 24;
  img.height = 24;
  img.alt = alt;
  img.decoding = 'async';
  img.draggable = false;
  const url = iconUrl(key);
  if (url) img.src = url;
  else img.hidden = true;
  return img;
}

/** The key whose icon represents a find: its most valuable resource. */
export function lootIconKey(loot: readonly { readonly resource: string; readonly amount: number }[]): string {
  let best = '';
  let v = -1;
  for (const e of loot) {
    const d = RESOURCES[e.resource as ResourceId];
    if (d && d.value > v) {
      v = d.value;
      best = e.resource;
    }
  }
  return best || 'scrap';
}
