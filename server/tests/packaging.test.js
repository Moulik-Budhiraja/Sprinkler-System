import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

const read = (name) => fs.readFile(new URL(`../${name}`, import.meta.url), "utf8");

test("container packaging is pinned, lockfile-based, non-root, healthchecked and minimal", async () => {
  const [dockerfile, compose, ignore] = await Promise.all([read("Dockerfile"), read("docker-compose.yml"), read(".dockerignore")]);
  assert.match(dockerfile, /^FROM node:22\.14\.0-alpine3\.21/m);
  assert.match(dockerfile, /RUN npm ci --omit=dev/);
  assert.match(dockerfile, /^USER node$/m);
  assert.match(dockerfile, /^HEALTHCHECK /m);
  assert.doesNotMatch(dockerfile, /^COPY \. \.$/m);
  assert.match(compose, /127\.0\.0\.1:\$\{PORT:-5000\}:5000/);
  assert.match(compose, /no-new-privileges:true/);
  for (const excluded of ["tests/", "screenshots/", "data/", "node_modules/"]) assert.match(ignore, new RegExp(`^${excluded.replace("/", "\\/")}$`, "m"));
});
