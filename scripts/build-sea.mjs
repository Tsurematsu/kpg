#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import * as esbuild from 'esbuild';

const ROOT = path.resolve(import.meta.dirname, '..');
const DIST_DIR = path.join(ROOT, 'dist');
const CACHE_DIR = path.join(ROOT, '.cache');
const BUNDLE_FILE = path.join(DIST_DIR, 'kpg.mjs');

const NODE_VERSION = process.version; // e.g. v26.13.1
const WIN_NODE_DIR = path.join(CACHE_DIR, `node-${NODE_VERSION}-win-x64`);
const WIN_NODE_EXE = path.join(WIN_NODE_DIR, 'node.exe');
const WIN_ZIP_URL = `https://nodejs.org/dist/${NODE_VERSION}/node-${NODE_VERSION}-win-x64.zip`;

const args = new Set(process.argv.slice(2));
const bundleOnly = args.has('--bundle-only');
const buildLinux = args.has('--linux') || (!bundleOnly && !args.has('--win'));
const buildWin = args.has('--win') || (!bundleOnly && !args.has('--linux'));

function formatMB(bytes) {
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

async function bundleApp() {
  fs.mkdirSync(DIST_DIR, { recursive: true });
  console.log('1) Empaquetando src/index.tsx → dist/kpg.mjs (ESM + React/Ink)...');

  const stubDevtoolsPlugin = {
    name: 'stub-react-devtools-core',
    setup(build) {
      build.onResolve({ filter: /^react-devtools-core$/ }, () => ({
        path: 'react-devtools-core',
        namespace: 'kpg-stub',
      }));
      build.onLoad({ filter: /.*/, namespace: 'kpg-stub' }, () => ({
        contents: 'export default {};',
        loader: 'js',
      }));
    },
  };

  await esbuild.build({
    entryPoints: [path.join(ROOT, 'src', 'index.tsx')],
    bundle: true,
    platform: 'node',
    target: 'node24',
    format: 'esm',
    jsx: 'automatic',
    minify: true,
    outfile: BUNDLE_FILE,
    define: {
      'process.env.DEV': '"false"',
      'process.env.NODE_ENV': '"production"',
    },
    banner: {
      js: [
        "import { createRequire as __kpgCreateRequire } from 'node:module';",
        'const require = __kpgCreateRequire(process.execPath);',
      ].join('\n'),
    },
    plugins: [stubDevtoolsPlugin],
  });

  const size = fs.statSync(BUNDLE_FILE).size;
  console.log(`   ✔ Bundle generado: ${BUNDLE_FILE} (${formatMB(size)})`);
}

function buildSeaTarget({ label, configFile, outputFile, executablePath }) {
  const seaConfig = {
    main: BUNDLE_FILE,
    mainFormat: 'module',
    output: outputFile,
    disableExperimentalSEAWarning: true,
    useSnapshot: false,
    useCodeCache: false,
    ...(executablePath ? { executable: executablePath } : {}),
  };

  fs.writeFileSync(configFile, JSON.stringify(seaConfig, null, 2));
  console.log(`2) Construyendo ejecutable ${label} con node --build-sea...`);

  execFileSync(process.execPath, ['--build-sea', configFile], {
    cwd: ROOT,
    stdio: 'inherit',
  });

  if (!outputFile.endsWith('.exe')) {
    fs.chmodSync(outputFile, 0o755);
  }

  const size = fs.statSync(outputFile).size;
  console.log(`   ✔ ${label} listo: ${outputFile} (${formatMB(size)})`);
}

async function ensureWindowsNodeExe() {
  if (fs.existsSync(WIN_NODE_EXE)) {
    console.log(`   ✔ Usando node.exe en caché: ${WIN_NODE_EXE}`);
    return WIN_NODE_EXE;
  }

  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const zipPath = path.join(CACHE_DIR, `node-${NODE_VERSION}-win-x64.zip`);

  console.log(`   Descargando Node.js Windows (${NODE_VERSION}) desde ${WIN_ZIP_URL}...`);
  const resp = await fetch(WIN_ZIP_URL);
  if (!resp.ok) {
    throw new Error(
      `No se pudo descargar ${WIN_ZIP_URL} (HTTP ${resp.status}). Verifica conexión a internet.`,
    );
  }
  const arrayBuf = await resp.arrayBuffer();
  fs.writeFileSync(zipPath, Buffer.from(arrayBuf));

  console.log('   Extrayendo node.exe del archivo zip...');
  fs.mkdirSync(WIN_NODE_DIR, { recursive: true });
  execFileSync(
    'unzip',
    ['-o', '-j', zipPath, `node-${NODE_VERSION}-win-x64/node.exe`, '-d', WIN_NODE_DIR],
    { stdio: 'inherit' },
  );

  try {
    fs.unlinkSync(zipPath);
  } catch {
    // ignore temp zip cleanup error
  }

  if (!fs.existsSync(WIN_NODE_EXE)) {
    throw new Error(`No se encontró ${WIN_NODE_EXE} tras descomprimir el zip.`);
  }

  return WIN_NODE_EXE;
}

async function main() {
  await bundleApp();
  if (bundleOnly) return;

  if (buildLinux) {
    buildSeaTarget({
      label: 'Linux x64 (bin)',
      configFile: path.join(DIST_DIR, 'sea-linux.json'),
      outputFile: path.join(DIST_DIR, 'kpg-linux'),
      executablePath: undefined,
    });
  }

  if (buildWin) {
    const winExe = await ensureWindowsNodeExe();
    buildSeaTarget({
      label: 'Windows x64 (.exe)',
      configFile: path.join(DIST_DIR, 'sea-win.json'),
      outputFile: path.join(DIST_DIR, 'kpg-win.exe'),
      executablePath: winExe,
    });
  }

  console.log('\n🎉 Compilación SEA finalizada.');
}

main().catch((err) => {
  console.error('\n✖ Error durante la compilación SEA:', err.message || err);
  process.exit(1);
});
