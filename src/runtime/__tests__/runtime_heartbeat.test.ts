import test from "node:test";
import assert from "node:assert/strict";

import { evaluateRuntimeHeartbeat } from "../runtime_heartbeat.js";
import type { RuntimeAgentHeartbeatRow, RuntimeMaintenanceLeaseRow } from "../../monitor/storage.js";

function heartbeat(lastHeartbeatAt: number): RuntimeAgentHeartbeatRow {
  return {
    agent_id: "cryptobot-supervisor",
    role: "strategy_supervisor",
    pid: 123,
    hostname: "test-host",
    commit_sha: "abc123",
    status: "running",
    metadata_json: "{}",
    last_heartbeat_at: lastHeartbeatAt,
    created_at: lastHeartbeatAt,
    updated_at: lastHeartbeatAt,
  };
}

function lease(now: number, expiresAt: number): RuntimeMaintenanceLeaseRow {
  return {
    lease_id: "lease-1",
    agent_id: "cryptobot-supervisor",
    reason: "planned_deploy",
    active: 1,
    metadata_json: "{}",
    starts_at: now - 1_000,
    expires_at: expiresAt,
    created_at: now - 1_000,
    updated_at: now - 1_000,
  };
}

test("runtime heartbeat is healthy inside stale threshold", () => {
  const now = 200_000;
  const result = evaluateRuntimeHeartbeat({
    agentId: "cryptobot-supervisor",
    heartbeat: heartbeat(now - 10_000),
    maintenanceLease: null,
    now,
    staleAfterMs: 60_000,
    disconnectAfterMs: 120_000,
    maintenanceGraceMs: 120_000,
  });

  assert.equal(result.status, "healthy");
  assert.equal(result.message.category, "info");
  assert.equal(result.message.code, "AGENT_HEARTBEAT_OK");
});

test("runtime heartbeat stale warning precedes disconnect threshold", () => {
  const now = 200_000;
  const result = evaluateRuntimeHeartbeat({
    agentId: "cryptobot-supervisor",
    heartbeat: heartbeat(now - 90_000),
    maintenanceLease: null,
    now,
    staleAfterMs: 60_000,
    disconnectAfterMs: 120_000,
    maintenanceGraceMs: 120_000,
  });

  assert.equal(result.status, "stale");
  assert.equal(result.message.category, "warning");
  assert.equal(result.message.notify, false);
});

test("runtime heartbeat disconnect emits major error", () => {
  const now = 200_000;
  const result = evaluateRuntimeHeartbeat({
    agentId: "cryptobot-supervisor",
    heartbeat: heartbeat(now - 121_000),
    maintenanceLease: null,
    now,
    staleAfterMs: 60_000,
    disconnectAfterMs: 120_000,
    maintenanceGraceMs: 120_000,
    affectedInstrumentIds: ["BTC-USDT", "BTC-USDT-SWAP"],
  });

  assert.equal(result.status, "disconnected");
  assert.equal(result.message.category, "major_error");
  assert.equal(result.message.notify, true);
  assert.equal(result.message.code, "AGENT_HEARTBEAT_DISCONNECTED");
  assert.deepEqual(result.message.affectedInstrumentIds, ["BTC-USDT", "BTC-USDT-SWAP"]);
});

test("runtime maintenance lease prevents disconnect during grace window", () => {
  const now = 200_000;
  const result = evaluateRuntimeHeartbeat({
    agentId: "cryptobot-supervisor",
    heartbeat: heartbeat(now - 180_000),
    maintenanceLease: lease(now, now + 30_000),
    now,
    staleAfterMs: 60_000,
    disconnectAfterMs: 120_000,
    maintenanceGraceMs: 120_000,
  });

  assert.equal(result.status, "maintenance_grace");
  assert.equal(result.message.category, "warning");
  assert.equal(result.message.code, "AGENT_MAINTENANCE_ACTIVE");
});

test("expired maintenance grace still disconnects", () => {
  const now = 400_000;
  const result = evaluateRuntimeHeartbeat({
    agentId: "cryptobot-supervisor",
    heartbeat: heartbeat(now - 300_000),
    maintenanceLease: lease(now, now - 130_000),
    now,
    staleAfterMs: 60_000,
    disconnectAfterMs: 120_000,
    maintenanceGraceMs: 120_000,
  });

  assert.equal(result.status, "disconnected");
  assert.equal(result.message.category, "major_error");
});
