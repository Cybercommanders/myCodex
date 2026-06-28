import test from "node:test";
import assert from "node:assert/strict";

import { createIdleWatchdog } from "../plugins/codex/scripts/app-server-broker.mjs";

test("idle watchdog fires onIdle after the window and re-arms on activity", () => {
  let scheduled = null;
  let clears = 0;
  let fired = 0;

  const wd = createIdleWatchdog({
    idleMs: 100,
    onIdle: () => {
      fired += 1;
    },
    setTimer: (fn, ms) => {
      scheduled = { fn, ms };
      return { unref() {} };
    },
    clearTimer: () => {
      clears += 1;
    }
  });

  wd.arm();
  assert.equal(scheduled.ms, 100, "arms with the configured idle window");

  wd.arm(); // simulated activity resets the timer
  assert.equal(clears, 1, "activity clears the prior timer before re-arming");

  scheduled.fn(); // the timer fires
  assert.equal(fired, 1, "onIdle runs when the window elapses");
});

test("idle watchdog is disabled when idleMs <= 0", () => {
  let scheduled = false;
  const wd = createIdleWatchdog({
    idleMs: 0,
    onIdle: () => {},
    setTimer: () => {
      scheduled = true;
      return { unref() {} };
    },
    clearTimer: () => {}
  });

  wd.arm();
  assert.equal(scheduled, false, "no timer armed when disabled");
});
