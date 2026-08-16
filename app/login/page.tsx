import { redirect } from "next/navigation";
import { isSupabaseConfigured } from "@/lib/supabase/config";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { EmptyState, ButtonLink } from "@/components/ui";

async function signIn(formData: FormData) {
  "use server";
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.auth.signInWithPassword({
    email: String(formData.get("email") ?? ""),
    password: String(formData.get("password") ?? ""),
  });
  if (error) redirect(`/login?error=${encodeURIComponent(error.message)}`);
  redirect("/portfolio");
}

async function signUp(formData: FormData) {
  "use server";
  const supabase = await createSupabaseServerClient();
  const username = String(formData.get("username") ?? "").trim();
  const { error } = await supabase.auth.signUp({
    email: String(formData.get("email") ?? ""),
    password: String(formData.get("password") ?? ""),
    // handle_new_user() reads this to seed the profile row.
    options: { data: { username } },
  });
  if (error) redirect(`/login?error=${encodeURIComponent(error.message)}`);
  redirect("/portfolio");
}

export default async function LoginPage(props: PageProps<"/login">) {
  if (!isSupabaseConfigured()) {
    return (
      <EmptyState
        title="Accounts need a database"
        body="Create a free Supabase project, run supabase/migrations/0001_init.sql, and add your keys to .env.local. Setup steps are in the README."
        action={<ButtonLink href="/">Browse the market</ButtonLink>}
      />
    );
  }

  const { error, mode } = await props.searchParams;
  const isSignUp = mode === "signup";

  return (
    <div className="rise mx-auto max-w-sm">
      <h1 className="text-2xl font-bold tracking-tight text-ink-50">
        {isSignUp ? "Create an account" : "Sign in"}
      </h1>
      <p className="mt-1.5 text-sm text-ink-400">
        {isSignUp
          ? "Every new trader starts with $100,000 in play money."
          : "Welcome back to the exchange."}
      </p>

      <form action={isSignUp ? signUp : signIn} className="mt-6 space-y-3">
        {isSignUp && (
          <Field name="username" label="Username" type="text" required minLength={3} maxLength={20} />
        )}
        <Field name="email" label="Email" type="email" required />
        <Field name="password" label="Password" type="password" required minLength={6} />

        {error && (
          <p className="rounded-lg bg-down-dim px-3 py-2 text-xs text-down">{error}</p>
        )}

        <button
          type="submit"
          className="w-full rounded-lg bg-accent py-2.5 text-sm font-bold text-ink-950 transition-all hover:brightness-110"
        >
          {isSignUp ? "Create account" : "Sign in"}
        </button>
      </form>

      <p className="mt-4 text-center text-xs text-ink-400">
        {isSignUp ? (
          <a href="/login" className="text-accent hover:underline">
            Already have an account? Sign in
          </a>
        ) : (
          <a href="/login?mode=signup" className="text-accent hover:underline">
            New here? Create an account
          </a>
        )}
      </p>
    </div>
  );
}

function Field({
  name,
  label,
  type,
  required,
  minLength,
  maxLength,
}: {
  name: string;
  label: string;
  type: string;
  required?: boolean;
  minLength?: number;
  maxLength?: number;
}) {
  return (
    <div>
      <label
        htmlFor={name}
        className="block text-[10px] font-semibold uppercase tracking-wider text-ink-400"
      >
        {label}
      </label>
      <input
        id={name}
        name={name}
        type={type}
        required={required}
        minLength={minLength}
        maxLength={maxLength}
        autoComplete={type === "password" ? "current-password" : name}
        className="mt-1 w-full rounded-lg border border-ink-700 bg-ink-900 px-3 py-2.5 text-sm text-ink-50 focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
      />
    </div>
  );
}
