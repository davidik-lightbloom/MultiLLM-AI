"use client";

import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { Users, Mail, Trash2, Crown, Shield, AlertCircle, LogOut } from "lucide-react";
import { toast } from "react-hot-toast";
import { useAuth } from "@/components/auth/AuthProvider";
import { ProtectedRoute } from "@/components/auth/ProtectedRoute";
import DashboardHeader from "@/components/layout/dashboard-header";

interface RosterEntry {
  id: string;
  member_id: string;
  role: "admin" | "member";
  created_at: string;
  name: string | null;
  email: string;
}

interface PendingInvite {
  id: string;
  invited_email: string;
  role: "admin" | "member";
  expires_at: string;
  created_at: string;
}

interface TeamState {
  role: "owner" | "admin" | "member";
  isOwner: boolean;
  roster: RosterEntry[];
  pendingInvites: PendingInvite[];
  plan: "free" | "pro" | "enterprise";
  seatLimit: number | null;
}

export default function TeamPage() {
  const { user } = useAuth();
  const [state, setState] = useState<TeamState | null>(null);
  const [loading, setLoading] = useState(true);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<"admin" | "member">("member");
  const [inviting, setInviting] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/team");
      const data = await res.json();
      if (res.ok) setState(data);
    } catch {
      toast.error("Could not load your team");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, [user?.id]);

  const seatsUsed = 1 + (state?.roster.length ?? 0) + (state?.pendingInvites.length ?? 0);
  const atSeatLimit = state?.seatLimit !== null && state !== null && seatsUsed >= (state?.seatLimit ?? Infinity);

  const handleInvite = async () => {
    if (!inviteEmail.trim()) {
      toast.error("Please enter an email address");
      return;
    }
    setInviting(true);
    try {
      const res = await fetch("/api/team/invites", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: inviteEmail.trim(), role: inviteRole }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error || "Failed to send invite");
        return;
      }
      toast.success(`Invite sent to ${inviteEmail.trim()}`);
      setInviteEmail("");
      await load();
    } catch {
      toast.error("Failed to send invite");
    } finally {
      setInviting(false);
    }
  };

  const handleCancelInvite = async (id: string) => {
    try {
      const res = await fetch(`/api/team/invites/${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error();
      toast.success("Invite cancelled");
      await load();
    } catch {
      toast.error("Failed to cancel invite");
    }
  };

  const handleRoleChange = async (memberId: string, role: "admin" | "member") => {
    try {
      const res = await fetch(`/api/team/members/${memberId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role }),
      });
      if (!res.ok) throw new Error();
      toast.success("Role updated");
      await load();
    } catch {
      toast.error("Failed to update role");
    }
  };

  const handleRemove = async (memberId: string) => {
    if (!confirm("Remove this person from your team? They'll go back to their own free-plan account.")) return;
    try {
      const res = await fetch(`/api/team/members/${memberId}`, { method: "DELETE" });
      if (!res.ok) throw new Error();
      toast.success("Removed from team");
      await load();
    } catch {
      toast.error("Failed to remove team member");
    }
  };

  const handleLeave = async () => {
    if (!user?.id) return;
    if (!confirm("Leave this team? You'll go back to your own free-plan account.")) return;
    try {
      const res = await fetch(`/api/team/members/${user.id}`, { method: "DELETE" });
      if (!res.ok) throw new Error();
      toast.success("You've left the team");
      await load();
    } catch {
      toast.error("Failed to leave team");
    }
  };

  return (
    <ProtectedRoute>
      <div className="min-h-screen bg-slate-50">
        <DashboardHeader />
        <main className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
          <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.5 }} className="mb-8">
            <h1 className="text-3xl font-bold text-slate-900">Team</h1>
            <p className="text-slate-600 mt-1">
              Share your plan, credits, and client projects with your team. Everyone&apos;s queries are billed against one pooled account.
            </p>
          </motion.div>

          {loading ? (
            <div className="bg-white rounded-2xl shadow-sm border border-slate-100 p-12 text-center text-slate-500">Loading...</div>
          ) : !state ? (
            <div className="bg-white rounded-2xl shadow-sm border border-slate-100 p-12 text-center text-slate-500">
              Couldn&apos;t load your team.
            </div>
          ) : !state.isOwner ? (
            <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.5 }} className="bg-white rounded-2xl shadow-sm border border-slate-100 p-8">
              <div className="flex items-center gap-3 mb-4">
                <div className="p-3 rounded-xl bg-purple-100">
                  <Users className="w-5 h-5 text-purple-600" />
                </div>
                <div>
                  <h2 className="text-xl font-semibold text-slate-900">
                    You&apos;re a {state.role} on {state.roster.find((m) => m.member_id === user?.id) ? "this" : "a"} team
                  </h2>
                  <p className="text-sm text-slate-500">Your queries are billed against your team owner&apos;s plan and credits.</p>
                </div>
              </div>
              <button
                onClick={handleLeave}
                className="px-4 py-2 bg-red-50 hover:bg-red-100 text-red-700 rounded-xl font-medium transition-colors inline-flex items-center gap-2"
              >
                <LogOut className="w-4 h-4" />
                Leave team
              </button>
            </motion.div>
          ) : (
            <>
              <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.5 }} className="bg-white rounded-2xl shadow-sm border border-slate-100 p-8 mb-6">
                <h2 className="text-xl font-semibold text-slate-900 mb-1 flex items-center gap-2">
                  <Mail className="w-5 h-5 text-purple-600" />
                  Invite a team member
                </h2>
                <p className="text-sm text-slate-500 mb-4">
                  {state.seatLimit === null
                    ? `${seatsUsed} seats used, unlimited on your ${state.plan} plan.`
                    : `${seatsUsed} / ${state.seatLimit} seats used on your ${state.plan} plan.`}
                </p>
                {state.plan === "free" ? (
                  <div className="p-4 bg-amber-50 border border-amber-200 rounded-xl flex items-start gap-3">
                    <AlertCircle className="w-5 h-5 text-amber-600 mt-0.5" />
                    <p className="text-sm text-amber-800">
                      Teams aren&apos;t available on the free plan.{" "}
                      <a href="/dashboard/billing" className="underline font-medium">Upgrade to Pro</a> to invite teammates.
                    </p>
                  </div>
                ) : (
                  <div className="flex flex-col sm:flex-row gap-3">
                    <input
                      type="email"
                      value={inviteEmail}
                      onChange={(e) => setInviteEmail(e.target.value)}
                      placeholder="teammate@example.com"
                      disabled={atSeatLimit}
                      className="flex-1 px-4 py-3 rounded-xl border border-slate-300 focus:border-purple-500 focus:ring-2 focus:ring-purple-200 transition-all disabled:bg-slate-50"
                    />
                    <select
                      value={inviteRole}
                      onChange={(e) => setInviteRole(e.target.value as "admin" | "member")}
                      disabled={atSeatLimit}
                      className="px-4 py-3 rounded-xl border border-slate-300 disabled:bg-slate-50"
                    >
                      <option value="member">Member</option>
                      <option value="admin">Admin</option>
                    </select>
                    <button
                      onClick={handleInvite}
                      disabled={inviting || atSeatLimit}
                      className="bg-purple-600 hover:bg-purple-700 disabled:bg-slate-300 text-white px-6 py-3 rounded-xl font-semibold transition-colors"
                    >
                      {inviting ? "Sending..." : "Send Invite"}
                    </button>
                  </div>
                )}
                {atSeatLimit && state.plan !== "free" && (
                  <p className="text-sm text-amber-600 mt-3">
                    You&apos;ve reached your plan&apos;s seat limit.{" "}
                    <a href="/dashboard/billing" className="underline font-medium">Upgrade</a> to invite more people.
                  </p>
                )}
              </motion.div>

              {state.pendingInvites.length > 0 && (
                <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.5, delay: 0.05 }} className="bg-white rounded-2xl shadow-sm border border-slate-100 overflow-hidden mb-6">
                  <h3 className="px-6 pt-6 text-sm font-semibold text-slate-700">Pending invites</h3>
                  <div className="divide-y divide-slate-100 mt-2">
                    {state.pendingInvites.map((invite) => (
                      <div key={invite.id} className="px-6 py-4 flex items-center justify-between">
                        <div>
                          <p className="font-medium text-slate-900">{invite.invited_email}</p>
                          <p className="text-xs text-slate-500 capitalize">{invite.role} &middot; expires {new Date(invite.expires_at).toLocaleDateString()}</p>
                        </div>
                        <button onClick={() => handleCancelInvite(invite.id)} className="p-2 rounded-lg hover:bg-red-50 text-red-500 transition-colors" title="Cancel invite">
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    ))}
                  </div>
                </motion.div>
              )}

              <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.5, delay: 0.1 }} className="bg-white rounded-2xl shadow-sm border border-slate-100 overflow-hidden">
                <h3 className="px-6 pt-6 text-sm font-semibold text-slate-700">Roster</h3>
                <div className="divide-y divide-slate-100 mt-2">
                  <div className="px-6 py-4 flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <div className="p-2 bg-purple-100 rounded-lg"><Crown className="w-4 h-4 text-purple-600" /></div>
                      <div>
                        <p className="font-medium text-slate-900">{user?.profile?.name || user?.email} (you)</p>
                        <p className="text-xs text-slate-500">Owner</p>
                      </div>
                    </div>
                  </div>
                  {state.roster.length === 0 ? (
                    <div className="px-6 py-8 text-center text-slate-500 text-sm">No team members yet -- invite someone above.</div>
                  ) : (
                    state.roster.map((m) => (
                      <div key={m.id} className="px-6 py-4 flex items-center justify-between">
                        <div className="flex items-center gap-3">
                          <div className="p-2 bg-slate-100 rounded-lg"><Shield className="w-4 h-4 text-slate-500" /></div>
                          <div>
                            <p className="font-medium text-slate-900">{m.name || m.email}</p>
                            <p className="text-xs text-slate-500">{m.email}</p>
                          </div>
                        </div>
                        <div className="flex items-center gap-2">
                          <select
                            value={m.role}
                            onChange={(e) => handleRoleChange(m.member_id, e.target.value as "admin" | "member")}
                            className="text-sm px-3 py-1.5 rounded-lg border border-slate-200"
                          >
                            <option value="member">Member</option>
                            <option value="admin">Admin</option>
                          </select>
                          <button onClick={() => handleRemove(m.member_id)} className="p-2 rounded-lg hover:bg-red-50 text-red-500 transition-colors" title="Remove">
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </motion.div>
            </>
          )}
        </main>
      </div>
    </ProtectedRoute>
  );
}
