const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const rootDir = path.resolve(__dirname, '..');
const verifyOnly = process.argv.includes('--verify-only');

const JS_FILES_TO_CHECK = [
  'server.js',
  'db.js',
  'scripts/setup.js',
  'scripts/package-release.js',
  'netlify/functions/api.mjs',
  'public/app.js',
  'public/room.js',
  'public/sw.js'
];

const JSON_FILES_TO_CHECK = ['package.json', 'public/manifest.json'];

const BUILD_REQUIRED_FILES = [
  'package.json',
  'server.js',
  'db.js',
  'netlify.toml',
  'netlify/functions/api.mjs',
  'public/index.html',
  'public/room.html',
  'public/app.js',
  'public/room.js',
  'public/styles.css',
  'public/manifest.json',
  'public/sw.js',
  'public/icons/icon.svg'
];

const PACKAGE_FILES = [
  ...BUILD_REQUIRED_FILES,
  '.dockerignore',
  '.env.example',
  '.gitignore',
  'Dockerfile',
  'docker-compose.yml',
  'README.md',
  'DEVELOPER_HANDOFF.md',
  'scripts/setup.js',
  'scripts/package-release.js'
];

const EXCLUDED_NAMES = [
  '.env',
  'data',
  'node_modules',
  'node.cmd',
  'npm.cmd',
  path.join('scripts', 'npm-shim.js')
];

function fail(message) {
  console.error(`[build] ERROR: ${message}`);
  process.exit(1);
}

function verifyProject() {
  const requiredList = verifyOnly ? BUILD_REQUIRED_FILES : PACKAGE_FILES;
  console.log('[build] Verifying required deployment files...');
  for (const relPath of requiredList) {
    const fullPath = path.join(rootDir, relPath);
    if (!fs.existsSync(fullPath)) {
      fail(`Missing required file: ${relPath}`);
    }
  }

  console.log('[build] Validating JSON files...');
  for (const relPath of JSON_FILES_TO_CHECK) {
    const fullPath = path.join(rootDir, relPath);
    try {
      JSON.parse(fs.readFileSync(fullPath, 'utf8'));
      console.log(`  OK  ${relPath}`);
    } catch (err) {
      fail(`Invalid JSON in ${relPath}: ${err.message}`);
    }
  }

  console.log('[build] Running syntax checks on JavaScript files...');
  for (const relPath of JS_FILES_TO_CHECK) {
    const fullPath = path.join(rootDir, relPath);
    if (verifyOnly && !fs.existsSync(fullPath)) {
      continue;
    }
    const res = spawnSync(process.execPath, ['--check', fullPath], {
      cwd: rootDir,
      encoding: 'utf8',
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
    });
    if (res.status !== 0) {
      fail(`Syntax check failed for ${relPath}:\n${res.stderr || res.stdout}`);
    }
    console.log(`  OK  ${relPath}`);
  }

  console.log('[build] All verification checks passed.');
}

function copyFileSafe(relPath, targetRoot) {
  const src = path.join(rootDir, relPath);
  const dest = path.join(targetRoot, relPath);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}

function collectFilesRecursive(dirPath, baseDir = dirPath) {
  const results = [];
  for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
    const full = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectFilesRecursive(full, baseDir));
    } else if (entry.isFile()) {
      results.push(path.relative(baseDir, full).replace(/\\/g, '/'));
    }
  }
  return results;
}

function packageRelease() {
  const pkg = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8'));
  const version = pkg.version || '1.0.0';

  const distDir = path.join(rootDir, 'dist');
  const releaseDir = path.join(distDir, 'github-release');
  const zipName = `gvc-security-v${version}.zip`;
  const zipPath = path.join(distDir, zipName);
  const manifestPath = path.join(distDir, 'release-manifest.json');

  if (fs.existsSync(releaseDir)) {
    fs.rmSync(releaseDir, { recursive: true, force: true });
  }
  if (fs.existsSync(zipPath)) {
    fs.rmSync(zipPath, { force: true });
  }
  fs.mkdirSync(releaseDir, { recursive: true });

  console.log(`[package] Staging clean GitHub release in ${releaseDir}...`);
  for (const relPath of PACKAGE_FILES) {
    copyFileSafe(relPath, releaseDir);
  }

  // Assert excluded / secret files were NOT copied
  for (const excluded of EXCLUDED_NAMES) {
    const checkPath = path.join(releaseDir, excluded);
    if (fs.existsSync(checkPath)) {
      fail(`Security check failed: excluded item "${excluded}" found in release folder!`);
    }
  }

  const packagedFiles = collectFilesRecursive(releaseDir).sort();
  let totalBytes = 0;
  for (const rel of packagedFiles) {
    totalBytes += fs.statSync(path.join(releaseDir, rel)).size;
  }

  const manifest = {
    name: pkg.name,
    version,
    packagedAt: new Date().toISOString(),
    fileCount: packagedFiles.length,
    totalBytes,
    files: packagedFiles
  };
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');

  console.log(`[package] Creating archive ${zipPath}...`);
  if (process.platform === 'win32') {
    const psCmd = `Compress-Archive -Path '${releaseDir}\\*' -DestinationPath '${zipPath}' -Force`;
    const zipRes = spawnSync('powershell.exe', ['-NoProfile', '-Command', psCmd], {
      cwd: rootDir,
      encoding: 'utf8'
    });
    if (zipRes.status !== 0) {
      fail(`Failed to create zip archive:\n${zipRes.stderr || zipRes.stdout}`);
    }
  } else {
    const zipRes = spawnSync('zip', ['-r', zipPath, '.'], {
      cwd: releaseDir,
      encoding: 'utf8'
    });
    if (zipRes.status !== 0) {
      fail(`Failed to create zip archive:\n${zipRes.stderr || zipRes.stdout}`);
    }
  }

  const zipSizeKb = (fs.statSync(zipPath).size / 1024).toFixed(1);
  console.log('');
  console.log(`[package] Packaged ${packagedFiles.length} files (${(totalBytes / 1024).toFixed(1)} KB uncompressed).`);
  console.log(`[package] Clean folder: ${releaseDir}`);
  console.log(`[package] Zip archive : ${zipPath} (${zipSizeKb} KB)`);
  console.log(`[package] Manifest    : ${manifestPath}`);
}

verifyProject();
if (!verifyOnly) {
  packageRelease();
}
