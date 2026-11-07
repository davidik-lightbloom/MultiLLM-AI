import { NextResponse } from "next/server";
import { getAuthenticatedUserId } from "@/lib/supabase/serverAuth";
import { cancelInvite } from "@/lib/supabase/team";
import { isDemoMode } from "@/lib/demoMode";
import { demoModeUnavailable } from "@/lib/demoModeApi";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function DELETE(_req: Request, props: { params: Promise<{ id: string }> }) {
  if (isDemoMode()) {
    return demoModeUnavailable("Cancelling team invites");
  }

  const params = await props.params;
  const userId = await getAuthenticatedUserId();
  if (!userId) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  // cancelInvite itself scopes the delete to owner_id = userId, so a
  // non-owner (or an owner targeting someone else's invite) simply deletes
  // nothing and gets ok:false below -- no separate role check needed.
  const ok = await cancelInvite(userId, params.id);
  if (!ok) {
    return NextResponse.json({ error: "Invite not found" }, { status: 404 });
  }

  return NextResponse.json({ success: true });
}
