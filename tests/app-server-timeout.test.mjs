import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { CodexAppServerClient } from "../plugins/codex/scripts/lib/app-server.mjs";

function tempSocketDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cxc-timeout-"));
}

test("request() rejects when the broker accepts but never replies (no hang)", async () => {
  const dir = tempSocketDir();
  const sockPath = path.join(dir, "broker.sock");
  const server = net.createServer((socket) => {
    // Accept the connection, swallow all data, never respond — Mode E hang.
    socket.on("data", () => {});
    socket.on("error", () => {});
  });
  await new Promise((resolve) => server.listen(sockPath, resolve));

  const start = Date.now();
  await assert.rejects(
    CodexAppServerClient.connect(dir, {
      brokerEndpoint: `unix:${sockPath}`,
      requestTimeoutMs: 200,
      connectTimeoutMs: 1000
    }),
    /timed out/i
  );
  const elapsed = Date.now() - start;
  assert.ok(elapsed < 3000, `expected a fast bounded timeout, took ${elapsed}ms`);

  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(dir, { recursive: true, force: true });
});

test("request() rejects when the broker socket has no listener (connect bounded)", async () => {
  const dir = tempSocketDir();
  const sockPath = path.join(dir, "broker.sock");
  // No server: a missing unix socket yields ENOENT/ECONNREFUSED, which must
  // surface as a rejection, never a hang.
  await assert.rejects(
    CodexAppServerClient.connect(dir, {
      brokerEndpoint: `unix:${sockPath}`,
      requestTimeoutMs: 1000,
      connectTimeoutMs: 500
    })
  );
  fs.rmSync(dir, { recursive: true, force: true });
});
