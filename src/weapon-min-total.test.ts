/**
 * weapon-min-total.test.ts
 *
 * A rate Weapon over a thin $ST-v window fires on noise: one failed row reads as
 * pass_rate 0. `minTotal` skips the Weapon until the window holds enough rows.
 * Without it the behaviour is unchanged.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { Bot } from "./bot.js";
import { SimpleMonitor } from "./monitor.js";
import { PostBox } from "./postbox.js";
import { IPool } from "./i-pool.js";
import type { AgentProfile, Weapon } from "./types.js";
import type { StVRow } from "./st-collector.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function setup(weapons: Weapon[], trigger: AgentProfile["trigger"] = { mode: "any" }) {
  const monitor = new SimpleMonitor();
  const ipool = new IPool();
  const profile: AgentProfile = { id: "p1", botId: "bot://1", model: "rule", weapons, trigger };
  const bot = new Bot(monitor, new PostBox(), ipool, profile);
  bot.start();

  async function window(pass: number, fail: number): Promise<number> {
    const total = pass + fail;
    const row: StVRow = ["$ST-v", "s:v1", pass, fail, total, pass / total, 1000];
    monitor.emit({ type: "st_v", schemaId: "s:v1", ts: 0, payload: row });
    await new Promise((r) => setImmediate(r));   // Bot evaluates asynchronously
    return ipool.drain().length;
  }

  return { window };
}

const LOW_PASS: Weapon = { name: "low_pass", metric: "pass_rate", op: "<", threshold: 0.8, weight: 1 };

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("Weapon minTotal", () => {
  it("without minTotal, a single failed row fires (unchanged default)", async () => {
    const { window } = setup([LOW_PASS]);
    assert.equal(await window(0, 1), 1);
  });

  it("skips the Weapon while the window holds fewer rows than minTotal", async () => {
    const { window } = setup([{ ...LOW_PASS, minTotal: 20 }]);
    assert.equal(await window(0, 1), 0, "1 row");
    assert.equal(await window(10, 9), 0, "19 rows");
  });

  it("fires once the window reaches minTotal", async () => {
    const { window } = setup([{ ...LOW_PASS, minTotal: 20 }]);
    assert.equal(await window(10, 10), 1, "20 rows at pass_rate 0.5");
    assert.equal(await window(19, 1), 0, "20 rows at pass_rate 0.95 does not fire");
  });

  it("a skipped Weapon counts as not fired under trigger all", async () => {
    const fail: Weapon = { name: "fail", metric: "fail", op: ">=", threshold: 1, weight: 1 };
    const { window } = setup([fail, { ...LOW_PASS, minTotal: 20 }], { mode: "all" });
    assert.equal(await window(0, 1), 0);
    assert.equal(await window(10, 10), 1);
  });
});
