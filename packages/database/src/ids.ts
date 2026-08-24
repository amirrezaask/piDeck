import { randomBytes } from 'node:crypto';

let lastTimestamp = -1;
let lastRandom = -1;

/** Create a sortable UUIDv7 identifier without adding a runtime dependency. */
export function createId(now = Date.now()): string {
  const timestamp = Math.max(now, lastTimestamp);
  const random =
    timestamp === lastTimestamp ? (lastRandom + 1) & 0xfff : randomBytes(2).readUInt16BE(0) & 0xfff;

  lastTimestamp = timestamp;
  lastRandom = random;

  const bytes = randomBytes(16);
  bytes[0] = Math.floor(timestamp / 2 ** 40) & 0xff;
  bytes[1] = Math.floor(timestamp / 2 ** 32) & 0xff;
  bytes[2] = Math.floor(timestamp / 2 ** 24) & 0xff;
  bytes[3] = Math.floor(timestamp / 2 ** 16) & 0xff;
  bytes[4] = Math.floor(timestamp / 2 ** 8) & 0xff;
  bytes[5] = timestamp & 0xff;
  bytes[6] = 0x70 | ((random >>> 8) & 0x0f);
  bytes[7] = random & 0xff;
  const variantByte = bytes[8] ?? 0;
  bytes[8] = 0x80 | (variantByte & 0x3f);

  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}
