"use client";

import { useState } from "react";
import { motion } from "framer-motion";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Lock, Mail, User, Eye, EyeOff } from "lucide-react";
import { useAuth } from "@/components/auth/AuthProvider";
import { toast } from "react-hot-toast";

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [isRegister, setIsRegister] = useState(false);
  const [name, setName] = useState("");
  const router = useRouter();
  const { login, register, demoMode } = useAuth();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email || !password || (isRegister && !name)) {
      toast.error("Please fill in all fields");
      return;
    }
    if (password.length < 6) {
      toast.error("Password must be at least 6 characters long");
      return;
    }

    setIsLoading(true);
    try {
      if (isRegister) {
        const { needsEmailConfirmation } = await register(email, password, name);
        if (needsEmailConfirmation) {
          toast.success("Account created! Check your email to confirm before signing in.", { duration: 6000 });
          setIsRegister(false);
          setPassword("");
          return;
        }
        toast.success("Account created! Welcome to MultiLLM.");
      } else {
        await login(email, password);
        toast.success("Welcome back!");
      }
      router.push("/dashboard");
      router.refresh();
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Authentication failed";
      toast.error(message);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 via-purple-50 to-blue-50 flex items-center justify-center py-12 px-4">
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5 }}
        className="w-full max-w-md"
      >
        <div className="text-center mb-8">
          <Link href="/" className="inline-flex items-center gap-2 mb-6">
            <span className="text-3xl font-bold text-purple-600">MultiLLM</span>
          </Link>
          <h1 className="text-3xl font-bold text-slate-900 mb-2">
            {isRegister ? "Create your account" : "Welcome back"}
          </h1>
          <p className="text-slate-600">
            {isRegister
              ? "Start running ensemble LLMs in seconds"
              : "Sign in to access your dashboard"}
          </p>
          {demoMode && (
            <div className="mt-3 inline-flex items-center gap-2 px-3 py-1.5 bg-amber-50 border border-amber-200 text-amber-700 rounded-full text-xs font-medium">
              <span className="w-2 h-2 rounded-full bg-amber-500 animate-pulse" />
              Demo mode — any email + 6-char password works. Connect Supabase to enable real accounts.
            </div>
          )}
        </div>

        <div className="bg-white rounded-2xl shadow-xl p-8">
          <form onSubmit={handleSubmit} className="space-y-5">
            {isRegister && (
              <div>
                <label htmlFor="name" className="block text-sm font-medium text-slate-700 mb-1">
                  Name
                </label>
                <div className="relative">
                  <User className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 w-5 h-5" />
                  <input
                    id="name"
                    type="text"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="Your name"
                    className="w-full pl-10 pr-4 py-3 rounded-xl border border-slate-300 focus:border-purple-500 focus:ring-2 focus:ring-purple-200 transition-all"
                    required
                  />
                </div>
              </div>
            )}

            <div>
              <label htmlFor="email" className="block text-sm font-medium text-slate-700 mb-1">
                Email
              </label>
              <div className="relative">
                <Mail className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 w-5 h-5" />
                <input
                  id="email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@example.com"
                  className="w-full pl-10 pr-4 py-3 rounded-xl border border-slate-300 focus:border-purple-500 focus:ring-2 focus:ring-purple-200 transition-all"
                  required
                />
              </div>
            </div>

            <div>
              <label htmlFor="password" className="block text-sm font-medium text-slate-700 mb-1">
                Password
              </label>
              <div className="relative">
                <Lock className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 w-5 h-5" />
                <input
                  id="password"
                  type={showPassword ? "text" : "password"}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••"
                  className="w-full pl-10 pr-12 py-3 rounded-xl border border-slate-300 focus:border-purple-500 focus:ring-2 focus:ring-purple-200 transition-all"
                  required
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"
                >
                  {showPassword ? <EyeOff className="w-5 h-5" /> : <Eye className="w-5 h-5" />}
                </button>
              </div>
              {!isRegister && (
                <div className="mt-2 text-right">
                  <Link href="/forgot-password" className="text-sm text-purple-600 hover:text-purple-700 font-medium">
                    Forgot password?
                  </Link>
                </div>
              )}
            </div>

            <button
              type="submit"
              disabled={isLoading}
              className="w-full py-3 px-4 bg-purple-600 hover:bg-purple-700 disabled:bg-slate-300 text-white rounded-xl font-semibold transition-colors flex items-center justify-center gap-2"
            >
              {isLoading ? (
                <>
                  <svg className="animate-spin h-5 w-5" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                  </svg>
                  {isRegister ? "Creating account..." : "Signing in..."}
                </>
              ) : (
                isRegister ? "Create Account" : "Sign In"
              )}
            </button>
          </form>

          <p className="mt-6 text-center text-slate-600">
            {isRegister ? "Already have an account?" : "Don't have an account?"}{" "}
            <button
              type="button"
              onClick={() => setIsRegister(!isRegister)}
              className="text-purple-600 hover:text-purple-700 font-medium"
            >
              {isRegister ? "Sign In" : "Sign Up"}
            </button>
          </p>
        </div>

      </motion.div>
    </div>
  );
}