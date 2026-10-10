import net from "node:net";

// Collision tests need app/web names for retry eligibility, but must not take client ports.
const listen = net.Server.prototype.listen;
net.Server.prototype.listen = function (...args) {
  const port = typeof args[0] === "object" ? args[0].port : args[0];
  if (port >= 3000 && port <= 3010) {
    queueMicrotask(() => this.emit("error", Object.assign(new Error("Client app range occupied in this test"), { code: "EADDRINUSE" })));
    return this;
  }
  return listen.apply(this, args);
};
