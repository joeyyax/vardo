import { describe, it, expect } from "vitest";
import { describeSchedule } from "@/lib/cron/describe";

describe("describeSchedule", () => {
  it.each([
    ["* * * * *", "every minute"],
    ["*/15 * * * *", "every 15 minutes"],
    ["0 * * * *", "every hour"],
    ["30 * * * *", "every hour at :30"],
    ["5 */6 * * *", "every 6 hours at :05"],
    ["0 3 * * *", "daily at 03:00"],
    ["30 9 * * 1", "Mondays at 09:30"],
    ["0 4 1 * *", "monthly on day 1 at 04:00"],
    ["0 9-17 * * 1-5", "0 9-17 * * 1-5"],
  ])("%s", (expression, text) => {
    expect(describeSchedule(expression)).toBe(text);
  });
});
