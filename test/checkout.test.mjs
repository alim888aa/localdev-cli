import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { projectRoot } from "../dist/checkout.js";

test("projectRoot makes a symlinked checkout and its target one project", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "localdev-checkout-"));
  try {
    const target = path.join(dir, "target");
    const alias = path.join(dir, "alias");
    await mkdir(target);
    await symlink(target, alias, "dir");
    const canonical = await realpath(target);
    assert.equal(await projectRoot(alias), canonical);
    assert.equal(await projectRoot(target), canonical);
    const missing = path.join(dir, "gone");
    assert.equal(await projectRoot(missing), missing, "an unresolvable checkout stays as given");
    await assert.rejects(projectRoot(missing, { mustExist: true }), { code: "ENOENT" });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
