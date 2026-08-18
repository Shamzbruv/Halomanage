// Shared CORS headers for Halomanage Edge Functions. Tighten
// Access-Control-Allow-Origin to the deployed web app's origin(s) before
// going to production — "*" is convenient for local development only.
export const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

export function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
