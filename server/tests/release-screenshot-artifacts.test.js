import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import { promisify } from "node:util";
import test from "node:test";
import zlib from "node:zlib";

const execFileAsync = promisify(execFile);

const repositoryRoot = new URL("../../", import.meta.url);
const artifactDirectory = new URL("screenshots/v4-local/", repositoryRoot);
const manifestUrl = new URL("release-screenshot-manifest.json", artifactDirectory);

const expectedArtifacts = {
  "desktop-1440-copy.png": [1440, 900],
  "desktop-1440-standalone.png": [1440, 900],
  "mobile-844-copy.png": [390, 1135],
  "mobile-1067-copy.png": [390, 1067],
  "mobile-390x844-standalone.png": [390, 844],
};

function parsePng(buffer) {
  assert.equal(buffer.subarray(0, 8).toString("hex"), "89504e470d0a1a0a", "PNG signature");
  let offset = 8;
  let width;
  let height;
  let bitDepth;
  let colorType;
  let interlace;
  const idat = [];
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.subarray(offset + 4, offset + 8).toString("ascii");
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === "IDAT") {
      idat.push(data);
    } else if (type === "IEND") {
      break;
    }
    offset += length + 12;
  }
  assert.equal(bitDepth, 8, "release PNGs use 8-bit channels");
  assert.ok(colorType === 2 || colorType === 6, "release PNGs use RGB or RGBA");
  assert.equal(interlace, 0, "release PNGs are not interlaced");
  const channels = colorType === 6 ? 4 : 3;
  const stride = width * channels;
  const encoded = zlib.inflateSync(Buffer.concat(idat));
  const previous = Buffer.alloc(stride);
  const row = Buffer.alloc(stride);
  const colors = new Set();
  let minimumLuminance = 255;
  let maximumLuminance = 0;
  let cursor = 0;
  const paeth = (a, b, c) => {
    const p = a + b - c;
    const pa = Math.abs(p - a);
    const pb = Math.abs(p - b);
    const pc = Math.abs(p - c);
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
  };
  for (let y = 0; y < height; y += 1) {
    const filter = encoded[cursor++];
    for (let x = 0; x < stride; x += 1) {
      const raw = encoded[cursor++];
      const left = x >= channels ? row[x - channels] : 0;
      const up = previous[x];
      const upperLeft = x >= channels ? previous[x - channels] : 0;
      const predictor = filter === 0 ? 0 : filter === 1 ? left : filter === 2 ? up :
        filter === 3 ? Math.floor((left + up) / 2) : filter === 4 ? paeth(left, up, upperLeft) : NaN;
      assert.ok(Number.isFinite(predictor), `supported PNG filter ${filter}`);
      row[x] = (raw + predictor) & 0xff;
    }
    for (let x = 0; x < width; x += Math.max(1, Math.floor(width / 80))) {
      const index = x * channels;
      const r = row[index];
      const g = row[index + 1];
      const b = row[index + 2];
      colors.add(`${r},${g},${b}`);
      const luminance = Math.round(0.2126 * r + 0.7152 * g + 0.0722 * b);
      minimumLuminance = Math.min(minimumLuminance, luminance);
      maximumLuminance = Math.max(maximumLuminance, luminance);
    }
    row.copy(previous);
  }
  return { width, height, colors: colors.size, luminanceRange: maximumLuminance - minimumLuminance };
}

test("every release artifact is semantically and byte distinct", async () => {
  // Five manifest entries must carry five different images: each artifact
  // declares its own (view, state, dimensions) tuple and the tracked bytes
  // must be pairwise distinct — a manifest that collapses to duplicate
  // images misrepresents its own coverage.
  const manifest = JSON.parse(await fs.readFile(manifestUrl, "utf8"));
  const seenTuples = new Set();
  const seenHashes = new Map();
  for (const name of Object.keys(expectedArtifacts)) {
    const entry = manifest.artifacts[name];
    assert.ok(entry.view, `${name} declares its view`);
    assert.ok(entry.state, `${name} declares its state`);
    const tuple = JSON.stringify([entry.view, entry.state, entry.dimensions]);
    assert.ok(!seenTuples.has(tuple), `${name} duplicates another artifact's declared view/state/dimensions`);
    seenTuples.add(tuple);
    const digest = crypto.createHash("sha256")
      .update(await fs.readFile(new URL(name, artifactDirectory))).digest("hex");
    assert.ok(!seenHashes.has(digest), `${name} is byte-identical to ${seenHashes.get(digest)}`);
    seenHashes.set(digest, name);
  }
});

test("tracked V4 release screenshots match the reviewed artifact manifest", async () => {
  const manifest = JSON.parse(await fs.readFile(manifestUrl, "utf8"));
  assert.equal(manifest.route, "/");
  assert.equal(manifest.state, "explicit synthetic demo with deterministic clean browser context");
  // Visible-text contracts are per-artifact (asserted in their own test):
  // a single global list falsely claimed desktop-only content for the
  // device-fold artifacts.
  assert.deepEqual(Object.keys(manifest.artifacts).sort(), Object.keys(expectedArtifacts).sort());

  for (const [name, dimensions] of Object.entries(expectedArtifacts)) {
    const bytes = await fs.readFile(new URL(name, artifactDirectory));
    const png = parsePng(bytes);
    assert.deepEqual([png.width, png.height], dimensions, `${name} dimensions`);
    assert.ok(png.colors >= 32, `${name} is visibly nonblank (${png.colors} sampled colors)`);
    assert.ok(png.luminanceRange >= 50, `${name} has meaningful contrast (${png.luminanceRange})`);
    assert.equal(crypto.createHash("sha256").update(bytes).digest("hex"), manifest.artifacts[name].sha256, `${name} reviewed digest`);
    assert.deepEqual(manifest.artifacts[name].dimensions, dimensions, `${name} manifest dimensions`);
  }
});

