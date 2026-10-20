import type { ReceivedEnvelope } from "@openma/matter-host-local/runtime";
import { describe, expect, it } from "vitest";
import {
  makeScheduleSource,
  nextFire,
  SCHEDULE_TICK,
  scheduledLoop,
  scheduleProblem,
  type ScheduleTimers,
} from "../src/schedule.js";
import { feishuScheduledReport } from "../src/templates/feishu-report.js";

describe("schedules", () => {
  it("reads a cron expression in its time zone", () => {
    const after = new Date("2026-10-20T03:00:00Z");
    expect(nextFire("0 10 * * *", "Asia/Shanghai", after).toISOString()).toBe("2026-10-21T02:00:00.000Z");
    expect(nextFire("0 10 * * 1-5", "UTC", new Date("2026-10-23T11:00:00Z")).toISOString()).toBe(
      "2026-10-26T10:00:00.000Z",
    );
  });

  it("explains a bad schedule or time zone", () => {
    expect(scheduleProblem("0 10 * * *", "Asia/Shanghai")).toBeUndefined();
    expect(scheduleProblem("", "UTC")).toBe("Schedule is required");
    expect(scheduleProblem("0 10 * *", "UTC")).toMatch(/five fields/);
    expect(scheduleProblem("0 25 * * *", "UTC")).toMatch(/Invalid schedule/);
    expect(scheduleProblem("0 10 * * *", "Mars/Base")).toBe("Unknown time zone Mars/Base");
  });

  it("gives each scheduled Loop its own tick type", () => {
    const loop = scheduledLoop(feishuScheduledReport, "loop-1");
    expect((loop.definition.spec as { sources: string[] }).sources).toEqual(["schedule.loop-1.tick"]);
    const registered: string[] = [];
    loop.install(
      {
        on(types) {
          registered.push(...(typeof types === "string" ? [types] : types));
          return this;
        },
      },
      { config: { agentId: "a", chats: ["chat:oc_1"], task: "t", sessionScope: "request" } },
    );
    expect(registered).toEqual(["schedule.loop-1.tick"]);
    expect(registered).not.toContain(SCHEDULE_TICK);
  });

  it("fires at each scheduled time with a key replicas share, and stops", async () => {
    let now = Date.parse("2026-10-20T09:59:00Z");
    const pending: { callback: () => void; at: number }[] = [];
    const timers: ScheduleTimers = {
      now: () => now,
      setTimeout: (callback, ms) => {
        const entry = { callback, at: now + ms };
        pending.push(entry);
        return entry;
      },
      clearTimeout: (handle) => {
        const i = pending.indexOf(handle as (typeof pending)[number]);
        if (i >= 0) pending.splice(i, 1);
      },
    };
    const source = makeScheduleSource({
      schedules: [{ loopId: "loop-1", schedule: "0 10 * * *", timezone: "UTC" }],
      authority: "cli_1",
      timers,
    });
    const envelopes: ReceivedEnvelope[] = [];
    await source.start(async (envelope) => {
      envelopes.push(envelope);
    });
    expect(pending.map((p) => p.at - now)).toEqual([60_000]);
    // A timer that wakes early waits again instead of firing.
    pending.shift()!.callback();
    expect(envelopes).toHaveLength(0);
    now = Date.parse("2026-10-20T10:00:00Z");
    pending.shift()!.callback();
    expect(envelopes).toEqual([
      {
        integrationId: "schedule",
        idempotencyKey: "schedule:loop-1:2026-10-20T10:00:00.000Z",
        eventType: "schedule.loop-1.tick",
        body: { loopId: "loop-1", scheduledAt: "2026-10-20T10:00:00.000Z", authority: "cli_1" },
      },
    ]);
    expect(pending.map((p) => new Date(p.at).toISOString())).toEqual(["2026-10-21T10:00:00.000Z"]);
    await source.stop();
    expect(pending).toEqual([]);
  });
});
