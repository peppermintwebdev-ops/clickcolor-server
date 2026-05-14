const express = require('express');
const crypto  = require('crypto');
const fetch   = (...args) => import('node-fetch').then(({default: f}) => f(...args));

const app  = express();
const PORT = process.env.PORT || 3000;

// ── ENV VARS (set these in Railway dashboard) ──
const SHOPIFY_STORE        = process.env.SHOPIFY_STORE;        // e.g. yourstore.myshopify.com
const SHOPIFY_ADMIN_TOKEN  = process.env.SHOPIFY_ADMIN_TOKEN;  // Admin API access token
const SHOPIFY_WEBHOOK_SECRET = process.env.SHOPIFY_WEBHOOK_SECRET; // Webhook signing secret
const NOTIFY_EMAIL         = process.env.NOTIFY_EMAIL;         // Your email for notifications
const SENDGRID_API_KEY     = process.env.SENDGRID_API_KEY;     // SendGrid API key

// ── MIDDLEWARE ──
// Raw body needed for webhook signature verification
app.use('/webhook', express.raw({ type: 'application/json' }));
app.use(express.json());

// Allow requests from your Shopify store
app.use(function(req, res, next) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// ── HEALTH CHECK ──
app.get('/', function(req, res) {
  res.json({ status: 'ClickColor server running' });
});

// ══════════════════════════════════════════
// WEBHOOK — Shopify calls this when someone
// completes a subscription checkout
// ══════════════════════════════════════════
app.post('/webhook/orders/paid', async function(req, res) {
  // 1. Verify the request actually came from Shopify
  const hmac      = req.headers['x-shopify-hmac-sha256'];
  const body      = req.body; // raw buffer
  const digest    = crypto
    .createHmac('sha256', SHOPIFY_WEBHOOK_SECRET)
    .update(body)
    .digest('base64');

  if (digest !== hmac) {
    console.log('Webhook signature mismatch — ignoring');
    return res.sendStatus(401);
  }

  // 2. Parse the order
  let order;
  try { order = JSON.parse(body.toString()); }
  catch(e) { return res.sendStatus(400); }

  const customerEmail = order.email;
  const customerId    = order.customer && order.customer.id;

  if (!customerId) {
    console.log('No customer on order — skipping');
    return res.sendStatus(200);
  }

  console.log('New subscription order for:', customerEmail);

  // 3. Tag the customer as pro_subscriber in Shopify
  try {
    // First get existing tags so we don't overwrite them
    const customerRes = await fetch(
      `https://${SHOPIFY_STORE}/admin/api/2024-01/customers/${customerId}.json`,
      { headers: { 'X-Shopify-Access-Token': SHOPIFY_ADMIN_TOKEN } }
    );
    const customerData = await customerRes.json();
    const existingTags = customerData.customer.tags || '';

    // Add pro_subscriber tag if not already there
    const tagsArray = existingTags.split(',').map(t => t.trim()).filter(Boolean);
    if (!tagsArray.includes('pro_subscriber')) {
      tagsArray.push('pro_subscriber');
    }
    const newTags = tagsArray.join(', ');

    await fetch(
      `https://${SHOPIFY_STORE}/admin/api/2024-01/customers/${customerId}.json`,
      {
        method: 'PUT',
        headers: {
          'X-Shopify-Access-Token': SHOPIFY_ADMIN_TOKEN,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ customer: { id: customerId, tags: newTags } })
      }
    );

    console.log('Tagged customer as pro_subscriber:', customerEmail);
  } catch(e) {
    console.error('Failed to tag customer:', e.message);
  }

  // 4. Email you a notification
  if (SENDGRID_API_KEY && NOTIFY_EMAIL) {
    try {
      await fetch('https://api.sendgrid.com/v3/mail/send', {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + SENDGRID_API_KEY,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          personalizations: [{ to: [{ email: NOTIFY_EMAIL }] }],
          from: { email: NOTIFY_EMAIL },
          subject: '🎉 New ClickColor Pro subscriber!',
          content: [{
            type: 'text/plain',
            value: `New subscriber!\n\nEmail: ${customerEmail}\nOrder: #${order.order_number}\nAmount: $${order.total_price}\n\nThey have been automatically tagged as pro_subscriber.`
          }]
        })
      });
      console.log('Notification email sent to:', NOTIFY_EMAIL);
    } catch(e) {
      console.error('Failed to send notification email:', e.message);
    }
  }

  res.sendStatus(200);
});

// ══════════════════════════════════════════
// LOGIN — checks customer tags against
// Shopify and returns isPro status
// ══════════════════════════════════════════
app.post('/login', async function(req, res) {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required.' });
  }

  try {
    // Use Shopify Storefront API to authenticate the customer
    const tokenRes = await fetch(
      `https://${SHOPIFY_STORE}/api/2024-01/graphql.json`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Shopify-Storefront-Access-Token': process.env.SHOPIFY_STOREFRONT_TOKEN
        },
        body: JSON.stringify({
          query: `mutation {
            customerAccessTokenCreate(input: { email: "${email}", password: "${password}" }) {
              customerAccessToken { accessToken }
              customerUserErrors { message }
            }
          }`
        })
      }
    );

    const tokenData = await tokenRes.json();
    const result = tokenData.data.customerAccessTokenCreate;

    if (result.customerUserErrors.length > 0) {
      return res.status(401).json({ error: 'Invalid email or password.' });
    }

    const accessToken = result.customerAccessToken.accessToken;

    // Get customer details including tags
    const customerRes = await fetch(
      `https://${SHOPIFY_STORE}/api/2024-01/graphql.json`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Shopify-Storefront-Access-Token': process.env.SHOPIFY_STOREFRONT_TOKEN,
          'X-Shopify-Customer-Access-Token': accessToken
        },
        body: JSON.stringify({
          query: `{
            customer(customerAccessToken: "${accessToken}") {
              firstName
              lastName
              email
              tags
            }
          }`
        })
      }
    );

    const customerData = await customerRes.json();
    const customer = customerData.data.customer;

    if (!customer) {
      return res.status(401).json({ error: 'Could not retrieve account details.' });
    }

    const isPro = customer.tags.includes('pro_subscriber');
    const name  = [customer.firstName, customer.lastName].filter(Boolean).join(' ') || email;

    return res.json({ name, email, isPro });

  } catch(e) {
    console.error('Login error:', e.message);
    return res.status(500).json({ error: 'Server error. Please try again.' });
  }
});

app.listen(PORT, function() {
  console.log('ClickColor server running on port', PORT);
});