test("release capture is explicit, semantic-gated, and read-only unless requested", async () => {
  const source = await fs.readFile(new URL("../scripts/capture-release-screenshots.mjs", import.meta.url), "utf8");
  assert.match(source, /SPRINKLER_DEMO:\s*"1"/);
  assert.match(source, /SPRINKLER_PUBLIC_ORIGIN:\s*origin/);
  assert.match(source, /writeArtifacts\s*=\s*process\.argv\.includes\("--write"\)/);
  assert.match(source, /document\.fonts\.ready/);
  for (const text of ["5m", "15m", "30m", "60m", "Status", "Morning lawn", "Zones 1, 2 started", "Schedule"]) {
    assert.ok(source.includes(JSON.stringify(text)), `capture checks visible ${text}`);
  }
  for (const name of Object.keys(expectedArtifacts)) assert.ok(source.includes(JSON.stringify(name)), `capture defines ${name}`);
  assert.match(source, /addInitScript[\s\S]*Date\.now\s*=\s*\(\)\s*=>\s*fixedNowMs/,
    "capture freezes the browser clock to the seeded running-task instant");
  assert.doesNotMatch(source, /MICROCONTROLLER_HOST|\.launchPersistentContext\(/);
});

test("committed release validation performs two clean read-only recaptures against the manifest", async () => {
  const trackedBefore = await Promise.all(Object.keys(expectedArtifacts).map(async (name) =>
    crypto.createHash("sha256").update(await fs.readFile(new URL(name, artifactDirectory))).digest("hex")
  ));
  const { stdout } = await execFileAsync(process.execPath, ["scripts/verify-release-screenshots.mjs"], {
    cwd: new URL("../", import.meta.url),
    timeout: 120_000,
    maxBuffer: 1024 * 1024,
  });
  assert.match(stdout, /verified 5 artifacts across 2 byte-identical read-only recaptures/);
  assert.match(stdout, /negative byte-comparison control detected/);
  const trackedAfter = await Promise.all(Object.keys(expectedArtifacts).map(async (name) =>
    crypto.createHash("sha256").update(await fs.readFile(new URL(name, artifactDirectory))).digest("hex")
  ));
  assert.deepEqual(trackedAfter, trackedBefore, "validation must not write tracked screenshots");
});

test("read-only capture exits promptly after its final output (no lingering cleanup timer)", async () => {
  // Liveness: after the script prints its result and the demo server child
  // exits, nothing (e.g. an uncleared cleanup timeout) may keep the event
  // loop alive. The pre-repair race left its losing 5s timer referenced,
  // so a successful run lingered ~5s after the last byte of output.
  const child = spawn(process.execPath, ["scripts/capture-release-screenshots.mjs"],
    { cwd: fileURLToPath(new URL("../", import.meta.url)), stdio: ["ignore", "pipe", "pipe"] });
  let lastOutputAt = Date.now();
  child.stdout.on("data", () => { lastOutputAt = Date.now(); });
  child.stderr.on("data", () => { lastOutputAt = Date.now(); });
  const code = await new Promise((resolve) => child.once("exit", resolve));
  const exitDelay = Date.now() - lastOutputAt;
  assert.equal(code, 0, "read-only capture succeeds");
  assert.ok(exitDelay <= 2500, `process lingered ${exitDelay}ms after its final output`);
});

test("manifest declares truthful per-artifact visible text, gated within each captured region", async () => {
  const manifest = JSON.parse(await fs.readFile(manifestUrl, "utf8"));
  const source = await fs.readFile(new URL("../scripts/capture-release-screenshots.mjs", import.meta.url), "utf8");
  // The old global claim asserted text (e.g. "Living Yard", "History") that
  // device-fold artifacts do not contain; each artifact must declare its
  // own truthful list instead, and the capture must verify every entry
  // INSIDE that artifact's clip region — not merely somewhere on the page.
  assert.equal("requiredVisibleText" in manifest, false, "the untruthful global claim is gone");
  for (const name of Object.keys(expectedArtifacts)) {
    const entry = manifest.artifacts[name];
    assert.ok(Array.isArray(entry.requiredVisibleText) && entry.requiredVisibleText.length >= 3,
      `${name} declares its own visible-text contract`);
    for (const text of entry.requiredVisibleText) {
      assert.ok(source.includes(JSON.stringify(text)), `capture gates ${name}: ${JSON.stringify(text)}`);
    }
  }
  assert.match(source, /missingWithinClip/, "capture verifies text inside the clip region");
  assert.match(source, /DECOY/, "capture proves the in-clip checker can detect absent text");
});
