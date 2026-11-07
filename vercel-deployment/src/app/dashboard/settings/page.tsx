"use client";

import { useState, useEffect, FormEvent } from "react";
import { useRouter } from "next/navigation";
import { motion } from "framer-motion";
import { Save, User, Shield, Bell, Check, X, AlertTriangle, Zap } from "lucide-react";
import { toast } from "react-hot-toast";
import { useAuth } from "@/components/auth/AuthProvider";
import { ProtectedRoute } from "@/components/auth/ProtectedRoute";
import DashboardHeader from "@/components/layout/dashboard-header";

// Avatar picker, phone number, photo upload, and the whole Preferences
// section (language/timezone/notifications) were removed from here --
// none of them persisted anywhere, they just silently reset on reload.
// Only re-add a control once it actually saves. Display Name, account
// deletion, and this page's own editing flow are the only parts of
// Profile/Security that do anything real.
export default function SettingsPage() {
  const { user, demoMode, refreshUser, updateProfile, updatePreferences, teamRole, logout } = useAuth();
  const router = useRouter();
  const [isEditing, setIsEditing] = useState(false);
  const [displayName, setDisplayName] = useState(user?.user_metadata?.name || user?.profile?.name || "");
  const [twoFactorEnabled, setTwoFactorEnabled] = useState(false);
  const [deletingAccount, setDeletingAccount] = useState(false);
  const [saveStatus, setSaveStatus] = useState("idle");
  // Phase 1 of the adaptive multi-agent hierarchy roadmap: saves immediately
  // on change (like the homepage's local_only toggle), not gated behind this
  // page's isEditing/Save flow above, which only covers the Profile
  // section's display name. Skills are stored-only for now -- a future
  // coordinator is the first thing that actually reads enabled_skills.
  const [aiMode, setAiMode] = useState<"fast" | "deep">(user?.profile?.default_mode === "deep" ? "deep" : "fast");
  const [enabledSkills, setEnabledSkills] = useState<string[]>(user?.profile?.enabled_skills || ["general"]);

  // Bug found live 2026-11-06: the useState initializers above only ever run
  // once, at this component's first mount -- on a fresh page load/refresh
  // they displayed "Fast"/["general"] regardless of what was actually saved,
  // because ProtectedRoute's own loading gate doesn't guarantee `user` (with
  // its profile already attached) is non-null on this component's very
  // first render. Confirmed via a live round-trip: toggled Deep mode +
  // "coding" on, refreshed, DB correctly showed default_mode="deep" and
  // enabled_skills=["general","coding"] (so the save path was never broken),
  // but the UI kept showing Fast/general until a new toggle click overwrote
  // the correct saved value again. Mirrors the homepage's own existing sync
  // effect for localOnly/mode (src/app/page.tsx) -- same bug shape, same fix.
  useEffect(() => {
    if (!user) return;
    setAiMode(user.profile?.default_mode === "deep" ? "deep" : "fast");
    setEnabledSkills(user.profile?.enabled_skills || ["general"]);
  }, [user]);

  const handleModeToggle = async (wantsDeep: boolean) => {
    const next = wantsDeep ? "deep" : "fast";
    setAiMode(next);
    try {
      await updatePreferences({ default_mode: next });
    } catch {
      toast.error("Couldn't save mode preference");
    }
  };

  const handleSkillToggle = async (skill: string) => {
    const next = enabledSkills.includes(skill)
      ? enabledSkills.filter((s) => s !== skill)
      : [...enabledSkills, skill];
    setEnabledSkills(next);
    try {
      await updatePreferences({ enabled_skills: next });
    } catch {
      toast.error("Couldn't save skills preference");
    }
  };

  const handleSave = async (e: FormEvent) => {
    e.preventDefault();
    setSaveStatus("saving");

    await new Promise((resolve) => setTimeout(resolve, 1000));

    try {
      await updateProfile({ name: displayName });
      setSaveStatus("saved");
      setIsEditing(false);
      await refreshUser();
    } catch {
      setSaveStatus("idle");
      toast.error("Failed to save settings");
      return;
    }

    setTimeout(() => {
      setSaveStatus("idle");
    }, 3000);
  };

  const handleCancel = () => {
    setDisplayName(user?.user_metadata?.name || user?.profile?.name || "");
    setIsEditing(false);
  };

  const handleDeleteAccount = async () => {
    if (!confirm("Are you sure? This permanently deletes your account and all your data -- queries, API keys, client projects, and billing history. This cannot be undone.")) {
      return;
    }
    setDeletingAccount(true);
    try {
      // Demo mode has no real account to delete -- there's no backend
      // session for /api/account to even authenticate (it would 401).
      // Logging out of the local fake account achieves the same outcome.
      if (!demoMode) {
        const res = await fetch("/api/account", { method: "DELETE" });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error(data.error || "Failed to delete account");
        }
      }
      await logout();
      router.push("/");
    } catch (err: any) {
      toast.error(err.message || "Failed to delete account");
      setDeletingAccount(false);
    }
  };

  return (
    <ProtectedRoute>
      <div className="min-h-screen bg-slate-50">
        <DashboardHeader />

        {/* Main Content */}
        <main className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
          {/* Page Header */}
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5 }}
            className="flex items-center justify-between mb-8"
          >
            <div>
              <h1 className="text-3xl font-bold text-slate-900">Settings</h1>
              <p className="text-slate-600 mt-1">Manage your account preferences and integration settings</p>
            </div>
            {isEditing ? (
              <div className="flex gap-3">
                <button
                  onClick={handleCancel}
                  className="px-4 py-2 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-xl font-semibold transition-colors flex items-center gap-2"
                >
                  <X className="w-4 h-4" />
                  Cancel
                </button>
                <button
                  onClick={handleSave}
                  disabled={saveStatus === "saving"}
                  className="px-4 py-2 bg-purple-600 hover:bg-purple-700 disabled:bg-slate-300 text-white rounded-xl font-semibold transition-colors flex items-center gap-2"
                >
                  {saveStatus === "saving" ? (
                    <>
                      <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                      </svg>
                      Saving...
                    </>
                  ) : (
                    <>
                      <Save className="w-4 h-4" />
                      Save Changes
                    </>
                  )}
                </button>
              </div>
            ) : (
              <button
                onClick={() => setIsEditing(true)}
                className="px-4 py-2 bg-purple-600 hover:bg-purple-700 text-white rounded-xl font-semibold transition-colors flex items-center gap-2"
              >
                <Save className="w-4 h-4" />
                Edit Settings
              </button>
            )}
          </motion.div>

          <div className="space-y-8">
            {/* Profile Section */}
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.5, delay: 0.1 }}
              className="bg-white rounded-2xl shadow-sm border border-slate-100 p-8"
            >
              <h2 className="text-xl font-semibold text-slate-900 mb-6 flex items-center gap-2">
                <User className="w-5 h-5 text-purple-600" />
                Profile
              </h2>
              <form className="space-y-6">
                <div>
                  <label htmlFor="displayName" className="block text-sm font-medium text-slate-700 mb-1">
                    Display Name
                  </label>
                  <input
                    id="displayName"
                    type="text"
                    value={displayName}
                    onChange={(e) => setDisplayName(e.target.value)}
                    disabled={!isEditing}
                    className="w-full px-4 py-3 rounded-xl border border-slate-300 focus:border-purple-500 focus:ring-2 focus:ring-purple-200 transition-all disabled:bg-slate-50 disabled:text-slate-500"
                  />
                </div>

                <div>
                  <label htmlFor="email" className="block text-sm font-medium text-slate-700 mb-1">
                    Email Address
                  </label>
                  <input
                    id="email"
                    type="email"
                    value={user?.email || ""}
                    disabled
                    className="w-full px-4 py-3 rounded-xl border border-slate-300 bg-slate-50 text-slate-500"
                  />
                  <p className="text-xs text-slate-400 mt-1">Changing your account email isn&apos;t supported yet.</p>
                </div>
              </form>
            </motion.div>

            {/* AI Behavior Section -- Phase 1 of the adaptive multi-agent
                hierarchy roadmap. Mode and skills save immediately on
                change (like the homepage's local_only toggle), not gated
                behind this page's own isEditing/Save flow. Skills are
                stored-only for now -- a future coordinator is the first
                thing that actually reads enabled_skills. */}
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.5, delay: 0.15 }}
              className="bg-white rounded-2xl shadow-sm border border-slate-100 p-8"
            >
              <h2 className="text-xl font-semibold text-slate-900 mb-2 flex items-center gap-2">
                <Zap className="w-5 h-5 text-purple-600" />
                AI Behavior
              </h2>
              {teamRole !== "owner" && (
                <p className="text-xs text-slate-400 mb-4">
                  These settings are shared across your whole team -- changing them here changes the default for everyone.
                </p>
              )}

              <div className="flex items-center justify-between py-3 border-b border-slate-100">
                <div>
                  <div className="font-medium text-slate-900">Deep Mode</div>
                  <div className="text-sm text-slate-500">
                    Runs a larger ensemble and (on Pro/Enterprise) an extra confidence check, by default on every query.
                  </div>
                </div>
                <button
                  onClick={() => handleModeToggle(aiMode !== "deep")}
                  className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-purple-500 focus:ring-offset-2 ${
                    aiMode === "deep" ? "bg-purple-600" : "bg-slate-200"
                  }`}
                >
                  <span
                    className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${aiMode === "deep" ? "translate-x-6" : "translate-x-1"}`}
                  />
                </button>
              </div>

              <div className="mt-4">
                <div className="font-medium text-slate-900 mb-2">Skills</div>
                <p className="text-xs text-slate-400 mb-3">
                  Not active yet -- stored for an upcoming feature that lets you focus the ensemble on specific skills.
                </p>
                <div className="flex flex-wrap gap-2">
                  {["general", "coding", "research", "writing"].map((skill) => (
                    <button
                      key={skill}
                      type="button"
                      onClick={() => handleSkillToggle(skill)}
                      className={`px-3 py-1.5 rounded-full text-sm font-medium border transition-colors ${
                        enabledSkills.includes(skill)
                          ? "bg-purple-100 text-purple-700 border-purple-200"
                          : "bg-slate-50 text-slate-600 border-slate-200"
                      }`}
                    >
                      {skill}
                    </button>
                  ))}
                </div>
              </div>
            </motion.div>

            {/* Security Section */}
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.5, delay: 0.2 }}
              className="bg-white rounded-2xl shadow-sm border border-slate-100 p-8"
            >
              <h2 className="text-xl font-semibold text-slate-900 mb-6 flex items-center gap-2">
                <Shield className="w-5 h-5 text-purple-600" />
                Security
              </h2>
              <div className="mb-6 flex items-start gap-2 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                <AlertTriangle className="w-4 h-4 mt-0.5 flex-shrink-0" />
                <span>Two-factor authentication isn&apos;t implemented yet -- this toggle doesn&apos;t enable it.</span>
              </div>
              <div className="space-y-4">
                <div className="flex items-center justify-between py-3 border-b border-slate-100">
                  <div className="flex items-center gap-3">
                    <div className="p-2 bg-slate-100 rounded-lg">
                      <Shield className="w-4 h-4 text-slate-600" />
                    </div>
                    <div>
                      <div className="font-medium text-slate-900">Two-Factor Authentication</div>
                      <div className="text-sm text-slate-500">Add an extra layer of security to your account</div>
                    </div>
                  </div>
                  <button
                    onClick={() => setTwoFactorEnabled(!twoFactorEnabled)}
                    className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-purple-500 focus:ring-offset-2 ${
                      twoFactorEnabled ? "bg-purple-600" : "bg-slate-200"
                    }`}
                  >
                    <span
                      className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${twoFactorEnabled ? "translate-x-6" : "translate-x-1"}`}
                    />
                  </button>
                </div>

                <div className="flex items-center justify-between py-3 border-b border-slate-100">
                  <div className="flex items-center gap-3">
                    <div className="p-2 bg-slate-100 rounded-lg">
                      <Bell className="w-4 h-4 text-slate-600" />
                    </div>
                    <div>
                      <div className="font-medium text-slate-900">Session Timeout</div>
                      <div className="text-sm text-slate-500">Auto-logout after 15 minutes of inactivity</div>
                    </div>
                  </div>
                  <span className="text-sm text-purple-600 font-medium">15 min (recommended)</span>
                </div>

                <button
                  type="button"
                  disabled={deletingAccount}
                  className="w-full py-3 px-4 bg-red-50 hover:bg-red-100 disabled:opacity-60 disabled:cursor-not-allowed text-red-700 rounded-xl font-medium transition-colors flex items-center justify-center gap-2 mt-4"
                  onClick={handleDeleteAccount}
                >
                  {deletingAccount ? "Deleting..." : "Delete Account"}
                </button>
              </div>
            </motion.div>

            {/* Save Status */}
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ duration: 0.5, delay: 0.4 }}
              className="text-center"
            >
              {saveStatus === "saved" && (
                <div className="inline-flex items-center gap-2 px-4 py-2 bg-emerald-100 text-emerald-700 rounded-xl">
                  <Check className="w-4 h-4" />
                  <span className="text-sm font-medium">All changes saved successfully</span>
                </div>
              )}
            </motion.div>
          </div>
        </main>
      </div>
    </ProtectedRoute>
  );
}
