import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = path.resolve(serverRoot, "..");
const trackedDirectory = path.join(repositoryRoot, "screenshots", "v4-local");
const manifestPath = path.join(trackedDirectory, "release-screenshot-manifest.json");
const captureScript = path.join(serverRoot, "scripts", "capture-release-screenshots.mjs");
const sha256 = (buffer) => crypto.createHash("sha256").update(buffer).digest("hex");

async function trackedSnapshot() {
  const { stdout } = await execFileAsync("git", ["ls-files", "-z"], {
    cwd: repositoryRoot,
    encoding: "buffer",
  });
  const files = stdout.toString().split("\0").filter(Boolean);
  return Object.fromEntries(await Promise.all(files.map(async (file) => [
    file,
    sha256(await fs.readFile(path.join(repositoryRoot, file))),
  ])));
}

const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "sprinkler-release-verification-"));
await fs.chmod(temporaryRoot, 0o700);
const trackedBefore = await trackedSnapshot();

async function capture(label) {
  const outputDirectory = path.join(temporaryRoot, label);
  const { stdout } = await execFileAsync(process.execPath, [captureScript, `--output=${outputDirectory}`], {
    cwd: serverRoot,
    timeout: 90_000,
    maxBuffer: 1024 * 1024,
  });
  const report = JSON.parse(stdout);
  assert.equal(report.mode, "read-only output");
  assert.equal(path.resolve(report.outputDirectory), outputDirectory);
  return outputDirectory;
}

try {
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  const names = Object.keys(manifest.artifacts).sort();
  assert.equal(names.length, 5);
  const [first, second] = [await capture("first"), await capture("second")];
  for (const name of names) {
    const [firstBytes, secondBytes, trackedBytes] = await Promise.all([
      fs.readFile(path.join(first, name)),
      fs.readFile(path.join(second, name)),
      fs.readFile(path.join(trackedDirectory, name)),
    ]);
    const firstDigest = sha256(firstBytes);
    assert.equal(firstDigest, sha256(secondBytes), `${name} differs between clean recaptures`);
    assert.equal(firstDigest, sha256(trackedBytes), `${name} differs from reviewed manifest artifact`);
    assert.equal(firstDigest, manifest.artifacts[name].sha256, `${name} differs from reviewed manifest digest`);
  }

  const negative = Buffer.from(await fs.readFile(path.join(first, names[0])));
  negative[negative.length - 1] ^= 1;
  assert.equal(negative.equals(await fs.readFile(path.join(second, names[0]))), false,
    "negative byte-comparison control must detect a changed artifact");
  assert.deepEqual(await trackedSnapshot(), trackedBefore, "read-only recaptures changed tracked files");
  console.log("negative byte-comparison control detected");
  console.log(`verified ${names.length} artifacts across 2 byte-identical read-only recaptures`);
} finally {
  await fs.rm(temporaryRoot, { recursive: true, force: true });
}
