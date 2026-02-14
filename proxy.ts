import { NextRequest, NextResponse } from "next/server";
import { getSessionCookie } from "better-auth/cookies";

// Routes that require authentication AND organization membership
const protectedRoutes = ["/track", "/reports", "/clients", "/projects", "/settings"];

// Routes that require authentication but NOT organization membership
const authOnlyRoutes = ["/onboarding"];

// Routes that should redirect to app if already authenticated
const authRoutes = ["/login", "/signup"];

export async function proxy(request: NextRequest) {
  const sessionCookie = getSessionCookie(request);
  const { pathname } = request.nextUrl;

  // Check route types
  const isProtectedRoute = protectedRoutes.some(
    (route) => pathname === route || pathname.startsWith(`${route}/`)
  );

  const isAuthOnlyRoute = authOnlyRoutes.some(
    (route) => pathname === route || pathname.startsWith(`${route}/`)
  );

  const isAuthRoute = authRoutes.some(
    (route) => pathname === route || pathname.startsWith(`${route}/`)
  );

  // Redirect authenticated users away from auth pages
  if (sessionCookie && isAuthRoute) {
    return NextResponse.redirect(new URL("/track", request.url));
  }

  // Redirect unauthenticated users to login
  if (!sessionCookie && (isProtectedRoute || isAuthOnlyRoute)) {
    const loginUrl = new URL("/login", request.url);
    // Preserve the intended destination for post-login redirect
    loginUrl.searchParams.set("callbackUrl", pathname);
    return NextResponse.redirect(loginUrl);
  }

  // Note: Organization membership check is done at the layout/page level
  // because middleware can't easily do database queries.
  // The app layout and pages will redirect to /onboarding if no org.

  return NextResponse.next();
}

export const config = {
  // Apply middleware to protected and auth routes
  matcher: [
    "/track/:path*",
    "/reports/:path*",
    "/clients/:path*",
    "/projects/:path*",
    "/settings/:path*",
    "/onboarding/:path*",
    "/login/:path*",
    "/signup/:path*",
  ],
};
