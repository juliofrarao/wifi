/**
 * Tiny PNG encoder (no dependencies) for procedural placeholder photos:
 * 8-bit RGB, no interlace, one IDAT chunk (zlib from node:zlib).
 */
import { deflateSync } from 'node:zlib';

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

export type Rgb = [number, number, number];

/** Encode an RGB image; `pixel(x, y)` returns [r, g, b] (0–255). */
export function encodePng(width: number, height: number, pixel: (x: number, y: number) => Rgb): Buffer {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  let p = 0;
  for (let y = 0; y < height; y++) {
    raw[p++] = 0; // filter: none
    for (let x = 0; x < width; x++) {
      const [r, g, b] = pixel(x, y);
      raw[p++] = r;
      raw[p++] = g;
      raw[p++] = b;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: RGB
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** HSL (h in degrees, s/l in 0–1) → RGB bytes. */
export function hslToRgb(h: number, s: number, l: number): Rgb {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = ((h % 360) + 360) % 360 / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let r = 0;
  let g = 0;
  let b = 0;
  if (hp < 1) [r, g, b] = [c, x, 0];
  else if (hp < 2) [r, g, b] = [x, c, 0];
  else if (hp < 3) [r, g, b] = [0, c, x];
  else if (hp < 4) [r, g, b] = [0, x, c];
  else if (hp < 5) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  const m = l - c / 2;
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}

/**
 * A simple "avatar" placeholder: coloured background (hue from the seed), a
 * lighter head circle and shoulders. Deterministic for a given seed.
 */
export function avatarPng(seed: number, size = 96): Buffer {
  const hue = (seed * 47) % 360;
  const bg = hslToRgb(hue, 0.45, 0.42);
  const skin = hslToRgb(hue, 0.35, 0.82);
  const cx = size / 2;
  const headY = size * 0.4;
  const headR = size * 0.19;
  const bodyY = size * 0.98;
  const bodyRx = size * 0.32;
  const bodyRy = size * 0.28;
  return encodePng(size, size, (x, y) => {
    const dx = x + 0.5 - cx;
    const dyHead = y + 0.5 - headY;
    if (dx * dx + dyHead * dyHead <= headR * headR) return skin;
    const dyBody = (y + 0.5 - bodyY) / bodyRy;
    const dxBody = dx / bodyRx;
    if (dxBody * dxBody + dyBody * dyBody <= 1) return skin;
    return bg;
  });
}
