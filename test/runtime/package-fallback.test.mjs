import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const fallback = new URL(
  "../../runtime/host/package-fallback.mjs",
  import.meta.url,
).href;

async function importFrom(t, files) {
  const dir = await mkdtemp(join(tmpdir(), "mf-fallback-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  for (const [name, text] of Object.entries(files)) {
    await mkdir(join(dir, name, ".."), { recursive: true });
    await writeFile(join(dir, name), text);
  }
  const script = `const { installPackageFallback } = await import(${JSON.stringify(fallback)}); installPackageFallback(); const m = await import(${JSON.stringify(join(dir, "program.mjs"))}); console.log(JSON.stringify(m.default));`;
  return promisify(execFile)(
    process.execPath,
    ["--input-type=module", "-e", script],
    { cwd: dir },
  );
}

test("a module outside the package imports the toolkit's own dependencies", async (t) => {
  const { stdout } = await importFrom(t, {
    "program.mjs":
      'import { Vec3 } from "vec3"; import pathfinder from "mineflayer-pathfinder"; export default [new Vec3(1, 2, 3).toString(), typeof pathfinder.pathfinder];',
  });
  assert.deepEqual(JSON.parse(stdout), ["(1, 2, 3)", "function"]);
});

test("a package next to the module still wins, and missing files still fail", async (t) => {
  const { stdout } = await importFrom(t, {
    "node_modules/vec3/package.json":
      '{"name":"vec3","type":"module","exports":"./index.js"}',
    "node_modules/vec3/index.js": 'export const Vec3 = "local";',
    "program.mjs": 'import { Vec3 } from "vec3"; export default Vec3;',
  });
  assert.equal(JSON.parse(stdout), "local");
  await assert.rejects(
    importFrom(t, {
      "program.mjs": 'import "./missing.mjs"; export default 1;',
    }),
    /ERR_MODULE_NOT_FOUND/,
  );
  await assert.rejects(
    importFrom(t, {
      "program.mjs": 'import "no-such-package-anywhere"; export default 1;',
    }),
    /ERR_MODULE_NOT_FOUND/,
  );
});
