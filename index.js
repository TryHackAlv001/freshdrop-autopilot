// index.js
//
// Entry point. Exposes a single webhook endpoint that a Supabase Edge
// Function calls whenever an order flips into an exception state
// (e.g. a vendor marks an item unavailable). This is the service you
// deploy on Alibaba Cloud — that deployment is what satisfies the
// hackathon's "proof of Alibaba Cloud deployment" requirement.

import "dotenv/config";
import express from "express";
import { runAgent } from "./agent.js";

const app = express();
app.use(express.json());

app.get("/health", (_req, res) => res.json({ status: "ok" }));

app.post("/webhook/order-exception", async (req, res) => {
  const secret = req.headers["x-webhook-secret"];
  if (secret !== process.env.WEBHOOK_SHARED_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const { order_id, event_type, product_id } = req.body;
  if (!order_id || !event_type || !product_id) {
    return res.status(400).json({ error: "order_id, event_type, and product_id are required" });
  }

  try {
    const result = await runAgent({ order_id, event_type, product_id });
    res.json(result);
  } catch (err) {
    console.error("Agent run failed:", err);
    res.status(500).json({ error: err.message });
  }
});

const port = process.env.PORT || 8080;
app.listen(port, () => {
  console.log(`FreshDrop autopilot agent listening on port ${port}`);
});