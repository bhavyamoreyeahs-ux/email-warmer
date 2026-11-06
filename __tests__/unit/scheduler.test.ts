import { describe, expect, it } from "vitest";
import { crossedBoundary } from "@/lib/jobs/scheduler";

describe("scheduler period boundaries", () => {
  const t = (iso: string) => new Date(iso);
  it("fires once per period even when ticks drift past the exact minute", () => {
    expect(crossedBoundary(t("2026-10-31T10:04:59Z"), t("2026-10-31T10:06:01Z"), 5)).toBe(true);
    expect(crossedBoundary(t("2026-10-31T10:05:01Z"), t("2026-10-31T10:06:02Z"), 5)).toBe(false);
  });
  it("supports daily schedules with an offset (03:00 UTC)", () => {
    expect(crossedBoundary(t("2026-10-31T02:59:30Z"), t("2026-10-31T03:00:31Z"), 1440, 180)).toBe(true);
    expect(crossedBoundary(t("2026-10-31T03:00:31Z"), t("2026-10-31T03:01:33Z"), 1440, 180)).toBe(false);
  });
  it("treats the first tick as due", () => {
    expect(crossedBoundary(null, new Date(), 60)).toBe(true);
  });
});
