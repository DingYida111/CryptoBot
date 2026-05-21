import test from "node:test";
import assert from "node:assert/strict";

import { computeReentryBlockUntil, resolveReentryGate, type ChopGridSnapshot } from "../chop_grid.js";

test("loss exit uses longer reentry cooldown", () => {
  const blockedUntil = computeReentryBlockUntil(
    {
      reentryCooldownMs: 180_000,
      lossReentryCooldownMs: 900_000,
    },
    "inventory_depleted_loss",
    -12.5,
    1_000,
  );

  assert.equal(blockedUntil, 901_000);
});

test("same-window adverse exit blocks reseed even after cooldown", () => {
  const snapshot: Pick<ChopGridSnapshot, "reentryBlockedUntil" | "lastExitReason" | "lastExitWindowEndTs"> = {
    reentryBlockedUntil: 0,
    lastExitReason: "force_exit",
    lastExitWindowEndTs: 2_000,
  };

  const gate = resolveReentryGate(
    snapshot,
    { sameWindowReentryBlock: true },
    5_000,
    2_000,
  );

  assert.equal(gate.blocked, true);
  assert.match(gate.reason, /same_window_reentry_block/);
});

test("next window reopens grid after adverse exit", () => {
  const snapshot: Pick<ChopGridSnapshot, "reentryBlockedUntil" | "lastExitReason" | "lastExitWindowEndTs"> = {
    reentryBlockedUntil: 0,
    lastExitReason: "force_exit",
    lastExitWindowEndTs: 2_000,
  };

  const gate = resolveReentryGate(
    snapshot,
    { sameWindowReentryBlock: true },
    5_000,
    3_000,
  );

  assert.deepEqual(gate, { blocked: false, reason: "reentry_open" });
});
