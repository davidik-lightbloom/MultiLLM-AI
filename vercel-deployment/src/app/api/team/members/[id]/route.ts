import { NextRequest, NextResponse } from "next/server";
import { getAuthenticatedUserId } from "@/lib/supabase/serverAuth";
import { removeMember, updateMemberRole, leaveTeam, getTeamContext } from "@/lib/supabase/team";
import { isDemoMode } from "@/lib/demoMode";
import { demoModeUnavailable } from "@/lib/demoModeApi";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Owner-only: change a team member's role between 'admin' and 'member'.
export async function PATCH(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  if (isDemoMode()) {
    return demoModeUnavailable("Changing team member roles");
  }

  const params = await props.params;
  const userId = await getAuthenticatedUserId();
  if (!userId) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const context = await getTeamContext(userId);
  if (context.role !== "owner") {
    return NextResponse.json({ error: "Only the team owner can change roles" }, { status: 403 });
  }

  const body = await req.json().catch(() => ({}));
  const role = body?.role === "admin" ? "admin" : body?.role === "member" ? "member" : null;
  if (!role) {
    return NextResponse.json({ error: "role must be 'admin' or 'member'" }, { status: 400 });
  }

  const ok = await updateMemberRole(userId, params.id, role);
  if (!ok) {
    return NextResponse.json({ error: "Team member not found" }, { status: 404 });
  }

  return NextResponse.json({ success: true });
}

// Owner removes a member (any id but their own), or a member/admin leaves
// the team themselves by targeting their own id.
export async function DELETE(_req: Request, props: { params: Promise<{ id: string }> }) {
  if (isDemoMode()) {
    return demoModeUnavailable("Leaving or removing a team member");
  }

  const params = await props.params;
  const userId = await getAuthenticatedUserId();
  if (!userId) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  if (params.id === userId) {
    const ok = await leaveTeam(userId);
    if (!ok) {
      return NextResponse.json({ error: "You're not on a team" }, { status: 404 });
    }
    return NextResponse.json({ success: true });
  }

  const context = await getTeamContext(userId);
  if (context.role !== "owner") {
    return NextResponse.json({ error: "Only the team owner can remove other members" }, { status: 403 });
  }

  const ok = await removeMember(userId, params.id);
  if (!ok) {
    return NextResponse.json({ error: "Team member not found" }, { status: 404 });
  }

  return NextResponse.json({ success: true });
}
