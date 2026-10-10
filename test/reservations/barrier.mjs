import { promises as fs } from "node:fs";
import net from "node:net";
import path from "node:path";

const mkdir = fs.mkdir;
fs.mkdir = async (...args) => {
  const result = await mkdir(...args);
  if (process.env.RESERVATION_BARRIER === "pause" && /[/\\]sessions[/\\][0-9a-f-]{36}[/\\]data$/.test(String(args[0]))) {
    const released = new Promise((resolve) => process.once("message", resolve));
    process.send({ event: "reserved", dir: String(args[0]) });
    await released;
  }
  return result;
};

for (const [method, mode, event] of [["rm", "pause-remove", "removing"], ["readdir", "pause-scan", "scanning"]]) {
  const original = fs[method];
  fs[method] = async (...args) => {
    if (process.env.RESERVATION_BARRIER === mode && /[/\\]sessions[/\\][0-9a-f-]{36}$/.test(String(args[0]))) {
      const released = new Promise((resolve) => process.once("message", resolve));
      process.send({ event, dir: String(args[0]) });
      await released;
    }
    return original(...args);
  };
}

const rename = fs.rename;
fs.rename = async (...args) => {
  if (process.env.RESERVATION_BARRIER === "pause-write" && String(args[1]).endsWith("/receipt.json")) {
    const released = new Promise((resolve) => process.once("message", resolve));
    process.send({ event: "reserved", dir: path.join(path.dirname(String(args[1])), "data") });
    await released;
  }
  const result = await rename(...args);
  if (process.env.RESERVATION_BARRIER === "pause" && String(args[1]).endsWith("/receipt.json")) {
    process.send({ event: "published" });
  }
  return result;
};

const listen = net.Server.prototype.listen;
net.Server.prototype.listen = function (...args) {
  if (process.env.RESERVATION_BARRIER === "observe") {
    this.once("error", (error) => {
      if (error.code === "EADDRINUSE") process.send({ event: "waiting" });
    });
  }
  return listen.apply(this, args);
};
