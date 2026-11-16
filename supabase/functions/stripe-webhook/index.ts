// Stripe calls this when a checkout finishes or expires. Deploy with --no-verify-jwt (Stripe has no Supabase login).
// Secrets needed: STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET.
import Stripe from "https://esm.sh/stripe@14.25.0?target=deno";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY") ?? "", {
  apiVersion: "2024-06-20",
  httpClient: Stripe.createFetchHttpClient(),
});
const WEBHOOK_SECRET = Deno.env.get("STRIPE_WEBHOOK_SECRET") ?? "";
const asServer = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "");
const crypto = Stripe.createSubtleCryptoProvider();

Deno.serve(async (req) => {
  const signature = req.headers.get("stripe-signature");
  if (!signature) return new Response("missing signature", { status: 400 });
  const raw = await req.text();
  let event: Stripe.Event;
  try {
    event = await stripe.webhooks.constructEventAsync(raw, signature, WEBHOOK_SECRET, undefined, crypto);
  } catch (e) {
    return new Response("bad signature: " + (e instanceof Error ? e.message : ""), { status: 400 });
  }

  const session = event.data.object as Stripe.Checkout.Session;
  const orderId = session?.metadata?.order_id;
  if (!orderId) return new Response("ignored", { status: 200 });

  if (event.type === "checkout.session.completed" || event.type === "checkout.session.async_payment_succeeded") {
    if (session.payment_status === "paid") {
      // The buyer has paid, so record it even in the rare case a hold ran out (p_force); the seller sees it in Orders.
      const { error } = await asServer.rpc("mark_order_paid", { p_order: orderId, p_method: "card", p_force: true });
      if (error) return new Response("db error: " + error.message, { status: 500 }); // Stripe retries
    }
  } else if (event.type === "checkout.session.expired" || event.type === "checkout.session.async_payment_failed") {
    await asServer.rpc("cancel_order", { p_order: orderId });
  }
  return new Response("ok", { status: 200 });
});
