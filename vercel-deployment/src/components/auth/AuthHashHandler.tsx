"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import toast from "react-hot-toast";
import { getBrowserSupabase } from "@/lib/supabase/browserClient";

// Supabase's default email templates (Confirm signup, Invite, Change Email --
// everything except the magic-link/recovery flows this app already routes
// through /auth/confirm, see that route's comment) still link straight to
// the hosted /auth/v1/verify endpoint, which falls back to the project's
// bare Site URL whenever the caller's `redirect_to` isn't on the allow-list
// -- confirmed live, it's actually the literal 2-character string "/**",
// not a real route -- so these tokens can land on literally any path
// (including the 404 route). This is mounted in the root layout so it runs
// no matter where that lands.
//
// /verify's own redirect has used two different shapes across sessions
// (same misconfigured redirect_to, different Supabase-side token/flow
// behavior): an implicit-flow #access_token=&refresh_token=... hash, and
// now (confirmed live 2026-11-06) a PKCE ?code=... query param. Both are
// handled here. The ?code= case only succeeds when exchangeCodeForSession
// runs in the SAME browser that initiated signup (PKCE's code_verifier is
// stored client-side there) -- confirmed live: it correctly established a
// session, but the user was still left staring at the bogus 404 page until
// this redirect was added. On a different browser/device (the realistic
// case for most real users, e.g. signing up on desktop and opening the
// confirmation email on a phone) there is no verifier to exchange against
// and this cannot succeed no matter what runs client-side -- only
// repointing the email template at this app's own /auth/confirm (token_hash
// based, not device-bound) fixes that, which needs Supabase Dashboard
// access this session doesn't have.
export default function AuthHashHandler() {
  const router = useRouter();

  useEffect(() => {
    if (typeof window === "undefined") return;

    const hashParams = window.location.hash ? new URLSearchParams(window.location.hash.slice(1)) : null;
    const accessToken = hashParams?.get("access_token");
    const refreshToken = hashParams?.get("refresh_token");
    const hashErrorDescription = hashParams?.get("error_description");

    const searchParams = new URLSearchParams(window.location.search);
    const code = searchParams.get("code");

    if (!accessToken && !hashErrorDescription && !code) return;

    // Strip the hash/code right away so a page refresh doesn't replay a
    // single-use token or re-show a stale error.
    window.history.replaceState(null, "", window.location.pathname);

    if (hashErrorDescription) {
      toast.error(decodeURIComponent(hashErrorDescription.replace(/\+/g, " ")));
      router.replace("/login");
      return;
    }

    if (accessToken && refreshToken) {
      getBrowserSupabase()
        .auth.setSession({ access_token: accessToken, refresh_token: refreshToken })
        .then(({ error }: { error: unknown }) => {
          if (error) {
            toast.error("That link is invalid or has expired.");
            router.replace("/login");
          } else {
            toast.success("You're signed in.");
            router.replace("/dashboard");
          }
        });
      return;
    }

    if (code) {
      getBrowserSupabase()
        .auth.exchangeCodeForSession(code)
        .then(({ error }: { error: unknown }) => {
          if (error) {
            // The expected failure mode: this browser never initiated the
            // flow that `code` belongs to (no stored PKCE verifier), e.g. the
            // confirmation link was opened on a different device than the
            // one used to sign up.
            toast.error("This link only works on the device you used to sign up. Try signing in instead.");
            router.replace("/login");
          } else {
            toast.success("You're signed in.");
            router.replace("/dashboard");
          }
        });
    }
  }, [router]);

  return null;
}
