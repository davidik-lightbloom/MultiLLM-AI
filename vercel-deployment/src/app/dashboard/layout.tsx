import { redirect } from "next/navigation";
import { getAuthenticatedUserId } from "@/lib/supabase/serverAuth";
import { isDemoMode } from "@/lib/demoMode";

// Redirects unauthenticated visitors to /login server-side, before any
// dashboard client code ships. Previously this was only checked client-side
// (ProtectedRoute), so an unauthenticated visit rendered a blank page and
// threw a hydration error before the redirect ever fired. Demo mode has no
// real Supabase session -- its "auth" is a localStorage stand-in checked
// entirely client-side -- so there's nothing to verify here.
export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  if (!isDemoMode()) {
    const userId = await getAuthenticatedUserId();
    if (!userId) redirect("/login");
  }
  return <>{children}</>;
}
