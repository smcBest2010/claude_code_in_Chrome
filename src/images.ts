import type { ImageInput, ImageMediaType } from './types.js';

export class ImageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ImageError';
  }
}

/** Detect the real format from magic bytes; never trust the file name or declared type. */
export function sniffImage(b: Uint8Array): ImageMediaType | null {
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return 'image/png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 6) {
    const head = String.fromCharCode(...b.subarray(0, 6));
    if (head === 'GIF87a' || head === 'GIF89a') return 'image/gif';
  }
  if (b.length >= 12 && String.fromCharCode(...b.subarray(0, 4)) === 'RIFF' && String.fromCharCode(...b.subarray(8, 12)) === 'WEBP') return 'image/webp';
  return null;
}

function safeName(name: unknown): string {
  return (typeof name === 'string' ? name : '').replace(/[`\r\n<>]/g, '').slice(0, 60) || '이미지';
}

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/** Validate images uploaded from the page. Any problem rejects the whole request with a user-facing reason. */
export function validateUploads(raw: unknown, opts: { maxBytes: number; maxCount: number }): ImageInput[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new ImageError('이미지 형식이 올바르지 않습니다');
  if (raw.length > opts.maxCount) throw new ImageError(`이미지는 한 번에 최대 ${opts.maxCount}장까지 보낼 수 있습니다 (받은 수: ${raw.length})`);
  const mb = (opts.maxBytes / 1024 / 1024).toFixed(0);
  return raw.map((item: unknown) => {
    const o = (item && typeof item === 'object' ? item : {}) as { name?: unknown; data?: unknown };
    const name = safeName(o.name);
    if (typeof o.data !== 'string' || !o.data) throw new ImageError(`${name}: 이미지 데이터가 비어 있습니다`);
    const data = o.data.replace(/^data:[^,]*,/, '');
    if (data.length > Math.ceil((opts.maxBytes * 4) / 3) + 4) throw new ImageError(`${name}: 파일이 너무 큽니다 (최대 ${mb}MB)`);
    if (!BASE64.test(data)) throw new ImageError(`${name}: 이미지를 읽을 수 없습니다 (손상된 데이터)`);
    const bytes = Buffer.from(data, 'base64');
    if (bytes.byteLength === 0) throw new ImageError(`${name}: 빈 파일입니다`);
    if (bytes.byteLength > opts.maxBytes) throw new ImageError(`${name}: 파일이 너무 큽니다 (최대 ${mb}MB)`);
    const mediaType = sniffImage(bytes);
    if (!mediaType) throw new ImageError(`${name}: 지원하지 않는 이미지 형식입니다 (png/jpeg/gif/webp만 지원)`);
    return { name, mediaType, base64: bytes.toString('base64'), bytes: bytes.byteLength };
  });
}
