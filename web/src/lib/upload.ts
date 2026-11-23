/**
 * Upload checks and the direct browser-to-S3 upload.
 *
 * The browser never sends the file to the API. It asks the API for a presigned POST, then posts the file straight to
 * S3. The POST policy signed by the API fixes the key, the content type and the size range, so S3 itself rejects
 * anything else. The checks here only give a faster, clearer message; they are not the security boundary.
 */

import type { PresignedPost } from './types';

export function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
}

/** A reason the file cannot be uploaded, or null if it looks fine. */
export function checkFile(file: { name: string; size: number }, maxFileMb: number, allowed: string[]): string | null {
  const extension = extensionOf(file.name);
  if (!extension || !allowed.includes(extension)) {
    return `${file.name}: this file type is not supported. Allowed: ${allowed.map((e) => '.' + e).join(', ')}.`;
  }
  if (file.name.toLowerCase().endsWith('.metadata.json')) return `${file.name}: this file name is reserved.`;
  if (file.size === 0) return `${file.name}: the file is empty.`;
  if (file.size > maxFileMb * 1024 * 1024) return `${file.name}: the file is larger than ${maxFileMb} MB.`;
  return null;
}

/** Post the file to S3. The policy fields must come first and the file last, as S3 requires. */
export async function postToS3(upload: PresignedPost, file: Blob, fetchImpl: typeof fetch = fetch): Promise<void> {
  const form = new FormData();
  for (const [key, value] of Object.entries(upload.fields)) form.append(key, value);
  form.append('file', file);
  let response: Response;
  try {
    response = await fetchImpl(upload.url, { method: 'POST', body: form });
  } catch {
    throw new Error('The upload failed because of a network error.');
  }
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    if (body.includes('EntityTooLarge')) throw new Error('The file is larger than allowed.');
    throw new Error(`The storage service rejected the upload (HTTP ${response.status}).`);
  }
}
