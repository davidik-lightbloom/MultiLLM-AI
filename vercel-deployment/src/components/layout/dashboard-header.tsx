"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { LogOut } from "lucide-react";
import { useAuth } from "@/components/auth/AuthProvider";

const NAV_LINKS = [
  { href: "/dashboard", label: "Dashboard" },
  { href: "/dashboard/projects", label: "Client Projects" },
  { href: "/dashboard/api-keys", label: "API Keys" },
  { href: "/dashboard/analytics", label: "Analytics" },
  { href: "/dashboard/team", label: "Team" },
  // Training isn't linked here -- there's no working training backend in
  // production (see vercel-deployment/training-job-disabled/DISABLED.md).
  // The page itself still exists at /dashboard/training with an honest
  // "coming soon" state, for anyone who navigates there directly.
  { href: "/dashboard/billing", label: "Billing" },
  { href: "/dashboard/settings", label: "Settings" },
];

export default function DashboardHeader() {
  const { user, logout, demoMode } = useAuth();
  const pathname = usePathname();
  const router = useRouter();

  const handleLogout = async () => {
    await logout();
    router.push("/");
    router.refresh();
  };

  return (
    <header className="bg-white shadow-sm sticky top-0 z-40">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex items-center justify-between h-16">
          <div className="flex items-center gap-8">
            <Link href="/dashboard" className="flex items-center gap-2">
              <span className="text-2xl font-bold text-purple-600">MultiLLM</span>
            </Link>
            <nav className="hidden md:flex items-center gap-5">
              {NAV_LINKS.map((link) => {
                const active =
                  link.href === "/dashboard"
                    ? pathname === "/dashboard"
                    : pathname.startsWith(link.href);
                return (
                  <Link
                    key={link.href}
                    href={link.href}
                    className={
                      active
                        ? "text-purple-600 font-medium"
                        : "text-slate-700 hover:text-purple-600 font-medium"
                    }
                  >
                    {link.label}
                  </Link>
                );
              })}
            </nav>
          </div>
          <div className="flex items-center gap-4">
            {demoMode && (
              <span className="hidden sm:inline-flex items-center gap-1.5 px-2.5 py-1 bg-amber-50 border border-amber-200 text-amber-700 rounded-full text-xs font-medium">
                <span className="w-1.5 h-1.5 rounded-full bg-amber-500" />
                Demo
              </span>
            )}
            <span className="text-sm text-slate-600 capitalize">{user?.profile?.plan || "Free"}</span>
            <div className="w-8 h-8 rounded-full bg-purple-100 flex items-center justify-center text-purple-600 font-medium">
              {user?.user_metadata?.name?.charAt(0).toUpperCase() || "U"}
            </div>
            <button
              onClick={handleLogout}
              title="Sign out"
              aria-label="Sign out"
              className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-slate-600 hover:text-red-600 hover:bg-red-50 transition-colors text-sm font-medium"
            >
              <LogOut className="w-4 h-4" />
              <span className="hidden sm:inline">Sign out</span>
            </button>
          </div>
        </div>
      </div>
    </header>
  );
}
