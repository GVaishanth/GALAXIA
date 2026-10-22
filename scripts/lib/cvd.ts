/**
 * Colour-vision-deficiency simulation (Machado, Oliveira & Fernandes 2009,
 * severity 1.0), applied in linear-light sRGB. Used for art review only.
 */
export type Deficiency = 'protanopia' | 'deuteranopia' | 'tritanopia';

const MATRICES: Record<Deficiency, readonly number[]> = {
  protanopia: [0.152286, 1.052583, -0.204868, 0.114503, 0.786281, 0.099216, -0.003882, -0.048116, 1.051998],
  deuteranopia: [0.367322, 0.860646, -0.227968, 0.280085, 0.672501, 0.047413, -0.01182, 0.04294, 0.968881],
  tritanopia: [1.255528, -0.076749, -0.178779, -0.078411, 0.930809, 0.147602, 0.004733, 0.691367, 0.3039],
};

const toLinear = (c: number): number => {
  const s = c / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};
const toSrgb = (l: number): number => {
  const c = Math.min(1, Math.max(0, l));
  return Math.round((c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055) * 255);
};

export function simulate(rgba: Uint8ClampedArray, kind: Deficiency): Uint8ClampedArray {
  const m = MATRICES[kind];
  const out = new Uint8ClampedArray(rgba.length);
  for (let i = 0; i < rgba.length; i += 4) {
    const r = toLinear(rgba[i]!);
    const g = toLinear(rgba[i + 1]!);
    const b = toLinear(rgba[i + 2]!);
    out[i] = toSrgb(m[0]! * r + m[1]! * g + m[2]! * b);
    out[i + 1] = toSrgb(m[3]! * r + m[4]! * g + m[5]! * b);
    out[i + 2] = toSrgb(m[6]! * r + m[7]! * g + m[8]! * b);
    out[i + 3] = rgba[i + 3]!;
  }
  return out;
}
