import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { NextResponse, type NextRequest } from "next/server";

// Supabase's hosted /auth/v1/verify endpoint defaults to the implicit flow
// -- it redirects with #access_token=... in the URL hash. This app's
// browser client (createBrowserClient from @supabase/ssr) is hardcoded to
// flowType: "pkce" and only looks for a `code` query param, so it silently
// ignores that hash and the visitor never gets signed in (confirmed live:
// no session cookie or localStorage entry ever appears).
//
// Fix: don't send people to Supabase's verify endpoint directly. Send them
// here instead with the token_hash that admin.generateLink also returns
// (see scripts/pilot-account.mjs), verify it server-side, and set the
// session via cookies ourselves before redirecting -- the flow Supabase
// recommends for PKCE-flow apps. Covers magic links today; the same route
// works for invite/recovery/signup-confirmation links if those are ever
// built the same way.
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const token_hash = searchParams.get("token_hash");
  const type = searchParams.get("type");
  const next = searchParams.get("next") ?? "/dashboard";

  if (token_hash && type) {
    const cookieStore = await cookies();
    const supabase = createServerClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      {
        cookies: {
          getAll() {
            return cookieStore.getAll();
          },
          setAll(cookiesToSet) {
            cookiesToSet.forEach(({ name, value, options }) => cookieStore.set(name, value, options));
          },
        },
      }
    );
    const { error } = await supabase.auth.verifyOtp({ type, token_hash });
    if (!error) {
      return NextResponse.redirect(new URL(next, request.url));
    }
  }

  return NextResponse.redirect(new URL("/login?error=invalid-link", request.url));
}
