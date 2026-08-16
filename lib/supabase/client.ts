"use client";

import { createBrowserClient } from "@supabase/ssr";
import { supabaseAnonKey, supabaseUrl } from "./config";

let client: ReturnType<typeof createBrowserClient> | null = null;

/** Browser Supabase client. Reused so realtime keeps a single socket. */
export function getSupabaseBrowserClient() {
  if (!client) {
    client = createBrowserClient(supabaseUrl(), supabaseAnonKey());
  }
  return client;
}
