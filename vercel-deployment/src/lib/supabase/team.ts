import { createHash, randomBytes } from "crypto";
import { supabaseServer } from "@/lib/supabase/services";
import type { Database } from "@/types/supabase";

type TeamMemberRow = Database["public"]["Tables"]["team_members"]["Row"];
type TeamInviteRow = Database["public"]["Tables"]["team_invites"]["Row"];

export type TeamRole = "owner" | "admin" | "member";

export interface TeamContext {
  // The tenant whose plan/credits/client_projects/BYO keys this request
  // should operate against -- the signed-in user's own id for an owner (or
  // anyone not on a team), the team owner's id for a member/admin.
  tenantId: string;
  role: TeamRole;
}

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// Agencies/teams are a paid-plan feature -- a free account can't invite
// anyone (seat count of 1, itself), matching this codebase's existing style
// of plan-gated limits (see CLIENT_PROJECT_LIMITS in services.ts,
// DEEP_REVIEW_PLANS in api/query/route.ts).
export const TEAM_SEAT_LIMITS: Record<"free" | "pro" | "enterprise", number> = {
  free: 1,
  pro: 5,
  enterprise: Infinity,
};

export function isTeamManager(role: TeamRole): boolean {
  return role === "owner" || role === "admin";
}

export function hashInviteToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * Resolves which tenant (plan/credits/resources) a signed-in user's request
 * should act against, and what role they hold there. A user can belong to at
 * most one team (schema's UNIQUE(member_id)), so this is always a single
 * lookup -- never recurses or chains through multiple owners.
 */
export async function getTeamContext(userId: string): Promise<TeamContext> {
  const { data } = await supabaseServer
    .from("team_members")
    .select("owner_id, role")
    .eq("member_id", userId)
    .maybeSingle();

  if (data) {
    return { tenantId: data.owner_id, role: data.role as TeamRole };
  }
  return { tenantId: userId, role: "owner" };
}

export interface TeamRosterEntry {
  id: string;
  member_id: string;
  role: "admin" | "member";
  created_at: string;
  name: string | null;
  email: string;
}

export async function getTeamRoster(ownerId: string): Promise<TeamRosterEntry[]> {
  const { data: members, error } = await supabaseServer
    .from("team_members")
    .select("*")
    .eq("owner_id", ownerId)
    .order("created_at", { ascending: true });
  if (error || !members.length) return [];

  const { data: profiles } = await supabaseServer
    .from("profiles")
    .select("id, name, email")
    .in(
      "id",
      members.map((m: TeamMemberRow) => m.member_id)
    );
  const byId = new Map<string, { id: string; name: string | null; email: string }>(
    (profiles || []).map((p: { id: string; name: string | null; email: string }) => [p.id, p])
  );

  return members.map((m: TeamMemberRow) => ({
    id: m.id,
    member_id: m.member_id,
    role: m.role,
    created_at: m.created_at,
    name: byId.get(m.member_id)?.name ?? null,
    email: byId.get(m.member_id)?.email ?? "",
  }));
}

export interface PendingInvite {
  id: string;
  invited_email: string;
  role: "admin" | "member";
  expires_at: string;
  created_at: string;
}

export async function getPendingInvites(ownerId: string): Promise<PendingInvite[]> {
  const { data, error } = await supabaseServer
    .from("team_invites")
    .select("id, invited_email, role, expires_at, created_at")
    .eq("owner_id", ownerId)
    .is("accepted_at", null)
    .gt("expires_at", new Date().toISOString())
    .order("created_at", { ascending: false });
  if (error) return [];
  return data;
}

export async function countTeamSeatsUsed(ownerId: string): Promise<number> {
  const [{ count: memberCount }, pending] = await Promise.all([
    supabaseServer.from("team_members").select("id", { count: "exact", head: true }).eq("owner_id", ownerId),
    getPendingInvites(ownerId),
  ]);
  // +1 for the owner's own seat.
  return 1 + (memberCount ?? 0) + pending.length;
}

export type CreateInviteResult =
  | { success: true; token: string; invite: TeamInviteRow }
  | { success: false; error: string };

export async function createInvite(
  ownerId: string,
  invitedEmail: string,
  role: "admin" | "member"
): Promise<CreateInviteResult> {
  const email = invitedEmail.trim().toLowerCase();

  const roster = await getTeamRoster(ownerId);
  if (roster.some((m) => m.email.toLowerCase() === email)) {
    return { success: false, error: "That person is already on your team." };
  }
  const pending = await getPendingInvites(ownerId);
  if (pending.some((i) => i.invited_email.toLowerCase() === email)) {
    return { success: false, error: "There's already a pending invite for that email." };
  }

  const token = randomBytes(32).toString("hex");
  const tokenHash = hashInviteToken(token);
  const expiresAt = new Date(Date.now() + INVITE_TTL_MS).toISOString();

  const { data, error } = await supabaseServer
    .from("team_invites")
    .insert({ owner_id: ownerId, invited_email: email, role, token_hash: tokenHash, expires_at: expiresAt })
    .select()
    .single();
  if (error || !data) {
    return { success: false, error: "Failed to create invite." };
  }
  return { success: true, token, invite: data };
}

export async function cancelInvite(ownerId: string, inviteId: string): Promise<boolean> {
  // .select() so the result tells us whether a row actually matched
  // (id + owner_id + still-pending) -- a plain delete() returns no error even
  // when zero rows matched, which would otherwise look like success for a
  // wrong-owner or already-accepted/already-gone invite id.
  const { data, error } = await supabaseServer
    .from("team_invites")
    .delete()
    .eq("id", inviteId)
    .eq("owner_id", ownerId)
    .is("accepted_at", null)
    .select("id");
  return !error && !!data?.length;
}

export type AcceptInviteResult =
  | { success: true; ownerId: string }
  | { success: false; error: string };

/**
 * Accepts a pending invite on behalf of the already-authenticated userId.
 * userEmail must be the caller's own verified auth email -- an invite is
 * address-bound, not just token-bound, so a leaked/forwarded token can't be
 * redeemed by anyone other than the person it was actually sent to.
 */
export async function acceptInvite(userId: string, userEmail: string, rawToken: string): Promise<AcceptInviteResult> {
  const tokenHash = hashInviteToken(rawToken);
  const { data: invite, error } = await supabaseServer
    .from("team_invites")
    .select("*")
    .eq("token_hash", tokenHash)
    .is("accepted_at", null)
    .maybeSingle();
  if (error || !invite) {
    return { success: false, error: "This invite link is invalid or has already been used." };
  }
  if (new Date(invite.expires_at) < new Date()) {
    return { success: false, error: "This invite link has expired. Ask the team owner to send a new one." };
  }
  if (invite.invited_email.toLowerCase() !== userEmail.toLowerCase()) {
    return { success: false, error: "This invite was sent to a different email address." };
  }
  if (invite.owner_id === userId) {
    return { success: false, error: "You can't join your own team." };
  }

  const existing = await getTeamContext(userId);
  if (existing.role !== "owner" || existing.tenantId !== userId) {
    return { success: false, error: "You're already a member of another team. Leave it first." };
  }

  const { error: insertError } = await supabaseServer
    .from("team_members")
    .insert({ owner_id: invite.owner_id, member_id: userId, role: invite.role });
  if (insertError) {
    return { success: false, error: "Failed to join the team." };
  }

  await supabaseServer.from("team_invites").update({ accepted_at: new Date().toISOString() }).eq("id", invite.id);

  return { success: true, ownerId: invite.owner_id };
}

export async function removeMember(ownerId: string, memberId: string): Promise<boolean> {
  const { data, error } = await supabaseServer
    .from("team_members")
    .delete()
    .eq("owner_id", ownerId)
    .eq("member_id", memberId)
    .select("id");
  return !error && !!data?.length;
}

export async function updateMemberRole(ownerId: string, memberId: string, role: "admin" | "member"): Promise<boolean> {
  const { data, error } = await supabaseServer
    .from("team_members")
    .update({ role })
    .eq("owner_id", ownerId)
    .eq("member_id", memberId)
    .select("id");
  return !error && !!data?.length;
}

export async function leaveTeam(memberId: string): Promise<boolean> {
  const { data, error } = await supabaseServer.from("team_members").delete().eq("member_id", memberId).select("id");
  return !error && !!data?.length;
}
