import fs from 'fs';
import path from 'path';

function isSamePath(left: string, right: string): boolean {
  return path.resolve(left) === path.resolve(right);
}

function isPathWithin(child: string, parent: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return (
    relative.length > 0 &&
    !relative.startsWith('..') &&
    !path.isAbsolute(relative)
  );
}

async function copyDirectoryContentsSafely(
  sourceDir: string,
  destDir: string,
  skipSourcePath: string,
): Promise<void> {
  await fs.promises.mkdir(destDir, { recursive: true });
  const entries = await fs.promises.readdir(sourceDir, { withFileTypes: true });

  for (const entry of entries) {
    const sourcePath = path.join(sourceDir, entry.name);
    if (isSamePath(sourcePath, skipSourcePath)) continue;

    const destPath = path.join(destDir, entry.name);
    if (entry.isDirectory()) {
      await copyDirectoryContentsSafely(sourcePath, destPath, skipSourcePath);
      continue;
    }
    if (entry.isSymbolicLink()) {
      const linkTarget = await fs.promises.readlink(sourcePath);
      await fs.promises.symlink(linkTarget, destPath);
      continue;
    }
    await fs.promises.cp(sourcePath, destPath, { recursive: false });
  }
}

export async function initializeWorkspaceFromLocalDirectory(
  sourceDir: string,
  destDir: string,
): Promise<void> {
  const resolvedSource = path.resolve(sourceDir);
  const resolvedDest = path.resolve(destDir);

  if (!isPathWithin(resolvedDest, resolvedSource)) {
    await fs.promises.cp(resolvedSource, resolvedDest, { recursive: true });
    return;
  }

  // Avoid recursive self-copy when the destination lives inside the source tree.
  await copyDirectoryContentsSafely(resolvedSource, resolvedDest, resolvedDest);
}
