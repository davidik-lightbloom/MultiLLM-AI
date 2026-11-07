import { NextResponse } from "next/server";
import { getAuthenticatedUserId } from "@/lib/supabase/serverAuth";
import { getProfile } from "@/lib/supabase/services";
import { getTeamContext, getTeamRoster, getPendingInvites, TEAM_SEAT_LIMITS } from "@/lib/supabase/team";
import { isDemoMode } from "@/lib/demoMode";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  if (isDemoMode()) {
    return NextResponse.json({ role: "owner", tenantId: "demo-user", roster: [], pendingInvites: [], plan: "pro", seatLimit: TEAM_SEAT_LIMITS.pro });
  }

  const userId = await getAuthenticatedUserId();
  if (!userId) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const context = await getTeamContext(userId);
  const profile = await getProfile(context.tenantId);
  const plan = (profile?.plan as "free" | "pro" | "enterprise") || "free";
  // Only the owner manages the roster in V1 -- see team_members's schema
  // comment. context.role is "owner" exactly when userId has no team_members
  // row of its own, i.e. it isn't a member of someone else's team.
  const manager = context.role === "owner";

  const [roster, pendingInvites] = await Promise.all([
    getTeamRoster(context.tenantId),
    manager ? getPendingInvites(context.tenantId) : Promise.resolve([]),
  ]);

  return NextResponse.json({
    role: context.role,
    tenantId: context.tenantId,
    isOwner: context.tenantId === userId,
    roster,
    pendingInvites,
    plan,
    seatLimit: Number.isFinite(TEAM_SEAT_LIMITS[plan]) ? TEAM_SEAT_LIMITS[plan] : null,
  });
}
