import { promises as fs } from "node:fs";
import net from "node:net";
import path from "node:path";

// Pause the cancelling kill with a fresh receipt, then let stop reach deletion. Without serialization,
// the receipt writer recreates an entry after recursive removal has enumerated and removed the old entries.
const { DELETE_RACE_DIR: dir, DELETE_RACE_SESSION: session, DELETE_RACE_ROLE: role } = process.env;
const original = { rm: fs.rm, writeFile: fs.writeFile, rename: fs.rename, listen: net.Server.prototype.listen };
const marker = (name) => path.join(dir, name);
const exists = (name) => fs.stat(marker(name)).then(() => true, () => false);
const mark = (name) => original.writeFile(marker(name), "reached");
async function wait(name) {
  const deadline = Date.now() + 15_000;
  while (!(await exists(name))) {
    if (Date.now() >= deadline) throw new Error(`Timed out at deletion barrier: ${name}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
async function beforeDeletion() { await mark("deletion"); await wait("writer"); }

if (role === "fault") {
  let held = false;
  fs.writeFile = async (file, data, options) => {
    if (String(file).startsWith(path.join(session, "receipt.json."))) {
      const receipt = JSON.parse(data);
      if (receipt.state === "stopping" && !receipt.faults?.length) {
        held = true;
        await mark("writer");
        await wait("release");
      }
    }
    return original.writeFile(file, data, options);
  };
  fs.rename = async (from, to) => {
    await original.rename(from, to);
    if (held && String(to) === path.join(session, "receipt.json")) await mark("written");
  };
}
if (role === "stop") {
  let stopping = false;
  fs.rename = async (from, to) => {
    await original.rename(from, to);
    if (String(to) === path.join(session, "receipt.json")) stopping = true;
  };
  net.Server.prototype.listen = function (...args) {
    if (!stopping) return original.listen.apply(this, args);
    void (async () => {
      await beforeDeletion(); await mark("deletion-lock");
      original.listen.apply(this, args);
    })().catch((error) => this.emit("error", error));
    return this;
  };
  fs.rm = async (target, options) => {
    if (String(target) !== session) return original.rm(target, options);
    await beforeDeletion();
    for (const entry of await fs.readdir(session)) await original.rm(path.join(session, entry), { recursive: true, force: true });
    await mark("empty");
    await wait("written");
    return fs.rmdir(session);
  };
}
