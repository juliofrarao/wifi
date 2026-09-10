#!/usr/bin/env node
/**
 * Generates the PWA icons procedurally (no dependencies): a rounded green
 * square with a white house and an orange "child" figure at the door.
 *
 *   node web/scripts/make-icons.mjs
 *
 * Writes web/public/icons/icon-192.png, icon-512.png and icon-512-maskable.png.
 */
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, '..', 'public', 'icons');
mkdirSync(outDir, { recursive: true });

// ---- PNG encoding -----------------------------------------------------------

const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  CRC_TABLE[n] = c >>> 0;
}
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}
function encodePng(width, height, rgba) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type RGBA
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

// ---- Drawing ----------------------------------------------------------------

const GREEN = [27, 127, 59];
const WHITE = [255, 255, 255];
const ORANGE = [230, 120, 20];
const DARK = [20, 80, 40];

function inRoundedSquare(x, y, size, radius) {
  const rx = Math.max(0, Math.abs(x - size / 2) - (size / 2 - radius));
  const ry = Math.max(0, Math.abs(y - size / 2) - (size / 2 - radius));
  return rx * rx + ry * ry <= radius * radius;
}

/** Colour of a point in unit coordinates (0..1) or null for transparent. */
function sample(u, v, maskable) {
  const size = 1;
  // Background
  if (maskable) {
    // full bleed (safe zone: centre 80%)
  } else if (!inRoundedSquare(u, v, size, 0.2)) {
    return null;
  }
  let color = GREEN;

  // House geometry (centre 0.5, 0.55)
  const cx = 0.5;
  const scale = maskable ? 0.72 : 0.86;
  const x = (u - cx) / scale;
  const y = (v - 0.55) / scale;

  // Roof: triangle from (-0.36, -0.02) to (0.36, -0.02) apex (0, -0.34)
  const roofTop = -0.34;
  const roofBase = -0.02;
  const inRoof = y >= roofTop && y <= roofBase && Math.abs(x) <= ((y - roofTop) / (roofBase - roofTop)) * 0.38;
  // Body: rect x in [-0.28, 0.28], y in [-0.04, 0.32]
  const inBody = Math.abs(x) <= 0.28 && y >= -0.04 && y <= 0.32;
  // Door: rect x in [-0.09, 0.09], y in [0.06, 0.32]
  const inDoor = Math.abs(x) <= 0.09 && y >= 0.05 && y <= 0.32;
  // Child: head circle at (0, 0.11) r 0.045; body rounded rect
  const headR = 0.045;
  const inHead = (x - 0) ** 2 + (y - 0.115) ** 2 <= headR * headR;
  const inChildBody = Math.abs(x) <= 0.055 - Math.max(0, (0.17 - y) * 0.2) && y >= 0.165 && y <= 0.32;
  // Chimney
  const inChimney = x >= 0.16 && x <= 0.24 && y >= -0.26 && y <= -0.1;

  if (inRoof || inBody || inChimney) color = WHITE;
  if (inDoor) color = DARK;
  if (inHead || inChildBody) color = ORANGE;
  return color;
}

function render(size, maskable) {
  const ss = 4; // supersampling
  const rgba = Buffer.alloc(size * size * 4);
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const u = (px + (sx + 0.5) / ss) / size;
          const v = (py + (sy + 0.5) / ss) / size;
          const c = sample(u, v, maskable);
          if (c) {
            r += c[0];
            g += c[1];
            b += c[2];
            a += 255;
          }
        }
      }
      const n = ss * ss;
      const i = (py * size + px) * 4;
      const cov = a / n;
      if (cov > 0) {
        // premultiplied average of covered samples
        const covered = a / 255;
        rgba[i] = Math.round(r / covered);
        rgba[i + 1] = Math.round(g / covered);
        rgba[i + 2] = Math.round(b / covered);
        rgba[i + 3] = Math.round(cov);
      }
    }
  }
  return encodePng(size, size, rgba);
}

writeFileSync(join(outDir, 'icon-192.png'), render(192, false));
writeFileSync(join(outDir, 'icon-512.png'), render(512, false));
writeFileSync(join(outDir, 'icon-512-maskable.png'), render(512, true));
console.log('Icons written to', outDir);
