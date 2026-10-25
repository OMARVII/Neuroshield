#!/usr/bin/env node
/**
 * Package the extension for the Chrome Web Store.
 *
 *   npm run build            → dist/neuroshield-<version>.zip
 *   npm run build -- --check → only validate (used in CI)
 *
 * Checks that manifest.json and package.json agree on the version, that
 * every file the manifest and the extension pages reference exists, and that
 * nothing outside the shipped folders sneaks into the package.
 */
const { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, existsSync } = require('node:fs');
const { join, relative, dirname, posix } = require('node:path');
const zlib = require('node:zlib');

const ROOT = join(__dirname, '..');
const SHIPPED = ['manifest.json', 'src', 'icons'];
const EXCLUDE = [/^icons\/source\//, /\.DS_Store$/];

function fail(message) {
  console.error(`✖ ${message}`);
  process.exitCode = 1;
}

function walk(path) {
  const full = join(ROOT, path);
  if (statSync(full).isFile()) return [path];
  return readdirSync(full).flatMap((name) => walk(posix.join(path, name)));
}

function shippedFiles() {
  return SHIPPED.flatMap(walk)
    .filter((f) => !EXCLUDE.some((re) => re.test(f)))
    .sort();
}

/** Files referenced by the manifest and by <script>/<link>/<img> in shipped HTML. */
function referencedFiles(manifest) {
  const refs = new Set(['manifest.json']);
  const add = (f) => f && refs.add(f.replace(/^\//, ''));
  add(manifest.background.service_worker);
  for (const cs of manifest.content_scripts) [...cs.js, ...(cs.css || [])].forEach(add);
  add(manifest.action.default_popup);
  add(manifest.options_ui.page);
  Object.values(manifest.icons).forEach(add);
  Object.values(manifest.action.default_icon).forEach(add);

  for (const page of [manifest.action.default_popup, manifest.options_ui.page]) {
    const html = readFileSync(join(ROOT, page), 'utf8');
    for (const [, url] of html.matchAll(/(?:src|href)="([^"#:]+)"/g)) add(posix.normalize(posix.join(posix.dirname(page), url)));
  }

  const worker = readFileSync(join(ROOT, manifest.background.service_worker), 'utf8');
  const imports = /importScripts\(([^)]*)\)/.exec(worker);
  if (imports) {
    for (const [, url] of imports[1].matchAll(/'([^']+)'/g)) add(posix.normalize(posix.join(posix.dirname(manifest.background.service_worker), url)));
  }
  for (const [, path] of worker.matchAll(/'(\/icons\/[^']+)'/g)) add(path);
  return [...refs].sort();
}

// ─── Minimal ZIP writer (deflate) ──────────────────────────────────────

const CRC_TABLE = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function zip(entries) {
  const chunks = [];
  const central = [];
  let offset = 0;
  // Fixed timestamp (1980-01-01) so the same sources always give the same zip.
  const DOS_TIME = 0;
  const DOS_DATE = (1 << 5) | 1;
  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const deflated = zlib.deflateRawSync(data, { level: 9 });
    const useDeflate = deflated.length < data.length;
    const body = useDeflate ? deflated : data;
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(useDeflate ? 8 : 0, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    chunks.push(local, nameBuf, body);

    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(20, 6);
    header.writeUInt16LE(0x0800, 8);
    header.writeUInt16LE(useDeflate ? 8 : 0, 10);
    header.writeUInt16LE(DOS_TIME, 12);
    header.writeUInt16LE(DOS_DATE, 14);
    header.writeUInt32LE(crc, 16);
    header.writeUInt32LE(body.length, 20);
    header.writeUInt32LE(data.length, 24);
    header.writeUInt16LE(nameBuf.length, 28);
    header.writeUInt32LE(offset, 42);
    central.push(header, nameBuf);
    offset += local.length + nameBuf.length + body.length;
  }
  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, centralBuf, end]);
}

// ─── Main ──────────────────────────────────────────────────────────────

const manifest = JSON.parse(readFileSync(join(ROOT, 'manifest.json'), 'utf8'));
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

if (manifest.version !== pkg.version) fail(`manifest.json version ${manifest.version} ≠ package.json version ${pkg.version}`);

const files = shippedFiles();
for (const ref of referencedFiles(manifest)) {
  if (!existsSync(join(ROOT, ref))) fail(`referenced file is missing: ${ref}`);
  else if (!files.includes(ref)) fail(`referenced file is not shipped: ${ref}`);
}

if (process.exitCode) process.exit();

if (process.argv.includes('--check')) {
  console.log(`✓ NeuroShield ${manifest.version}: ${files.length} files, manifest references all present`);
} else {
  const out = join(ROOT, 'dist', `neuroshield-${manifest.version}.zip`);
  mkdirSync(dirname(out), { recursive: true });
  const archive = zip(files.map((name) => ({ name, data: readFileSync(join(ROOT, name)) })));
  writeFileSync(out, archive);
  console.log(`✓ ${relative(ROOT, out)} (${files.length} files, ${(archive.length / 1024).toFixed(1)} KB)`);
}
