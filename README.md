# ClickColor Server

Handles Shopify webhooks and customer login for ClickColor Pro subscriptions.

## Deploy to Railway

1. Go to railway.app and sign up for a free account
2. Click "New Project" → "Deploy from GitHub repo"
3. Upload this folder to a new GitHub repo first, then connect it
   OR use "Deploy from local" if Railway CLI is installed

## Environment Variables

Set these in your Railway project dashboard under Variables:

| Variable | Description | Example |
|----------|-------------|---------|
| SHOPIFY_STORE | Your store domain | yourstore.myshopify.com |
| SHOPIFY_ADMIN_TOKEN | Admin API access token | shpat_xxx |
| SHOPIFY_STOREFRONT_TOKEN | Storefront API token | xxx |
| SHOPIFY_WEBHOOK_SECRET | Webhook signing secret | xxx |
| NOTIFY_EMAIL | Your email for notifications | you@example.com |
| SENDGRID_API_KEY | SendGrid API key for emails | SG.xxx |

## Getting Your Shopify Tokens

### Admin API Token
1. Shopify Admin → Settings → Apps and sales channels
2. Develop apps → Create an app → name it "ClickColor Server"
3. Configure Admin API scopes — check: read_customers, write_customers, read_orders
4. Install the app → copy the Admin API access token

### Storefront API Token
1. Same app → Storefront API → check: unauthenticated_read_customers
2. Copy the Storefront API access token

### Webhook Secret
You'll get this when you create the webhook in the next step.

## Setting Up the Shopify Webhook

1. Shopify Admin → Settings → Notifications → Webhooks
2. Click "Create webhook"
3. Event: "Order payment"
4. Format: JSON
5. URL: https://YOUR-RAILWAY-URL.railway.app/webhook/orders/paid
6. Copy the signing secret → paste into Railway as SHOPIFY_WEBHOOK_SECRET

## Setting Up SendGrid (for email notifications)

1. Go to sendgrid.com → sign up free
2. Settings → API Keys → Create API Key (full access)
3. Copy the key → paste into Railway as SENDGRID_API_KEY
4. Set NOTIFY_EMAIL to the address you want notified

## Endpoints

- GET  /                        — health check
- POST /webhook/orders/paid     — Shopify calls this on subscription payment
- POST /login                   — your ClickColor page calls this on sign in
