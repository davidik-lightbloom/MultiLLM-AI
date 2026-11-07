import { NextRequest, NextResponse } from "next/server";
import { getAuthenticatedUserId } from "@/lib/supabase/serverAuth";
import { createServerSupabaseClient } from "@/lib/supabase/client";
import { acceptInvite } from "@/lib/supabase/team";
import { isDemoMode } from "@/lib/demoMode";
import { demoModeUnavailable } from "@/lib/demoModeApi";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  if (isDemoMode()) {
    return demoModeUnavailable("Joining a team");
  }

  const userId = await getAuthenticatedUserId();
  if (!userId) {
    return NextResponse.json({ error: "Please sign in (or create a free account) with the email this invite was sent to, then try the link again." }, { status: 401 });
  }

  const body = await req.json().catch(() => ({}));
  const token = typeof body?.token === "string" ? body.token.trim() : "";
  if (!token) {
    return NextResponse.json({ error: "Missing invite token" }, { status: 400 });
  }

  // auth.users is the only source of a verified email for the caller --
  // profiles.email is populated from the same signup data but isn't the
  // thing actually re-verified on every request, so re-reading it from the
  // auth table (via the service-role client, admin.getUserById) here is the
  // safer check for the address-binding rule acceptInvite enforces.
  const supabase = createServerSupabaseClient();
  const { data: authUser, error: authError } = await (supabase as any).auth.admin.getUserById(userId);
  const userEmail: string | undefined = authUser?.user?.email;
  if (authError || !userEmail) {
    return NextResponse.json({ error: "Could not verify your account email" }, { status: 500 });
  }

  const result = await acceptInvite(userId, userEmail, token);
  if (!result.success) {
    return NextResponse.json({ error: result.error }, { status: 400 });
  }

  return NextResponse.json({ success: true });
}
