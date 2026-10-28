"use client";

import { createContext, useContext, useEffect, useState, ReactNode } from "react";
import type { User } from "@supabase/supabase-js";
import { isDemoMode } from "@/lib/demoMode";
import { getBrowserSupabase } from "@/lib/supabase/browserClient";

interface Profile {
  id: string;
  email: string;
  name: string | null;
  plan: "free" | "pro" | "enterprise";
  credits: number;
  plan_expires_at: string | null;
  is_active: boolean;
  local_only_mode: boolean;
  created_at: string;
  updated_at: string;
}

interface AuthContextType {
  user: (User & { profile?: Profile }) | null;
  loading: boolean;
  demoMode: boolean;
  login: (email: string, password: string) => Promise<void>;
  register: (email: string, password: string, name: string) => Promise<{ needsEmailConfirmation: boolean }>;
  logout: () => Promise<void>;
  refreshUser: () => Promise<void>;
  updateProfile: (updates: Partial<Profile>) => Promise<void>;
  requestPasswordReset: (email: string) => Promise<void>;
  updatePassword: (newPassword: string) => Promise<void>;
}

const AuthContext = createContext<AuthContextType | null>(null);

const DEMO_USER_KEY = "multillm_demo_user";

function demoUser(email: string, name: string): User & { profile: Profile } {
  return {
    id: "demo-user",
    aud: "authenticated",
    role: "authenticated",
    email,
    email_confirmed_at: new Date().toISOString(),
    phone: "",
    confirmation_sent_at: new Date().toISOString(),
    confirmed_at: new Date().toISOString(),
    last_sign_in_at: new Date().toISOString(),
    app_metadata: { provider: "email", providers: ["email"] },
    user_metadata: { name },
    identities: [{ identity_id: "demo-user", id: "demo-user", user_id: "demo-user", identity_data: { email }, provider: "email", last_sign_in_at: new Date().toISOString() }] as any,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    profile: {
      id: "demo-user",
      email,
      name,
      plan: "pro",
      credits: 10000,
      plan_expires_at: null,
      is_active: true,
      local_only_mode: false,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    },
  };
}

function loadDemoUser(): (User & { profile: Profile }) | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(DEMO_USER_KEY);
    return raw ? (JSON.parse(raw) as User & { profile: Profile }) : null;
  } catch {
    return null;
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<(User & { profile?: Profile }) | null>(null);
  const [loading, setLoading] = useState(true);
  const demoMode = isDemoMode();
  const supabase = getBrowserSupabase();

  const fetchProfile = async (userId: string): Promise<Profile | null> => {
    const { data, error } = await supabase
      .from("profiles")
      .select("*")
      .eq("id", userId)
      .single();
    if (error) return null;
    return data;
  };

  const fetchUser = async () => {
    if (demoMode) {
      setUser(loadDemoUser());
      setLoading(false);
      return;
    }
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (session?.user) {
        const profile = await fetchProfile(session.user.id);
        setUser({ ...session.user, profile: profile || undefined });
        // Fire-and-forget: deduped server-side (sent_emails), safe to call
        // on every session resolution, not just a true "first" login.
        fetch("/api/account", { method: "POST" }).catch(() => {});
      } else {
        setUser(null);
      }
    } catch {
      setUser(null);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchUser();

    if (!demoMode) {
      const { data: { subscription } } = supabase.auth.onAuthStateChange(async (event: string, session: any) => {
if (session?.user) {
            const profile = await fetchProfile(session.user.id);
            setUser({ ...session.user, profile: profile || undefined });
          } else {
            setUser(null);
          }
      });
      return () => subscription.unsubscribe();
    }
  }, [demoMode]);

  const login = async (email: string, password: string) => {
    if (demoMode) {
      if (!password || password.length < 6) {
        throw new Error("Demo mode: use a password of 6+ characters (any account works).");
      }
      const name = email.split("@")[0].replace(/[^a-zA-Z0-9]/g, " ") || "Demo User";
      const u = demoUser(email, name);
      window.localStorage.setItem(DEMO_USER_KEY, JSON.stringify(u));
      setUser(u);
      return;
    }
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) throw error;
    await fetchUser();
  };

  const register = async (email: string, password: string, name: string) => {
    if (demoMode) {
      if (!password || password.length < 6) {
        throw new Error("Password must be at least 6 characters long.");
      }
      const u = demoUser(email, name || email.split("@")[0]);
      window.localStorage.setItem(DEMO_USER_KEY, JSON.stringify(u));
      setUser(u);
      return { needsEmailConfirmation: false };
    }
    const { data, error } = await supabase.auth.signUp({ email, password, options: { data: { name } } });
    if (error) throw error;
    // Supabase returns a user but no session when email confirmation is
    // required (the project default) -- there's nothing to log in with yet,
    // so callers must not treat this the same as an immediate sign-in.
    if (!data.session) {
      return { needsEmailConfirmation: true };
    }
    await fetchUser();
    return { needsEmailConfirmation: false };
  };

  const logout = async () => {
    if (demoMode) {
      window.localStorage.removeItem(DEMO_USER_KEY);
      setUser(null);
      return;
    }
    await supabase.auth.signOut();
    setUser(null);
  };

  const refreshUser = async () => {
    await fetchUser();
  };

  const updateProfile = async (updates: Partial<Profile>) => {
    if (demoMode) {
      const current = loadDemoUser() ?? user;
      if (!current) return;
      const next: User & { profile: Profile } = { 
        ...current, 
        profile: { ...current.profile!, ...updates, id: current.profile?.id || current.id } as Profile
      };
      window.localStorage.setItem(DEMO_USER_KEY, JSON.stringify(next));
      setUser(next);
      return;
    }
    if (!user) return;
    const { error } = await supabase.from("profiles").update(updates).eq("id", user.id);
    if (error) throw error;
    await fetchUser();
  };

  const requestPasswordReset = async (email: string) => {
    if (demoMode) {
      throw new Error("Password reset isn't available in demo mode (no email backend configured).");
    }
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${window.location.origin}/reset-password`,
    });
    if (error) throw error;
  };

  const updatePassword = async (newPassword: string) => {
    if (demoMode) {
      throw new Error("Password reset isn't available in demo mode (no email backend configured).");
    }
    const { error } = await supabase.auth.updateUser({ password: newPassword });
    if (error) throw error;
  };

  return (
    <AuthContext.Provider
      value={{ user, loading, demoMode, login, register, logout, refreshUser, updateProfile, requestPasswordReset, updatePassword }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error("useAuth must be used within AuthProvider");
  }
  return context;
};