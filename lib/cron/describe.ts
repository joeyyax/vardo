// Plain-English cron schedules for the common shapes; anything else stays as the expression.

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

const isNum = (v: string) => /^\d+$/.test(v);
const pad = (n: string) => n.padStart(2, "0");

export function describeSchedule(expression: string): string {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) return expression;
  const [min, hour, dom, month, dow] = parts;
  const everyDay = dom === "*" && month === "*";

  if (everyDay && dow === "*") {
    if (min === "*" && hour === "*") return "every minute";
    const step = min.match(/^\*\/(\d+)$/);
    if (step && hour === "*") return step[1] === "1" ? "every minute" : `every ${step[1]} minutes`;
    if (isNum(min) && hour === "*") return min === "0" ? "every hour" : `every hour at :${pad(min)}`;
    const hourStep = hour.match(/^\*\/(\d+)$/);
    if (isNum(min) && hourStep) return `every ${hourStep[1]} hours at :${pad(min)}`;
    if (isNum(min) && isNum(hour)) return `daily at ${pad(hour)}:${pad(min)}`;
  }
  if (everyDay && isNum(dow) && isNum(min) && isNum(hour) && DAYS[Number(dow) % 7]) {
    return `${DAYS[Number(dow) % 7]}s at ${pad(hour)}:${pad(min)}`;
  }
  if (isNum(dom) && month === "*" && dow === "*" && isNum(min) && isNum(hour)) {
    return `monthly on day ${dom} at ${pad(hour)}:${pad(min)}`;
  }
  return expression;
}
