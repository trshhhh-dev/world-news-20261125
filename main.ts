import { copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const MAX_BYTES = 1048576;
const MAX_SIDE = 1024;
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

type Dimensions = { width: number; height: number; format: 'PNG' | 'JPEG' };

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array, start: number, end: number): number {
  let c = 0xffffffff;
  for (let i = start; i < end; i += 1) {
    c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function hasSignature(bytes: Uint8Array, signature: number[]): boolean {
  if (bytes.length < signature.length) return false;
  for (let i = 0; i < signature.length; i += 1) {
    if (bytes[i] !== signature[i]) return false;
  }
  return true;
}

function checkedDimensions(width: number, height: number, format: 'PNG' | 'JPEG'): Dimensions {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    throw new Error(`${format} has invalid dimensions: ${width}x${height}`);
  }
  if (width > MAX_SIDE || height > MAX_SIDE) {
    throw new Error(`${format} is ${width}x${height}; limit is ${MAX_SIDE}x${MAX_SIDE}`);
  }
  return { width, height, format };
}

function readPng(bytes: Uint8Array): Dimensions {
  if (!hasSignature(bytes, PNG_SIGNATURE)) {
    throw new Error('entry.png has an invalid PNG signature');
  }

  let at = 8;
  let width = 0;
  let height = 0;
  let sawIhdr = false;
  let sawIend = false;

  while (at < bytes.length) {
    if (at + 12 > bytes.length) throw new Error('PNG is truncated: incomplete chunk header');

    const length = ((bytes[at] << 24) | (bytes[at + 1] << 16) | (bytes[at + 2] << 8) | bytes[at + 3]) >>> 0;
    const typeStart = at + 4;
    const type = String.fromCharCode(bytes[typeStart], bytes[typeStart + 1], bytes[typeStart + 2], bytes[typeStart + 3]);
    const dataStart = typeStart + 4;
    const dataEnd = dataStart + length;
    const crcEnd = dataEnd + 4;

    if (length < 0 || crcEnd > bytes.length) {
      throw new Error(`PNG chunk ${type} is truncated`);
    }

    const storedCrc = ((bytes[dataEnd] << 24) | (bytes[dataEnd + 1] << 16) |
      (bytes[dataEnd + 2] << 8) | bytes[dataEnd + 3]) >>> 0;
    const actualCrc = crc32(bytes, typeStart, dataEnd);
    if (actualCrc !== storedCrc) {
      throw new Error(`PNG chunk ${type} has a bad CRC32`);
    }

    if (!sawIhdr) {
      if (type !== 'IHDR') throw new Error(`PNG first chunk is ${type}, expected IHDR`);
      if (length !== 13) throw new Error(`PNG IHDR chunk has length ${length}, expected 13`);
      width = ((bytes[dataStart] << 24) | (bytes[dataStart + 1] << 16) |
        (bytes[dataStart + 2] << 8) | bytes[dataStart + 3]) >>> 0;
      height = ((bytes[dataStart + 4] << 24) | (bytes[dataStart + 5] << 16) |
        (bytes[dataStart + 6] << 8) | bytes[dataStart + 7]) >>> 0;
      sawIhdr = true;
    }

    if (type === 'IEND') {
      if (length !== 0) throw new Error(`PNG IEND chunk has length ${length}, expected 0`);
      sawIend = true;
      at = crcEnd;
      if (at !== bytes.length) throw new Error('PNG has trailing bytes after IEND');
      break;
    }

    at = crcEnd;
  }

  if (!sawIhdr) throw new Error('PNG has no IHDR chunk');
  if (!sawIend) throw new Error('PNG is truncated: no IEND chunk');
  return checkedDimensions(width, height, 'PNG');
}

function readJpeg(bytes: Uint8Array): Dimensions {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) {
    throw new Error('entry.png has an invalid JPEG signature');
  }

  let at = 2;
  let width = 0;
  let height = 0;

  while (at < bytes.length) {
    if (bytes[at] !== 0xff) {
      at += 1;
      continue;
    }
    while (at < bytes.length && bytes[at] === 0xff) at += 1;
    if (at >= bytes.length) break;

    const marker = bytes[at];
    at += 1;

    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (marker === 0xd9) throw new Error('JPEG ended before any SOF dimensions');
    if (at + 2 > bytes.length) throw new Error('JPEG is truncated: incomplete segment length');

    const length = (bytes[at] << 8) | bytes[at + 1];
    if (length < 2 || at + length > bytes.length) {
      throw new Error('JPEG is truncated: incomplete segment');
    }

    const isSof = marker >= 0xc0 && marker <= 0xcf &&
      marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      if (length < 8) throw new Error('JPEG SOF segment is too short');
      height = (bytes[at + 3] << 8) | bytes[at + 4];
      width = (bytes[at + 5] << 8) | bytes[at + 6];
    }

    if (marker === 0xda) {
      if (width === 0 || height === 0) throw new Error('JPEG has no SOF dimensions');
      let scan = at + length;
      while (scan + 1 < bytes.length) {
        if (bytes[scan] === 0xff && bytes[scan + 1] === 0xd9) {
          return checkedDimensions(width, height, 'JPEG');
        }
        scan += 1;
      }
      throw new Error('JPEG is truncated: no EOI marker');
    }

    at += length;
  }

  throw new Error('JPEG is truncated: no EOI marker');
}

function main(): void {
  const here = dirname(fileURLToPath(import.meta.url));
  const source = join(here, 'entry.png');
  const bytes = readFileSync(source);

  if (bytes.length > MAX_BYTES) {
    throw new Error(`entry.png is ${bytes.length} bytes; limit is ${MAX_BYTES}`);
  }

  const isPng = hasSignature(bytes, PNG_SIGNATURE);
  const isJpeg = bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (!isPng && !isJpeg) {
    throw new Error('entry.png has invalid magic bytes: expected PNG or JPEG');
  }

  const { width, height, format } = isPng ? readPng(bytes) : readJpeg(bytes);
  const outputDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
  mkdirSync(outputDir, { recursive: true });
  copyFileSync(source, join(outputDir, 'entry.png'));
  console.log(`Copied ${format} entry.png ${width}x${height} (${bytes.length} bytes) to ${outputDir}`);
}

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`main.ts: ${message}`);
  process.exit(1);
}
