/**
 * Codex image utilities — base64 → temporary file.
 *
 * Codex SDK requires local file paths for images, not base64 data.
 */

import fs from 'fs';
import path from 'path';
import os from 'os';

/**
 * Save base64 images to temporary files and return their paths.
 */
export function saveImagesToTempFiles(
  images: Array<{ data: string; mimeType?: string }>,
  tmpDir?: string,
): string[] {
  const dir = tmpDir || fs.mkdtempSync(path.join(os.tmpdir(), 'happyclaw-codex-'));
  const paths: string[] = [];

  for (let i = 0; i < images.length; i++) {
    const img = images[i];
    const ext = mimeToExtension(img.mimeType || 'image/png');
    const filePath = path.join(dir, `image-${i}.${ext}`);

    // Strip data URL prefix if present
    let base64Data = img.data;
    const dataUrlMatch = base64Data.match(/^data:[^;]+;base64,(.+)$/);
    if (dataUrlMatch) {
      base64Data = dataUrlMatch[1];
    }

    fs.writeFileSync(filePath, Buffer.from(base64Data, 'base64'));
    paths.push(filePath);
  }

  return paths;
}

function mimeToExtension(mime: string): string {
  const map: Record<string, string> = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/gif': 'gif',
    'image/webp': 'webp',
    'image/svg+xml': 'svg',
  };
  return map[mime] || 'png';
}
