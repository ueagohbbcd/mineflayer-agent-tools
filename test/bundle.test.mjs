import test from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildBundle } from "../scripts/build-bundle.mjs";

const bundle = fileURLToPath(
  new URL("../bundle/mineflayer-agent/", import.meta.url),
);

test("bundle/mineflayer-agent is up to date with skills/ (npm run build:bundle)", async () => {
  const files = await buildBundle();
  const written = (
    await readdir(bundle, { recursive: true, withFileTypes: true })
  )
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name).slice(bundle.length))
    .sort();
  assert.deepEqual(written, [...files.keys()].sort());
  for (const [path, text] of files)
    assert.equal(await readFile(join(bundle, path), "utf8"), text, path);
});
