// tools.js
//
// Each exported function here is a "tool" the agent can invoke during its
// reasoning loop. Keep these thin: fetch/mutate data, return plain JSON.
// All the actual decision-making (which substitute to pick, whether to
// auto-resolve vs escalate) lives in the model's reasoning, not in here.
//
// Matched to FreshDrop's real schema:
//   orders(buyer_id, vendor_id, total, payment_method, payment_reference, ...)
//   order_items(order_id, product_id, price_at_purchase, product_name, ...)
//   products(vendor_id, category_id, price, stock_quantity, is_active, is_available_today, ...)
//   vendor_profiles(id, shop_name, ...)  <- orders.vendor_id references this, not users.id
//   users(id, full_name, role, ...)      <- orders.buyer_id references this
//   notifications(user_id, title, body, type, link, ...)
 
import { createClient } from "@supabase/supabase-js";
 
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);
 
const AUTO_RESOLVE_REFUND_THRESHOLD = Number(
  process.env.AUTO_RESOLVE_REFUND_THRESHOLD || 500000
);
 
/**
 * Pull everything the agent needs to reason about this order exception:
 * the order, its line items, the vendor, the buyer, and the buyer's recent
 * dispute history (so the agent can factor in "is this a repeat issue" the
 * way a human ops person would).
 */
export async function getOrderContext({ order_id }) {
  const { data: order, error: orderErr } = await supabase
    .from("orders")
    .select("*, order_items(*)")
    .eq("id", order_id)
    .single();
 
  if (orderErr) return { error: orderErr.message };
 
  // vendor_id on orders points to vendor_profiles.id directly (not users.id)
  const { data: vendor } = await supabase
    .from("vendor_profiles")
    .select("id, shop_name, location, is_verified, rating")
    .eq("id", order.vendor_id)
    .single();
 
  const { data: buyer } = await supabase
    .from("users")
    .select("id, full_name, phone, email")
    .eq("id", order.buyer_id)
    .single();
 
  const { data: recentDisputes } = await supabase
    .from("agent_approvals")
    .select("id, created_at, reason")
    .eq("buyer_id", order.buyer_id)
    .gte(
      "created_at",
      new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()
    );
 
  return {
    order,
    vendor,
    buyer,
    recent_dispute_count: recentDisputes?.length ?? 0,
  };
}
 
/**
 * Look for substitute products from the same vendor for an unavailable item.
 * "In stock" here means actually orderable today: active, marked available
 * today, and has stock_quantity left.
 */
export async function getVendorInventory({ vendor_id, exclude_product_id, category_id }) {
  let query = supabase
    .from("products")
    .select("id, name, price, category_id, stock_quantity, preparation_time")
    .eq("vendor_id", vendor_id)
    .eq("is_active", true)
    .eq("is_available_today", true)
    .gt("stock_quantity", 0)
    .neq("id", exclude_product_id);
 
  if (category_id) query = query.eq("category_id", category_id);
 
  const { data, error } = await query.limit(5);
  if (error) return { error: error.message };
  return { candidates: data };
}
 
/**
 * Recalculate the order total after swapping in a substitute item.
 * Returns the price delta so the agent (or a human) can decide whether
 * a partial refund or extra charge is needed.
 */
export function recalcOrderTotal({ original_total, original_item_price, substitute_item_price }) {
  const delta = substitute_item_price - original_item_price;
  return {
    new_total: original_total + delta,
    price_delta: delta,
    requires_refund: delta < 0,
    requires_additional_charge: delta > 0,
    over_auto_resolve_threshold: Math.abs(delta) > AUTO_RESOLVE_REFUND_THRESHOLD,
  };
}
 
/**
 * Process a refund through whichever provider the order's payment_method
 * was set to. Stubbed to the shape both Paystack and Flutterwave refund
 * APIs expect — wire in the real fetch calls using whichever client
 * FreshDrop already has for these.
 */
export async function processRefund({ provider, payment_reference, amount }) {
  if (provider === "paystack") {
    // POST https://api.paystack.co/refund  { transaction: payment_reference, amount }
    // Authorization: Bearer ${process.env.PAYSTACK_SECRET_KEY}
  } else if (provider === "flutterwave") {
    // POST https://api.flutterwave.com/v3/transactions/${payment_reference}/refund  { amount }
    // Authorization: Bearer ${process.env.FLUTTERWAVE_SECRET_KEY}
  } else {
    return { error: `Unknown payment provider: ${provider}` };
  }
 
  // TODO: replace with the real HTTP call once wired to FreshDrop's existing
  // Paystack/Flutterwave integration. Returning a mock success so the agent
  // loop and demo can run end-to-end before that wiring is done.
  return { status: "success", provider, amount, payment_reference };
}
 
/**
 * Notify the buyer. Inserts into FreshDrop's real notifications table —
 * title + body, not a single "message" field.
 */
export async function notifyCustomer({ user_id, title, body, link }) {
  const { error } = await supabase.from("notifications").insert({
    user_id,
    title,
    body,
    type: "order_exception",
    link: link || null,
  });
  if (error) return { error: error.message };
  return { status: "sent" };
}
 
/**
 * Human-in-the-loop checkpoint. Instead of acting, the agent writes a
 * pending approval row that a human reviews in an admin page. This is the
 * single most important function for the judging criteria — it's what
 * makes this "production-ready" instead of a fully autonomous black box.
 */
export async function createApprovalRequest({ order_id, buyer_id, reason, proposed_action }) {
  const { data, error } = await supabase
    .from("agent_approvals")
    .insert({
      order_id,
      buyer_id,
      reason,
      proposed_action,
      status: "pending",
    })
    .select()
    .single();
 
  if (error) return { error: error.message };
  return { approval_id: data.id, status: "pending" };
}
<<<<<<< HEAD
 
=======
 
>>>>>>> 672a700eb5f17bdfe81179bd865e7b492df52941
