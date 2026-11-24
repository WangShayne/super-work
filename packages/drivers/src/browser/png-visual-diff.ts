import { deflateSync, inflateSync } from "node:zlib";

const PNG_SIGNATURE = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) {
    c = CRC_TABLE[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function readU32BE(buf: Uint8Array, offset: number): number {
  return (
    ((buf[offset]! << 24) |
      (buf[offset + 1]! << 16) |
      (buf[offset + 2]! << 8) |
      buf[offset + 3]!) >>>
    0
  );
}

function writeU32BE(buf: Uint8Array, offset: number, val: number): void {
  buf[offset] = (val >>> 24) & 0xff;
  buf[offset + 1] = (val >>> 16) & 0xff;
  buf[offset + 2] = (val >>> 8) & 0xff;
  buf[offset + 3] = val & 0xff;
}

function makePngChunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  writeU32BE(out, 0, data.length);
  for (let i = 0; i < 4; i += 1) {
    out[4 + i] = type.charCodeAt(i);
  }
  out.set(data, 8);
  const crc = crc32(out.subarray(4, 8 + data.length));
  writeU32BE(out, 8 + data.length, crc);
  return out;
}

function paethPredictor(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

export function encodeRgbaPng(width: number, height: number, rgba: Uint8Array): Uint8Array {
  if (width <= 0 || height <= 0) {
    throw new Error(`Invalid PNG dimensions ${width}x${height}`);
  }
  if (rgba.length !== width * height * 4) {
    throw new Error(`Expected ${width * height * 4} RGBA bytes, got ${rgba.length}`);
  }

  const ihdr = new Uint8Array(13);
  writeU32BE(ihdr, 0, width);
  writeU32BE(ihdr, 4, height);
  ihdr[8] = 8; // bitDepth
  ihdr[9] = 6; // colorType RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  const stride = width * 4;
  const raw = new Uint8Array(height * (1 + stride));
  for (let y = 0; y < height; y += 1) {
    const rowOut = y * (1 + stride);
    raw[rowOut] = 0; // filter None
    raw.set(rgba.subarray(y * stride, (y + 1) * stride), rowOut + 1);
  }

  const compressed = new Uint8Array(deflateSync(raw));
  const c1 = makePngChunk("IHDR", ihdr);
  const c2 = makePngChunk("IDAT", compressed);
  const c3 = makePngChunk("IEND", new Uint8Array(0));

  const out = new Uint8Array(PNG_SIGNATURE.length + c1.length + c2.length + c3.length);
  let pos = 0;
  out.set(PNG_SIGNATURE, pos);
  pos += PNG_SIGNATURE.length;
  out.set(c1, pos);
  pos += c1.length;
  out.set(c2, pos);
  pos += c2.length;
  out.set(c3, pos);
  return out;
}

export function decodePngToRgba(pngBytes: Uint8Array): {
  width: number;
  height: number;
  rgba: Uint8Array;
} {
  if (pngBytes.length < 33) {
    throw new Error("PNG buffer too short");
  }
  for (let i = 0; i < PNG_SIGNATURE.length; i += 1) {
    if (pngBytes[i] !== PNG_SIGNATURE[i]) {
      throw new Error("Invalid PNG signature");
    }
  }

  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let plte: Uint8Array | null = null;
  let trns: Uint8Array | null = null;
  const idatParts: Uint8Array[] = [];

  let offset = 8;
  while (offset + 12 <= pngBytes.length) {
    const len = readU32BE(pngBytes, offset);
    const type = String.fromCharCode(
      pngBytes[offset + 4]!,
      pngBytes[offset + 5]!,
      pngBytes[offset + 6]!,
      pngBytes[offset + 7]!,
    );
    const dataStart = offset + 8;
    const dataEnd = dataStart + len;
    if (dataEnd + 4 > pngBytes.length) break;
    const data = pngBytes.subarray(dataStart, dataEnd);

    if (type === "IHDR") {
      width = readU32BE(data, 0);
      height = readU32BE(data, 4);
      bitDepth = data[8]!;
      colorType = data[9]!;
      if (bitDepth !== 8) {
        throw new Error(`Unsupported PNG bit depth ${bitDepth} (only 8-bit supported)`);
      }
      if (data[12] !== 0) {
        throw new Error("Interlaced PNG images are not supported");
      }
    } else if (type === "PLTE") {
      plte = data;
    } else if (type === "tRNS") {
      trns = data;
    } else if (type === "IDAT") {
      idatParts.push(data);
    } else if (type === "IEND") {
      break;
    }
    offset = dataEnd + 4;
  }

  if (width <= 0 || height <= 0 || idatParts.length === 0) {
    throw new Error("Incomplete PNG metadata or missing IDAT");
  }

  const totalIdat = idatParts.reduce((s, p) => s + p.length, 0);
  const idatCombined = new Uint8Array(totalIdat);
  let pPos = 0;
  for (const part of idatParts) {
    idatCombined.set(part, pPos);
    pPos += part.length;
  }

  const inflated = new Uint8Array(inflateSync(idatCombined));
  const bpp =
    colorType === 0
      ? 1
      : colorType === 2
        ? 3
        : colorType === 3
          ? 1
          : colorType === 4
            ? 2
            : colorType === 6
              ? 4
              : 0;
  if (bpp === 0) {
    throw new Error(`Unsupported PNG colorType ${colorType}`);
  }

  const rowBytes = width * bpp;
  if (inflated.length < height * (1 + rowBytes)) {
    throw new Error("Corrupted PNG IDAT scanline payload");
  }

  const scanlines = new Uint8Array(height * rowBytes);
  for (let y = 0; y < height; y += 1) {
    const inRow = y * (1 + rowBytes);
    const filter = inflated[inRow]!;
    const curRow = y * rowBytes;
    const prevRow = (y - 1) * rowBytes;

    for (let i = 0; i < rowBytes; i += 1) {
      const raw = inflated[inRow + 1 + i]!;
      const left = i >= bpp ? scanlines[curRow + i - bpp]! : 0;
      const up = y > 0 ? scanlines[prevRow + i]! : 0;
      const upLeft = y > 0 && i >= bpp ? scanlines[prevRow + i - bpp]! : 0;

      let recon = raw;
      if (filter === 1) {
        recon = (raw + left) & 0xff;
      } else if (filter === 2) {
        recon = (raw + up) & 0xff;
      } else if (filter === 3) {
        recon = (raw + ((left + up) >>> 1)) & 0xff;
      } else if (filter === 4) {
        recon = (raw + paethPredictor(left, up, upLeft)) & 0xff;
      }
      scanlines[curRow + i] = recon;
    }
  }

  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const src = (y * width + x) * bpp;
      const dst = (y * width + x) * 4;
      if (colorType === 6) {
        rgba[dst] = scanlines[src]!;
        rgba[dst + 1] = scanlines[src + 1]!;
        rgba[dst + 2] = scanlines[src + 2]!;
        rgba[dst + 3] = scanlines[src + 3]!;
      } else if (colorType === 2) {
        rgba[dst] = scanlines[src]!;
        rgba[dst + 1] = scanlines[src + 1]!;
        rgba[dst + 2] = scanlines[src + 2]!;
        rgba[dst + 3] = 255;
      } else if (colorType === 0) {
        const g = scanlines[src]!;
        rgba[dst] = g;
        rgba[dst + 1] = g;
        rgba[dst + 2] = g;
        rgba[dst + 3] = 255;
      } else if (colorType === 4) {
        const g = scanlines[src]!;
        rgba[dst] = g;
        rgba[dst + 1] = g;
        rgba[dst + 2] = g;
        rgba[dst + 3] = scanlines[src + 1]!;
      } else if (colorType === 3) {
        const idx = scanlines[src]!;
        const pOff = idx * 3;
        rgba[dst] = plte && pOff + 2 < plte.length ? plte[pOff]! : 0;
        rgba[dst + 1] = plte && pOff + 2 < plte.length ? plte[pOff + 1]! : 0;
        rgba[dst + 2] = plte && pOff + 2 < plte.length ? plte[pOff + 2]! : 0;
        rgba[dst + 3] = trns && idx < trns.length ? trns[idx]! : 255;
      }
    }
  }

  return { width, height, rgba };
}

