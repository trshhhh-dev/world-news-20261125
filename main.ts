import { copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const source = join(here, 'entry.png');
const bytes = readFileSync(source);
const MAX_BYTES = 1048576;
const MAX_SIDE = 1024;

const isPng = bytes.length >= 8 &&
  bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
  bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a;
const isJpeg = bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;

if (!isPng && !isJpeg) {
  throw new Error('entry.png has invalid magic bytes: expected PNG or JPEG');
}
if (bytes.length > MAX_BYTES) {
  throw new Error(`entry.png is ${bytes.length} bytes; limit is ${MAX_BYTES}`);
}

function dimensions() {
  if (isPng) {
    if (bytes.length < 24 || bytes.toString('ascii', 12, 16) !== 'IHDR') {
      throw new Error('entry.png PNG has no valid IHDR header');
    }
    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  }

  let at = 2;
  while (at + 9 < bytes.length) {
    if (bytes[at] !== 0xff) { at += 1; continue; }
    const marker = bytes[at + 1];
    if (marker === 0xd9 || marker === 0xda) break;
    const isSof = marker >= 0xc0 && marker <= 0xcf &&
      marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      return { width: bytes.readUInt16BE(at + 7), height: bytes.readUInt16BE(at + 5) };
    }
    const segmentLength = bytes.readUInt16BE(at + 2);
    if (segmentLength < 2) break;
    at += 2 + segmentLength;
  }
  throw new Error('entry.png JPEG has no readable SOF dimensions');
}

const { width, height } = dimensions();
if (width > MAX_SIDE || height > MAX_SIDE) {
  throw new Error(`entry.png is ${width}x${height}; limit is ${MAX_SIDE}x${MAX_SIDE}`);
}

const outputDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
mkdirSync(outputDir, { recursive: true });
copyFileSync(source, join(outputDir, 'entry.png'));
console.log(
  `Copied ${isPng ? 'PNG' : 'JPEG'} entry.png ${width}x${height} ` +
  `(${bytes.length} bytes) to ${outputDir}`,
);
