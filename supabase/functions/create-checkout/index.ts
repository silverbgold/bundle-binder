// Turns the buyer's cart into an order and opens a Stripe Checkout page for it.
// Secrets needed (supabase secrets set ...): STRIPE_SECRET_KEY, SITE_URL. Optional: STRIPE_CURRENCY (default "usd").
import Stripe from "https://esm.sh/stripe@14.25.0?target=deno";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY") ?? "", {
  apiVersion: "2024-06-20",
  httpClient: Stripe.createFetchHttpClient(),
});
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const ANON = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const SITE_URL = (Deno.env.get("SITE_URL") ?? "").replace(/\/+$/, "");
const CURRENCY = (Deno.env.get("STRIPE_CURRENCY") ?? "usd").toLowerCase();

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  if (!SITE_URL) return json({ error: "SITE_URL secret is not set" }, 500);

  const authHeader = req.headers.get("Authorization") ?? "";
  const asBuyer = createClient(SUPABASE_URL, ANON, { global: { headers: { Authorization: authHeader } } });
  const asServer = createClient(SUPABASE_URL, SERVICE);

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json({ error: "bad_request" }, 400); }

  // 1. Place the order as the buyer (this checks the holds, bundle rules and totals in the database)
  const { data: placed, error } = await asBuyer.rpc("place_order", {
    p_bundle: body.p_bundle ?? null,
    p_addons: body.p_addons ?? [],
    p_delivery: body.p_delivery ?? "ship",
    p_name: body.p_name ?? "",
    p_contact: body.p_contact ?? "",
    p_address: body.p_address ?? "",
    p_note: body.p_note ?? "",
    p_method: "card",
  });
  if (error) return json({ error: error.message }, 400);

  // 2. Only send buyers back to this shop (never to an address from the request)
  const back = SITE_URL + "/";
  const contact = String(body.p_contact ?? "");
  try {
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      line_items: [{
        quantity: 1,
        price_data: {
          currency: CURRENCY,
          unit_amount: placed.total_cents,
          product_data: { name: `Card order ${placed.code}` },
        },
      }],
      client_reference_id: placed.order_id,
      metadata: { order_id: placed.order_id, code: placed.code },
      payment_intent_data: { metadata: { order_id: placed.order_id, code: placed.code } },
      customer_email: /@/.test(contact) ? contact.trim() : undefined,
      success_url: `${back}?paid=${encodeURIComponent(placed.code)}`,
      cancel_url: `${back}?cancelled=${encodeURIComponent(placed.order_id)}`,
      expires_at: Math.floor(Date.now() / 1000) + 31 * 60, // Stripe's minimum; cards stay held 35 minutes
    });
    await asServer.from("orders").update({ stripe_session: session.id }).eq("id", placed.order_id);
    return json({ url: session.url, code: placed.code });
  } catch (e) {
    // Stripe failed: put the cards back in the buyer's cart
    await asBuyer.rpc("cancel_my_order", { p_order: placed.order_id });
    return json({ error: "Card payments aren't available right now. " + (e instanceof Error ? e.message : "") }, 502);
  }
});
