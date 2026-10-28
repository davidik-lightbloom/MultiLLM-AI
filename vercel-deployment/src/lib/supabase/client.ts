import { createClient, SupabaseClient } from '@supabase/supabase-js';

// Check if we're in build time (no env vars)
const isBuildTime = !process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
// The server (service-role) client additionally needs its own secret key --
// missing it is just as fatal as missing the public vars (constructing a
// Supabase client with an undefined key throws immediately), so build/boot
// with it unset must fall back to the same mock rather than crash.
const isServerBuildTime = isBuildTime || !process.env.SUPABASE_SERVICE_ROLE_KEY;

let _supabaseServer: SupabaseClient<any, "public", any> | null = null;

const mockClient = {
  from: () => ({
    select: () => ({ eq: () => ({ single: () => Promise.resolve({ data: null, error: null }) }) }),
    insert: () => ({ select: () => ({ single: () => Promise.resolve({ data: null, error: null }) }) }),
    update: () => ({ eq: () => ({ select: () => ({ single: () => Promise.resolve({ data: null, error: null }) }) }) }),
    delete: () => ({ eq: () => Promise.resolve({ data: null, error: null }) }),
  }),
  storage: { from: () => ({ upload: () => Promise.resolve({ data: null, error: null }), download: () => Promise.resolve({ data: null, error: null }), list: () => Promise.resolve({ data: [], error: null }) }) },
  auth: { getSession: () => Promise.resolve({ data: { session: null }, error: null }), onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }) },
} as any;

// Service-role server client only -- the browser-side client lives in
// lib/supabase/browserClient.ts (a single shared instance; see its comment
// for why there must only be one).
export const getSupabaseServer = () => {
  if (isServerBuildTime) {
    return mockClient;
  }

  if (!_supabaseServer) {
    _supabaseServer = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
      { auth: { persistSession: false } }
    );
  }
  return _supabaseServer;
};

export const createServerSupabaseClient = getSupabaseServer;