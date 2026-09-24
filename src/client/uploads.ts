import type { UploadExpiry, UploadRecord } from '../shared/contracts';
import { ApiError } from './api';

export const expiryLabels: Record<UploadExpiry, string> = {
  '1h': '1 hour',
  '1d': '1 day',
  '7d': '7 days',
  '30d': '30 days',
  permanent: 'Permanent',
};

/** Binary units, as file managers show them: 1536 → "1.5 KB". */
export function formatBytes(bytes: number): string {
  const units = ['bytes', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return unit === 0 ? `${bytes} ${bytes === 1 ? 'byte' : 'bytes'}`
    : `${value.toLocaleString(undefined, { maximumFractionDigits: value < 10 ? 1 : 0 })} ${units[unit]}`;
}

/** Thrown when `xhr.abort()` cancels an upload; not an error to report. */
export class UploadCancelled extends Error {}

/**
 * `POST /api/uploads` through XMLHttpRequest, which (unlike fetch) reports upload progress.
 * Same-origin XHR sends the session cookie, like `api()`'s `credentials: 'same-origin'`.
 */
export function postUpload(file: File, expiry: UploadExpiry, xhr: XMLHttpRequest,
  onProgress: (loaded: number, total: number) => void): Promise<UploadRecord> {
  return new Promise((resolve, reject) => {
    const body = new FormData();
    body.append('file', file);
    body.append('expiry', expiry);
    xhr.open('POST', '/api/uploads');
    xhr.responseType = 'json';
    xhr.upload.onprogress = (event) => { if (event.lengthComputable) onProgress(event.loaded, event.total); };
    xhr.onload = () => {
      const response: unknown = xhr.response;
      if (xhr.status >= 200 && xhr.status < 300) {
        if (response && typeof response === 'object' && 'url' in response && typeof response.url === 'string') {
          resolve(response as UploadRecord);
        } else reject(new ApiError('Invalid upload response', xhr.status));
        return;
      }
      const error = response && typeof response === 'object' && 'error' in response ? response.error : null;
      reject(new ApiError(typeof error === 'string' ? error : `Upload failed (${xhr.status})`, xhr.status));
    };
    xhr.onerror = () => reject(new Error(`Could not upload ${file.name || 'the file'}: the connection failed.`));
    xhr.onabort = () => reject(new UploadCancelled('Upload cancelled'));
    xhr.send(body);
  });
}
