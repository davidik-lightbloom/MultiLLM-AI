"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Users, CheckCircle2, XCircle } from "lucide-react";
import { useAuth } from "@/components/auth/AuthProvider";

// Deliberately not wrapped in ProtectedRoute -- that would bounce an
// unauthenticated visitor straight to /login and drop the ?token= param with
// no way back to this page. A team invite is commonly the very first link a
// brand-new teammate ever clicks, so this page has to handle "not signed in
// yet" itself rather than assume the visitor already has a session.
//
// Reads the token from window.location directly (like AuthHashHandler.tsx
// reads its hash fragment) rather than next/navigation's useSearchParams --
// that hook requires wrapping the page in a <Suspense> boundary just to
// avoid a build warning, which isn't worth it for one query param.
export default function AcceptTeamInvitePage() {
  const { user, loading } = useAuth();
  const router = useRouter();
  const [token, setToken] = useState<string | null>(null);
  const [status, setStatus] = useState<"idle" | "accepting" | "success" | "error">("idle");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setToken(new URLSearchParams(window.location.search).get("token") || "");
  }, []);

  useEffect(() => {
    if (loading || !user || !token || status !== "idle") return;

    (async () => {
      setStatus("accepting");
      try {
        const res = await fetch("/api/team/invites/accept", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          setError(data.error || "Failed to accept invite");
          setStatus("error");
          return;
        }
        setStatus("success");
        setTimeout(() => router.push("/dashboard/team"), 2000);
      } catch {
        setError("Failed to accept invite");
        setStatus("error");
      }
    })();
  }, [loading, user, token, status, router]);

  return (
    <div className="min-h-screen bg-slate-50 flex items-center justify-center px-4">
      <div className="max-w-md w-full bg-white rounded-2xl shadow-sm border border-slate-100 p-8 text-center">
        <div className="w-14 h-14 rounded-2xl bg-purple-100 flex items-center justify-center mx-auto mb-4">
          <Users className="w-7 h-7 text-purple-600" />
        </div>
        <h1 className="text-2xl font-bold text-slate-900 mb-2">Team Invite</h1>

        {token === "" && (
          <p className="text-slate-600">This link is missing its invite token. Ask the team owner to resend it.</p>
        )}

        {(token === null || (token && loading)) && <p className="text-slate-500">Loading...</p>}

        {token && !loading && !user && (
          <>
            <p className="text-slate-600 mb-6">
              Sign in (or create a free account) with the email this invite was sent to, then come back to this link to join the team.
            </p>
            <div className="flex gap-3 justify-center">
              <Link href="/login" className="px-5 py-2.5 bg-purple-600 hover:bg-purple-700 text-white rounded-xl font-semibold transition-colors">
                Sign in / Sign up
              </Link>
            </div>
          </>
        )}

        {token && !loading && user && status === "accepting" && <p className="text-slate-500">Joining the team...</p>}

        {token && !loading && user && status === "success" && (
          <div className="flex flex-col items-center gap-3">
            <CheckCircle2 className="w-10 h-10 text-emerald-500" />
            <p className="text-slate-700">You&apos;ve joined the team. Redirecting to your dashboard...</p>
          </div>
        )}

        {token && !loading && user && status === "error" && (
          <div className="flex flex-col items-center gap-3">
            <XCircle className="w-10 h-10 text-red-500" />
            <p className="text-slate-700">{error}</p>
            <Link href="/dashboard" className="text-purple-600 font-medium underline">Go to dashboard</Link>
          </div>
        )}
      </div>
    </div>
  );
}
