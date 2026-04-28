import fs from 'fs';
import path from 'path';

import { filterOversizedImages, resolveImageMimeType } from '../../image-utils.js';

interface ImageInput {
  data: string;
  mimeType?: string;
}

export interface PreparedImagePrompt {
  prompt: string;
  rejected: string[];
  paths: string[];
}

const MIME_EXTENSION_MAP: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/bmp': 'bmp',
  'image/svg+xml': 'svg',
};

function stripDataUrlPrefix(base64Data: string): string {
  const match = base64Data.match(/^data:[^;]+;base64,(.+)$/);
  return match ? match[1] : base64Data;
}

function mimeToExtension(mimeType: string): string {
  return MIME_EXTENSION_MAP[mimeType] || 'jpg';
}

export function prepareClaudePromptWithImages(
  prompt: string,
  images: ImageInput[] | undefined,
  tmpDir: string,
  log: (message: string) => void,
): PreparedImagePrompt {
  if (!images || images.length === 0) {
    return { prompt, rejected: [], paths: [] };
  }

  const { valid, rejected } = filterOversizedImages(images, log);
  if (valid.length === 0) {
    return { prompt, rejected, paths: [] };
  }

  fs.mkdirSync(tmpDir, { recursive: true });
  const imagePaths: string[] = [];

  for (let i = 0; i < valid.length; i++) {
    const image = valid[i];
    const mimeType = resolveImageMimeType(image, log);
    const ext = mimeToExtension(mimeType);
    const filePath = path.join(tmpDir, `image-${Date.now()}-${i}.${ext}`);
    fs.writeFileSync(filePath, Buffer.from(stripDataUrlPrefix(image.data), 'base64'));
    imagePaths.push(filePath);
  }

  const suffix = [
    '',
    'Attached images:',
    ...imagePaths.map((filePath) => `- ${filePath}`),
  ].join('\n');

  return {
    prompt: `${prompt}${suffix}`,
    rejected,
    paths: imagePaths,
  };
}
