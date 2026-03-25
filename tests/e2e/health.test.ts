import { test, expect } from "@playwright/test";

test("GET /api/health returns 200 with status ok", async ({ request }) => {
  const response = await request.get("/api/health");
  expect(response.status()).toBe(200);

  const body = await response.json();
  expect(body.status).toBe("ok");
  expect(body.services).toBeDefined();
  expect(body.services.postgres).toBe("ok");
  expect(body.services.redis).toBe("ok");
});
