/* eslint-disable no-console */
'use strict';

/**
 * electron-builder afterPack hook.
 *
 * The desktop package carries the AgentDock backend as extraResources, including
 * the repo-root node_modules tree. When a macOS package is produced from a
 * Linux devbox/CI host, npm has installed Linux native addons in that tree. The
 * app then starts Electron successfully, but the backend child process exits as
 * soon as it requires modules such as better-sqlite3 or node-pty.
 *
 * Normalize the native addons that AgentDock currently ships in the backend
 * resources to the macOS architecture being packed, then fail the build if the
 * resulting .app still contains Linux ELF native modules on the hot path.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const MACHO_MAGICS = new Set([
  'feedface', // Mach-O 32-bit, big endian
  'feedfacf', // Mach-O 64-bit, big endian
  'cefaedfe', // Mach-O 32-bit, little endian
  'cffaedfe', // Mach-O 64-bit, little endian
  'cafebabe', // universal/fat binary
  'cafebabf', // universal/fat 64-bit binary
]);

function normalizeArch(rawArch) {
  const value = String(rawArch ?? '').toLowerCase();
  if (value === '1' || value === 'x64' || value === 'x86_64') return 'x64';
  if (value === '3' || value === 'arm64' || value === 'aarch64') return 'arm64';
  if (value === '4' || value === 'universal') {
    throw new Error(
      'Universal macOS native addon packaging is not supported by AgentDock yet. Build x64/arm64 separately.',
    );
  }
  throw new Error(
    `Unsupported macOS native addon arch from electron-builder: ${rawArch}`,
  );
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function copyFile(src, dest, mode) {
  if (!fs.existsSync(src)) {
    throw new Error(`Required native source is missing: ${src}`);
  }
  ensureDir(path.dirname(dest));
  fs.copyFileSync(src, dest);
  if (mode !== undefined) fs.chmodSync(dest, mode);
}

function readMagic(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(4);
    fs.readSync(fd, buf, 0, 4, 0);
    return buf.toString('hex');
  } finally {
    fs.closeSync(fd);
  }
}

function isMachO(file) {
  return MACHO_MAGICS.has(readMagic(file));
}

function assertMachO(file) {
  if (!fs.existsSync(file)) {
    throw new Error(`Expected native addon is missing: ${file}`);
  }
  const magic = readMagic(file);
  if (!MACHO_MAGICS.has(magic)) {
    throw new Error(
      `Expected Mach-O native addon, got magic=${magic}: ${file}`,
    );
  }
}

function removeIfExists(target) {
  try {
    const stat = fs.lstatSync(target);
    if (stat.isSymbolicLink()) {
      fs.unlinkSync(target);
      return;
    }
  } catch {
    return;
  }
  fs.rmSync(target, { recursive: true, force: true });
}

function pruneBrokenBinLinks(binDir) {
  if (!fs.existsSync(binDir)) return;
  for (const entry of fs.readdirSync(binDir, { withFileTypes: true })) {
    if (!entry.isSymbolicLink()) continue;
    const linkPath = path.join(binDir, entry.name);
    const target = fs.readlinkSync(linkPath);
    const resolvedTarget = path.resolve(binDir, target);
    if (!fs.existsSync(resolvedTarget)) {
      removeIfExists(linkPath);
    }
  }
}

function prunePackagedNodeModules({ resourcesDir, arch }) {
  const backendNodeModules = path.join(resourcesDir, 'backend', 'node_modules');
  const agentRunnerNodeModules = path.join(
    resourcesDir,
    'container',
    'agent-runner',
    'node_modules',
  );

  for (const packageName of [
    '@types',
    '@esbuild',
    'concurrently',
    'esbuild',
    'prettier',
    'tsx',
    'typescript',
  ]) {
    removeIfExists(path.join(backendNodeModules, packageName));
  }

  for (const packageName of ['@types', 'typescript']) {
    removeIfExists(path.join(agentRunnerNodeModules, packageName));
  }
  for (const binName of [
    'conc',
    'concurrently',
    'esbuild',
    'prettier',
    'tsc',
    'tsserver',
    'tsx',
  ]) {
    removeIfExists(path.join(backendNodeModules, '.bin', binName));
  }
  for (const binName of ['tsc', 'tsserver']) {
    removeIfExists(path.join(agentRunnerNodeModules, '.bin', binName));
  }
  pruneBrokenBinLinks(path.join(backendNodeModules, '.bin'));
  pruneBrokenBinLinks(path.join(agentRunnerNodeModules, '.bin'));

  const nodePtyPrebuilds = path.join(
    backendNodeModules,
    'node-pty',
    'prebuilds',
  );
  if (fs.existsSync(nodePtyPrebuilds)) {
    for (const entry of fs.readdirSync(nodePtyPrebuilds)) {
      if (entry !== `darwin-${arch}`) {
        removeIfExists(path.join(nodePtyPrebuilds, entry));
      }
    }
  }
}

function appPathFromResourcesDir(resourcesDir) {
  return path.dirname(path.dirname(resourcesDir));
}

function adHocSignApp(resourcesDir) {
  const appPath = appPathFromResourcesDir(resourcesDir);
  runAndCapture('codesign', ['--force', '--deep', '--sign', '-', appPath], {
    cwd: path.dirname(appPath),
    env: process.env,
  });
  runAndCapture(
    'codesign',
    ['--verify', '--deep', '--strict', '--verbose=2', appPath],
    {
      cwd: path.dirname(appPath),
      env: process.env,
    },
  );
}

function findResourcesDir(appOutDir) {
  const candidates = fs
    .readdirSync(appOutDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.endsWith('.app'))
    .map((entry) => path.join(appOutDir, entry.name, 'Contents', 'Resources'));

  const resourcesDir = candidates.find((candidate) => fs.existsSync(candidate));
  if (!resourcesDir) {
    throw new Error(
      `Unable to locate .app Contents/Resources under ${appOutDir}`,
    );
  }
  return resourcesDir;
}

function packageRootFromBackendNodeModules(backendNodeModules) {
  const packageJson = path.join(
    backendNodeModules,
    'better-sqlite3',
    'package.json',
  );
  if (!fs.existsSync(packageJson)) {
    throw new Error(
      `better-sqlite3 package.json not found in packaged backend: ${packageJson}`,
    );
  }
  return JSON.parse(fs.readFileSync(packageJson, 'utf8'));
}

function npmCommand() {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

function resolveElectronTarget(projectDir) {
  const lockFile = path.join(projectDir || process.cwd(), 'package-lock.json');
  if (fs.existsSync(lockFile)) {
    const lock = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
    const lockedElectron = lock.packages?.['node_modules/electron']?.version;
    if (lockedElectron) return lockedElectron;
  }

  const packageFile = path.join(projectDir || process.cwd(), 'package.json');
  if (fs.existsSync(packageFile)) {
    const pkg = JSON.parse(fs.readFileSync(packageFile, 'utf8'));
    const spec = pkg.devDependencies?.electron || pkg.dependencies?.electron;
    if (typeof spec === 'string') {
      const exact = spec.match(/\d+\.\d+\.\d+/)?.[0];
      if (exact) return exact;
    }
  }

  throw new Error(
    `Unable to resolve packaged Electron version from ${lockFile} or ${packageFile}`,
  );
}

function resolveElectronAbi(tmpDir, electronTarget) {
  const nodeAbiPath = require.resolve('node-abi', {
    paths: [path.join(tmpDir, 'node_modules')],
  });
  return require(nodeAbiPath).getAbi(electronTarget, 'electron');
}

function runAndCapture(command, args, options) {
  const result = spawnSync(command, args, {
    ...options,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stdout = result.stdout || '';
  const stderr = result.stderr || '';
  if (stdout) process.stdout.write(stdout);
  if (stderr) process.stderr.write(stderr);
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} exited with status ${result.status}`,
    );
  }
  return `${stdout}${stderr}`;
}

function installDarwinBetterSqliteBinary({
  backendNodeModules,
  arch,
  cacheRoot,
  electronTarget,
}) {
  const pkg = packageRootFromBackendNodeModules(backendNodeModules);
  const version = pkg.version;
  if (!version)
    throw new Error('Unable to resolve packaged better-sqlite3 version');

  const cacheDir = path.join(
    cacheRoot,
    'better-sqlite3',
    version,
    `electron-${electronTarget}`,
    `darwin-${arch}`,
  );
  const cachedBinary = path.join(cacheDir, 'better_sqlite3.node');
  if (!fs.existsSync(cachedBinary) || !isMachO(cachedBinary)) {
    const tmp = fs.mkdtempSync(
      path.join(os.tmpdir(), `agentdock-better-sqlite3-${arch}-`),
    );
    try {
      fs.writeFileSync(
        path.join(tmp, 'package.json'),
        JSON.stringify({ private: true, dependencies: {} }),
      );
      console.log(
        `[afterPack] installing better-sqlite3@${version} for electron-${electronTarget} darwin-${arch}`,
      );
      runAndCapture(
        npmCommand(),
        [
          'install',
          `better-sqlite3@${version}`,
          '--ignore-scripts',
          '--omit=dev',
          '--no-audit',
          '--no-fund',
        ],
        { cwd: tmp, env: process.env },
      );

      const betterSqliteDir = path.join(tmp, 'node_modules', 'better-sqlite3');
      const expectedAbi = resolveElectronAbi(tmp, electronTarget);
      const prebuildOutput = runAndCapture(
        path.join(tmp, 'node_modules', '.bin', 'prebuild-install'),
        [
          '--runtime',
          'electron',
          '--target',
          electronTarget,
          '--platform',
          'darwin',
          '--arch',
          arch,
          '--verbose',
        ],
        { cwd: betterSqliteDir, env: process.env },
      );
      const expectedAsset = `better-sqlite3-v${version}-electron-v${expectedAbi}-darwin-${arch}.tar.gz`;
      if (!prebuildOutput.includes(expectedAsset)) {
        throw new Error(
          `better-sqlite3 prebuild did not use expected Electron ABI asset ${expectedAsset}`,
        );
      }

      const installedBinary = path.join(
        betterSqliteDir,
        'build',
        'Release',
        'better_sqlite3.node',
      );
      assertMachO(installedBinary);
      ensureDir(cacheDir);
      fs.copyFileSync(installedBinary, cachedBinary);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }

  const target = path.join(
    backendNodeModules,
    'better-sqlite3',
    'build',
    'Release',
    'better_sqlite3.node',
  );
  copyFile(cachedBinary, target, 0o644);
  assertMachO(target);
}

function normalizeNodePty({ backendNodeModules, arch }) {
  const nodePtyRoot = path.join(backendNodeModules, 'node-pty');
  const prebuildDir = path.join(nodePtyRoot, 'prebuilds', `darwin-${arch}`);
  const releaseDir = path.join(nodePtyRoot, 'build', 'Release');

  // node-pty checks build/Release before prebuilds. Replace the host-built
  // Linux addon with the matching macOS prebuild, and put spawn-helper next to
  // it so the selected native.dir is self-contained at runtime.
  copyFile(
    path.join(prebuildDir, 'pty.node'),
    path.join(releaseDir, 'pty.node'),
    0o644,
  );
  copyFile(
    path.join(prebuildDir, 'spawn-helper'),
    path.join(releaseDir, 'spawn-helper'),
    0o755,
  );
  assertMachO(path.join(releaseDir, 'pty.node'));
}

function normalizeMacNativeModules({ appOutDir, arch, projectDir }) {
  const normalizedArch = normalizeArch(arch);
  const electronTarget = resolveElectronTarget(projectDir);
  const resourcesDir = findResourcesDir(appOutDir);
  const backendNodeModules = path.join(resourcesDir, 'backend', 'node_modules');
  if (!fs.existsSync(backendNodeModules)) {
    throw new Error(
      `Packaged backend node_modules not found: ${backendNodeModules}`,
    );
  }

  const cacheRoot = process.env.AGENTDOCK_DESKTOP_NATIVE_CACHE
    ? path.resolve(process.env.AGENTDOCK_DESKTOP_NATIVE_CACHE)
    : path.join(projectDir || process.cwd(), '.native-cache');

  installDarwinBetterSqliteBinary({
    backendNodeModules,
    arch: normalizedArch,
    cacheRoot,
    electronTarget,
  });
  normalizeNodePty({ backendNodeModules, arch: normalizedArch });
  prunePackagedNodeModules({ resourcesDir, arch: normalizedArch });
  adHocSignApp(resourcesDir);

  const checked = [
    path.join(
      backendNodeModules,
      'better-sqlite3',
      'build',
      'Release',
      'better_sqlite3.node',
    ),
    path.join(backendNodeModules, 'node-pty', 'build', 'Release', 'pty.node'),
  ];
  for (const file of checked) assertMachO(file);
  console.log(
    `[afterPack] normalized ${checked.length} macOS native addons for electron-${electronTarget} darwin-${normalizedArch}`,
  );
}

module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;
  normalizeMacNativeModules({
    appOutDir: context.appOutDir,
    arch: context.arch,
    projectDir: context.packager?.projectDir,
  });
};

module.exports._private = {
  normalizeArch,
  normalizeMacNativeModules,
  resolveElectronTarget,
  assertMachO,
  readMagic,
  prunePackagedNodeModules,
  adHocSignApp,
  pruneBrokenBinLinks,
};
