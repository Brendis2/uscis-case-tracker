import { createClient } from '@supabase/supabase-js';

export function supabase() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) throw new Error('Configure Supabase in .env.local first.');
  return createClient(url, key);
}
