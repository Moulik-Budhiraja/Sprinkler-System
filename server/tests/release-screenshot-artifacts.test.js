import assert from "node:assert/strict";
import { execFile } from "node:child_process";
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
  "desktop-1440-copy.png": [1440, 937],
  "desktop-1440-standalone.png": [1440, 965],
  "mobile-844-copy.png": [390, 1047],
  "mobile-1067-copy.png": [390, 1067],
  "mobile-390x844-standalone.png": [390, 1047],
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

test("tracked V4 release screenshots match the reviewed artifact manifest", async () => {
  const manifest = JSON.parse(await fs.readFile(manifestUrl, "utf8"));
  assert.equal(manifest.route, "/");
  assert.equal(manifest.state, "explicit synthetic demo with deterministic clean browser context");
  assert.deepEqual(manifest.requiredVisibleText, [
    "Living Yard", "Sprinkler system", "Status", "Quick Task", "5m", "15m", "30m", "60m", "Schedules", "History",
  ]);
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
  for (const text of ["5m", "15m", "30m", "60m", "Status", "Morning lawn", "Started", "Zones 1, 2", "Schedule"]) {
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