export interface VisualDiffResult {
  width: number;
  height: number;
  totalPixels: number;
  diffPixels: number;
  diffRatio: number;
  diffPngBytes: Uint8Array;
}

export function comparePngVisualDiff(
  baselinePng: Uint8Array,
  currentPng: Uint8Array,
  options?: { channelTolerance?: number },
): VisualDiffResult {
  const tolerance = Math.max(0, options?.channelTolerance ?? 16);
  const a = decodePngToRgba(baselinePng);
  const b = decodePngToRgba(currentPng);
  const width = Math.max(a.width, b.width);
  const height = Math.max(a.height, b.height);
  const totalPixels = width * height;
  const diffRgba = new Uint8Array(totalPixels * 4);

  let diffPixels = 0;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const dst = (y * width + x) * 4;
      const inA = x < a.width && y < a.height;
      const inB = x < b.width && y < b.height;

      if (!inA || !inB) {
        diffPixels += 1;
        diffRgba[dst] = 244;
        diffRgba[dst + 1] = 63;
        diffRgba[dst + 2] = 94;
        diffRgba[dst + 3] = 255;
        continue;
      }

      const offA = (y * a.width + x) * 4;
      const offB = (y * b.width + x) * 4;
      const dr = Math.abs(a.rgba[offA]! - b.rgba[offB]!);
      const dg = Math.abs(a.rgba[offA + 1]! - b.rgba[offB + 1]!);
      const db = Math.abs(a.rgba[offA + 2]! - b.rgba[offB + 2]!);
      const da = Math.abs(a.rgba[offA + 3]! - b.rgba[offB + 3]!);

      if (dr > tolerance || dg > tolerance || db > tolerance || da > tolerance) {
        diffPixels += 1;
        diffRgba[dst] = 244;
        diffRgba[dst + 1] = 63;
        diffRgba[dst + 2] = 94;
        diffRgba[dst + 3] = 255;
      } else {
        diffRgba[dst] = Math.round(b.rgba[offB]! * 0.35 + 24 * 0.65);
        diffRgba[dst + 1] = Math.round(b.rgba[offB + 1]! * 0.35 + 24 * 0.65);
        diffRgba[dst + 2] = Math.round(b.rgba[offB + 2]! * 0.35 + 27 * 0.65);
        diffRgba[dst + 3] = 255;
      }
    }
  }

  const diffRatio = totalPixels > 0 ? diffPixels / totalPixels : 0;
  const diffPngBytes = encodeRgbaPng(width, height, diffRgba);

  return {
    width,
    height,
    totalPixels,
    diffPixels,
    diffRatio,
    diffPngBytes,
  };
}
