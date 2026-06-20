// agent.js
//
// The reasoning loop. Qwen Cloud is exposed through an OpenAI-compatible
// endpoint (Alibaba Cloud Model Studio / DashScope), so the standard
// `openai` SDK works with just a base URL + key swap.
 
import OpenAI from "openai";
import * as tools from "./tools.js";
 
const client = new OpenAI({
  apiKey: process.env.DASHSCOPE_API_KEY,
  baseURL: process.env.QWEN_BASE_URL || "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
});
 
const MODEL = process.env.QWEN_MODEL || "qwen-plus";
 
// Tool schemas the model can choose to call. Names must match the
// functions exported from tools.js exactly — the dispatch table below
// relies on that. Param names match FreshDrop's real schema.
const TOOL_SCHEMAS = [
  {
    type: "function",
    function: {
      name: "getOrderContext",
      description: "Fetch the order, its line items, the vendor, the buyer, and the buyer's recent dispute history.",
      parameters: {
        type: "object",
        properties: { order_id: { type: "string" } },
        required: ["order_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "getVendorInventory",
      description: "Find in-stock substitute products from the same vendor for an unavailable product.",
      parameters: {
        type: "object",
        properties: {
          vendor_id: { type: "string" },
          exclude_product_id: { type: "string" },
          category_id: { type: "string", description: "Optional category_id filter to keep substitutes relevant" },
        },
        required: ["vendor_id", "exclude_product_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "recalcOrderTotal",
      description: "Recalculate the order total after a substitution and flag whether the price delta needs human approval.",
      parameters: {
        type: "object",
        properties: {
          original_total: { type: "number" },
          original_item_price: { type: "number" },
          substitute_item_price: { type: "number" },
        },
        required: ["original_total", "original_item_price", "substitute_item_price"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "processRefund",
      description: "Issue a refund via the order's payment_method/payment_reference.",
      parameters: {
        type: "object",
        properties: {
          provider: { type: "string", enum: ["paystack", "flutterwave"] },
          payment_reference: { type: "string" },
          amount: { type: "number" },
        },
        required: ["provider", "payment_reference", "amount"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "notifyCustomer",
      description: "Send the buyer a notification (title + body) about what happened to their order.",
      parameters: {
        type: "object",
        properties: {
          user_id: { type: "string", description: "The buyer's users.id" },
          title: { type: "string" },
          body: { type: "string" },
          link: { type: "string", description: "Optional deep link, e.g. /orders/<id>" },
        },
        required: ["user_id", "title", "body"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "createApprovalRequest",
      description:
        "Pause and request human approval instead of acting autonomously. Use this whenever the price delta exceeds the auto-resolve threshold, there's no good substitute, or the buyer has multiple recent disputes.",
      parameters: {
        type: "object",
        properties: {
          order_id: { type: "string" },
          buyer_id: { type: "string" },
          reason: { type: "string" },
          proposed_action: { type: "object", description: "What the agent would do if approved" },
        },
        required: ["order_id", "buyer_id", "reason", "proposed_action"],
      },
    },
  },
];
 
const TOOL_DISPATCH = {
  getOrderContext: tools.getOrderContext,
  getVendorInventory: tools.getVendorInventory,
  recalcOrderTotal: tools.recalcOrderTotal,
  processRefund: tools.processRefund,
  notifyCustomer: tools.notifyCustomer,
  createApprovalRequest: tools.createApprovalRequest,
};
 
const SYSTEM_PROMPT = `You are FreshDrop's order-exception agent. A vendor has just \
marked a specific product unavailable on an active order. Your job:
 
1. Look up the full order context (order, line items, vendor, buyer, dispute history).
2. Find the unavailable line item in order.order_items by product_id and note its \
price_at_purchase.
3. Try to find a reasonable substitute product from the same vendor (same \
category_id where possible).
4. Recalculate the total using the substitute's price and check the price delta.
5. If a good substitute exists AND the price delta is within the auto-resolve \
threshold AND the buyer doesn't have repeated recent disputes: process any \
refund/charge needed (use order.payment_method as provider and \
order.payment_reference), notify the buyer with a clear title + body, and stop.
6. Otherwise — no good substitute, price delta too large, or repeat disputes — \
create a human approval request explaining why, with your proposed action \
included so a reviewer can approve it in one click. Do NOT take the action \
yourself in this case.
 
Always explain your reasoning briefly in your final message after tool calls \
finish, so it's clear why you auto-resolved or escalated.`;
 
/**
 * Runs the full reasoning loop for one order-exception event.
 * Returns the final assistant message plus a transcript of every tool
 * call made, which is useful both for logging and for the demo video.
 */
export async function runAgent({ order_id, event_type, product_id }) {
  const messages = [
    { role: "system", content: SYSTEM_PROMPT },
    {
      role: "user",
      content: `Order exception event: ${event_type}. Order ID: ${order_id}. Unavailable product ID: ${product_id}. Handle it.`,
    },
  ];
 
  const transcript = [];
  const MAX_TURNS = 8; // safety cap so a confused model can't loop forever
 
  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const completion = await client.chat.completions.create({
      model: MODEL,
      messages,
      tools: TOOL_SCHEMAS,
    });
 
    const choice = completion.choices[0];
    messages.push(choice.message);
 
    const toolCalls = choice.message.tool_calls;
    if (!toolCalls || toolCalls.length === 0) {
      // Model is done — this is its final summary.
      return { final_message: choice.message.content, transcript };
    }
 
    for (const call of toolCalls) {
      const fn = TOOL_DISPATCH[call.function.name];
      let result;
      if (!fn) {
        result = { error: `Unknown tool: ${call.function.name}` };
      } else {
        const args = JSON.parse(call.function.arguments || "{}");
        result = await fn(args);
      }
 
      transcript.push({ tool: call.function.name, args: call.function.arguments, result });
 
      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: JSON.stringify(result),
      });
    }
  }
 
  return {
    final_message: "Agent hit the turn limit without resolving — escalate manually.",
    transcript,
  };
}
 
