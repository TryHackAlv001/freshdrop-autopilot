# FreshDrop autopilot agent

Handles the "vendor marks an item unavailable on an active order" exception
end-to-end: finds a substitute, recalculates the total, refunds/charges the
difference, notifies the customer — or escalates to a human if the case is
too risky to handle alone.

Built for the Global AI Hackathon Series with Qwen Cloud — Track 4,
Autopilot Agent.

## How it fits together

```
Vendor marks item unavailable (FreshDrop app)
        |
        v
Supabase Edge Function  ---webhook--->  This service (Alibaba Cloud)
                                              |
                                              v
                                         Qwen Cloud (reasoning + tool calls)
                                              |
                                   +----------+----------+
                                   |                     |
                            Auto-resolved          Escalated to human
                       (substitute, refund,      (pending approval row,
                        notify customer)          reviewed in admin page)
```

## 1. Local setup

```bash
cp .env.example .env   # fill in real values
npm install
npm run dev
```

Sanity check:

```bash
curl http://localhost:8080/health
```

## 2. Required Supabase tables

You already have `orders`, `order_items`, `vendor_profiles`, `menu_items`,
and `notifications` from FreshDrop. Add one new table for the human-in-loop
queue:

```sql
create table agent_approvals (
  id uuid primary key default gen_random_uuid(),
  order_id uuid references orders(id),
  reason text not null,
  proposed_action jsonb not null,
  status text not null default 'pending', -- pending | approved | rejected
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  resolved_by uuid
);

alter table agent_approvals enable row level security;
-- service role bypasses RLS automatically; add an admin-only select policy
-- for whatever role reviews these in your admin dashboard.
```

## 3. Wiring the trigger

Add a Supabase Edge Function (or a Postgres trigger + `pg_net` call) that
fires when an order's status changes to something like
`item_unavailable`, and POSTs to this service:

```
POST https://<your-alibaba-cloud-host>/webhook/order-exception
Headers: x-webhook-secret: <WEBHOOK_SHARED_SECRET>
Body: { "order_id": "...", "event_type": "item_unavailable" }
```

## 4. Deploying on Alibaba Cloud (required for submission)

Simplest path — a single ECS instance running the service directly:

1. Spin up a small ECS instance (Ubuntu, 1–2 vCPU is plenty for a demo).
2. SSH in, install Node 20+, clone this repo.
3. `npm install --production`, copy your real `.env` onto the instance
   (don't commit it).
4. Run it persistently: `npm install -g pm2 && pm2 start index.js --name freshdrop-agent`
5. Open port 8080 (or whichever `PORT` you set) in the instance's security group.
6. Point your Supabase Edge Function's webhook URL at
   `http://<ecs-public-ip>:8080/webhook/order-exception`.

For the submission's "proof of deployment" requirement: record a short
screen capture showing the Alibaba Cloud ECS console with the instance
running, alongside a terminal `curl` hitting the public IP's `/health`
endpoint and getting a response. That's the proof clip — keep it separate
from your main 3-minute demo video.

Check the hackathon's Resources tab for any official Alibaba Cloud
deployment template — if Qwen Cloud provides a preferred path (e.g.
Function Compute or a container template), that may be faster than a raw
ECS box and worth switching to.

## 5. What's stubbed vs real

- `tools.js` → `getOrderContext`, `getVendorInventory`, `notifyCustomer`,
  `createApprovalRequest`: real Supabase calls, just point them at your
  actual FreshDrop schema/column names.
- `tools.js` → `processRefund`: stubbed. Wire in the real Paystack/Flutterwave
  fetch call using whichever integration FreshDrop already has — the shape
  is already correct, it just returns a mock success right now so the full
  agent loop runs end-to-end before that's connected.

## 6. Demo script for the video

1. Show an active FreshDrop order.
2. Vendor marks one item unavailable.
3. Show the agent's logs/transcript finding a substitute, recalculating
   the total, refunding the difference, and notifying the customer.
4. Trigger a second exception where the price delta is large — show it
   landing in `agent_approvals` as pending instead of auto-executing.
5. Approve it from the admin page, show the action completing.

That sequence alone demonstrates every judging criterion: real tool use,
clean escalation logic, and an authentic FreshDrop problem solved end-to-end.
