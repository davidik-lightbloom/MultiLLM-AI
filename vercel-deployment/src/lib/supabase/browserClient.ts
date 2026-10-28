import { createBrowserClient } from "@supabase/ssr";
import type { Database } from "@/types/supabase";

// Single browser-side Supabase client for the whole app. Previously
// AuthProvider and the billing page each constructed their own client
// (createBrowserClient in AuthProvider, plain createClient in
// lib/supabase/client.ts) -- two independent GoTrueClient instances reading
// and writing the same storage key, which Supabase warns about and which can
// race on token refresh. Everything client-side should import this instead
// of constructing its own.
let _client: ReturnType<typeof createBrowserClient<Database>> | null = null;

export function getBrowserSupabase() {
  if (typeof window === "undefined") {
    // Mock for the server-rendered pass of "use client" components -- never
    // actually hits the network, just keeps shape-compatible call sites from
    // throwing before useEffect takes over client-side.
    return {
      from: () => ({
        select: () => ({ eq: () => ({ single: () => Promise.resolve({ data: null, error: null }) }) }),
        insert: () => ({ select: () => ({ single: () => Promise.resolve({ data: null, error: null }) }) }),
        update: () => ({ eq: () => ({ select: () => ({ single: () => Promise.resolve({ data: null, error: null }) }) }) }),
        delete: () => ({ eq: () => Promise.resolve({ data: null, error: null }) }),
      }),
      auth: {
        getSession: () => Promise.resolve({ data: { session: null }, error: null }),
        onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
      },
    } as any;
  }

  if (!_client) {
    _client = createBrowserClient<Database>(
      process.env.NEXT_PUBLIC_SUPABASE_URL || "",
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || ""
    );
  }
  return _client;
}
