const express = require('express');
const crypto  = require('crypto');
const fetch = require('node-fetch');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── ENV VARS (set in Railway dashboard) ──
const SHOPIFY_STORE            = process.env.SHOPIFY_STORE;           // yourstore.myshopify.com
const SHOPIFY_STOREFRONT_TOKEN = process.env.SHOPIFY_STOREFRONT_TOKEN;// shpss_xxx
const SHOPIFY_WEBHOOK_SECRET   = process.env.SHOPIFY_WEBHOOK_SECRET;  // from Shopify webhook page
const NOTIFY_EMAIL             = process.env.NOTIFY_EMAIL;            // your email
const SENDGRID_API_KEY         = process.env.SENDGRID_API_KEY;        // SG.xxx

// ── MIDDLEWARE ──
app.use('/webhook', express.raw({ type: 'application/json' }));
app.use(express.json());

app.use(function(req, res, next) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Max-Age', '86400');
    return res.sendStatus(204);
  }
  next();
});

// ── HEALTH CHECK ──
app.get('/', function(req, res) {
  res.json({ status: 'ClickColor server running' });
});

// ══════════════════════════════════════════
// WEBHOOK — Shopify fires this when a
// subscription payment goes through.
// We store the subscriber email in memory
// and send you a notification email.
// ══════════════════════════════════════════

// In-memory subscriber store
// (survives until server restarts — good enough for starters)
var subscribers = {};

app.post('/webhook/orders/paid', async function(req, res) {
  // 1. Verify request came from Shopify
  const hmac   = req.headers['x-shopify-hmac-sha256'];
  const body   = req.body;
  const digest = crypto
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
  if (!customerEmail) {
    console.log('No email on order — skipping');
    return res.sendStatus(200);
  }

  // 3. Mark as subscriber in memory
  subscribers[customerEmail.toLowerCase()] = {
    subscribedAt: new Date().toISOString(),
    orderNumber:  order.order_number,
    amount:       order.total_price
  };

  console.log('New Pro subscriber:', customerEmail);

  // 4. Email you a notification via SendGrid
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
            value: [
              'New subscriber!',
              '',
              'Email:  ' + customerEmail,
              'Order:  #' + order.order_number,
              'Amount: $' + order.total_price,
              'Date:   ' + new Date().toLocaleString(),
              '',
              'They will automatically get Pro access next time they log in.'
            ].join('\n')
          }]
        })
      });
      console.log('Notification sent to:', NOTIFY_EMAIL);
    } catch(e) {
      console.error('Failed to send notification:', e.message);
    }
  }

  res.sendStatus(200);
});

// ══════════════════════════════════════════
// LOGIN — authenticates via Shopify
// Storefront API, checks subscriber list,
// returns isPro status to your page
// ══════════════════════════════════════════
app.post('/login', async function(req, res) {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required.' });
  }

  try {
    // Step 1: get a customer access token from Shopify
    const tokenRes = await fetch(
      'https://' + SHOPIFY_STORE + '/api/2024-01/graphql.json',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Shopify-Storefront-Access-Token': SHOPIFY_STOREFRONT_TOKEN
        },
        body: JSON.stringify({
          query: `mutation {
            customerAccessTokenCreate(input: {
              email: "${email.replace(/"/g, '')}",
              password: "${password.replace(/"/g, '')}"
            }) {
              customerAccessToken { accessToken }
              customerUserErrors { message }
            }
          }`
        })
      }
    );

    const tokenData = await tokenRes.json();

    if (!tokenData.data || !tokenData.data.customerAccessTokenCreate) {
      return res.status(500).json({ error: 'Could not reach Shopify. Please try again.' });
    }

    const result = tokenData.data.customerAccessTokenCreate;

    if (result.customerUserErrors.length > 0) {
      return res.status(401).json({ error: 'Invalid email or password.' });
    }

    const accessToken = result.customerAccessToken.accessToken;

    // Step 2: get customer name and order history
    const customerRes = await fetch(
      'https://' + SHOPIFY_STORE + '/api/2024-01/graphql.json',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Shopify-Storefront-Access-Token': SHOPIFY_STOREFRONT_TOKEN
        },
        body: JSON.stringify({
          query: `{
            customer(customerAccessToken: "${accessToken}") {
              firstName
              lastName
              email
              orders(first: 20) {
                edges {
                  node {
                    financialStatus
                    lineItems(first: 5) {
                      edges {
                        node {
                          title
                        }
                      }
                    }
                  }
                }
              }
            }
          }`
        })
      }
    );

    const customerData = await customerRes.json();
    const customer = customerData.data && customerData.data.customer;

    if (!customer) {
      return res.status(401).json({ error: 'Could not retrieve account details.' });
    }

    const name = [customer.firstName, customer.lastName].filter(Boolean).join(' ') || email;

    // Step 3: check if Pro
    // Two ways someone can be Pro:
    // A) Their email is in our webhook subscriber list
    // B) They have a paid order containing "ClickColor Pro" in the line items
    var isPro = false;

    // Check A — webhook list
    if (subscribers[email.toLowerCase()]) {
      isPro = true;
    }

    // Check B — order history
    if (!isPro && customer.orders && customer.orders.edges) {
      customer.orders.edges.forEach(function(edge) {
        var order = edge.node;
        if (order.financialStatus === 'PAID') {
          order.lineItems.edges.forEach(function(item) {
            var title = (item.node.title || '').toLowerCase();
            if (title.includes('clickcolor') || title.includes('pro')) {
              isPro = true;
            }
          });
        }
      });
    }

    return res.json({ name: name, email: email, isPro: isPro });

  } catch(e) {
    console.error('Login error:', e.message);
    return res.status(500).json({ error: 'Server error. Please try again.' });
  }
});

app.listen(PORT, function() {
  console.log('ClickColor server running on port', PORT);
});
