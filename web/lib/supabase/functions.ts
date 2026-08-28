// supabase-js's `functions.invoke()` returns a generic wrapper message on
// its top-level `error.message` — "Edge Function returned a non-2xx
// status code" — regardless of what the function itself actually said.
// The real reason (e.g. "Employee already has an account", "Not
// authorized to invite this employee") is JSON in the response body,
// reachable only through `error.context` (a Response object present
// specifically on FunctionsHttpError, not on a network-level
// FunctionsFetchError/FunctionsRelayError, which is exactly why this
// can't just read `.message` and call it done).
//
// Every `supabase.functions.invoke(...)` call in this app should resolve
// its error through this helper instead of `error.message` directly —
// otherwise a user sees "non-2xx status code" for what the function
// itself already explained clearly.
export async function resolveFunctionErrorMessage(error: unknown, fallback = "Something went wrong. Please try again."): Promise<string> {
  if (error && typeof error === "object" && "context" in error) {
    const context = (error as { context?: unknown }).context;
    if (context instanceof Response) {
      try {
        const body = await context.clone().json();
        if (typeof body?.error === "string" && body.error.trim()) return body.error;
      } catch {
        // Response body wasn't JSON (or was already consumed) — fall
        // through to the generic message below rather than throw.
      }
    }
  }
  return error instanceof Error && error.message ? error.message : fallback;
}
