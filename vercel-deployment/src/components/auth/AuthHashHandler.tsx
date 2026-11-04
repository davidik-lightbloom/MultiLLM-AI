"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import toast from "react-hot-toast";
import { getBrowserSupabase } from "@/lib/supabase/browserClient";

// Supabase's default email templates (Confirm signup, Invite, Change Email --
// everything except the magic-link/recovery flows this app already routes
// through /auth/confirm, see that route's comment) still link straight to
// the hosted /auth/v1/verify endpoint. That endpoint redirects using the
// implicit flow (#access_token=&refresh_token=... in the URL hash), which
// this app's PKCE-only browser client silently ignores on its own -- the
// same root cause as the pilot magic-link bug, just for the templates we
// can't repoint without Supabase Dashboard access. It also falls back to
// the project's bare Site URL whenever the caller's `redirect_to` isn't on
// the allow-list, so these tokens can land on literally any path (including
// the 404 route) -- this is mounted in the root layout so it runs no matter
// where the hash shows up.
export default function AuthHashHandler() {
  const router = useRouter();

  useEffect(() => {
    if (typeof window === "undefined" || !window.location.hash) return;

    const params = new URLSearchParams(window.location.hash.slice(1));
    const accessToken = params.get("access_token");
    const refreshToken = params.get("refresh_token");
    const errorDescription = params.get("error_description");

    if (!accessToken && !errorDescription) return;

    // Strip the hash right away so a page refresh doesn't replay a
    // single-use token or re-show a stale error.
    window.history.replaceState(null, "", window.location.pathname + window.location.search);

    if (errorDescription) {
      toast.error(decodeURIComponent(errorDescription.replace(/\+/g, " ")));
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
    }
  }, [router]);

  return null;
}
