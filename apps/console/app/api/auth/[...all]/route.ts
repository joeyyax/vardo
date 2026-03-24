import { auth } from "@/lib/auth";
import { toNextJsHandler } from "better-auth/next-js";
import { withRateLimit } from "@/lib/api/with-rate-limit";

const { GET: _GET, POST: _POST } = toNextJsHandler(auth);

// GET (session checks) passes through unrated — low abuse risk
export const GET = _GET;

// POST (login, signup, passkey) gets strict auth-tier rate limiting
export const POST = withRateLimit(_POST, { tier: "auth" });
