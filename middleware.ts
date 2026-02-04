import { NextRequest, NextResponse } from "next/server";
import { getSessionCookie } from "better-auth/cookies";

// Routes that require authentication
const protectedRoutes = ["/track", "/reports", "/clients", "/projects", "/settings"];

// Routes that should redirect to app if already authenticated
const authRoutes = ["/login", "/signup"];

export async function middleware(request: NextRequest) {
  const sessionCookie = getSessionCookie(request);
  const { pathname } = request.nextUrl;

  // Check if this is a protected route
  const isProtectedRoute = protectedRoutes.some(
    (route) => pathname === route || pathname.startsWith(`${route}/`)
  );

  // Check if this is an auth route
  const isAuthRoute = authRoutes.some(
    (route) => pathname === route || pathname.startsWith(`${route}/`)
  );

  // Redirect authenticated users away from auth pages
  if (sessionCookie && isAuthRoute) {
    return NextResponse.redirect(new URL("/track", request.url));
  }

  // Redirect unauthenticated users to login
  if (!sessionCookie && isProtectedRoute) {
    const loginUrl = new URL("/login", request.url);
    // Preserve the intended destination for post-login redirect
    loginUrl.searchParams.set("callbackUrl", pathname);
    return NextResponse.redirect(loginUrl);
  }

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
    "/login/:path*",
    "/signup/:path*",
  ],
};
