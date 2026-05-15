const express = require('express');
const https   = require('crypto') && require('https');
const crypto  = require('crypto');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── ENV VARS — set these in Railway dashboard ──
const STRIPE_SECRET   = process.env.STRIPE_SECRET;   // sk_live_xxx or sk_test_xxx
const STRIPE_WEBHOOK  = process.env.STRIPE_WEBHOOK;  // whsec_xxx
const STRIPE_PRICE_ID = process.env.STRIPE_PRICE_ID; // price_xxx
const SITE_URL        = process.env.SITE_URL || 'https://clickingasaservice.com';

// ── MIDDLEWARE ──
app.use('/webhook', express.raw({ type: 'application/json' }));
app.use(express.json());

app.use(function(req, res, next) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ── STRIPE API HELPER ──
function stripeRequest(method, path, data) {
  return new Promise(function(resolve, reject) {
    var body = '';
    if (data) {
      body = Object.keys(data).map(function(k) {
        return encodeURIComponent(k) + '=' + encodeURIComponent(data[k]);
      }).join('&');
    }

    var options = {
      hostname: 'api.stripe.com',
      path: '/v1' + path,
      method: method,
      headers: {
        'Authorization': 'Bearer ' + STRIPE_SECRET,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body)
      }
    };

    var req = require('https').request(options, function(res) {
      var chunks = [];
      res.on('data', function(c) { chunks.push(c); });
      res.on('end', function() {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
        catch(e) { reject(e); }
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// ── IN-MEMORY SUBSCRIBER CACHE ──
// Populated by webhook, checked on login
var subscribers = {};

// ── HEALTH CHECK ──
app.get('/', function(req, res) {
  res.json({ status: 'Clicking as a Service server running' });
});

// ══════════════════════════════════════════
// CREATE CHECKOUT SESSION
// Page calls this when user clicks Subscribe
// Returns a Stripe hosted checkout URL
// ══════════════════════════════════════════
app.post('/create-checkout', async function(req, res) {
  var email      = (req.body.email || '').trim();
  var successUrl = req.body.successUrl || SITE_URL + '?pro=true';
  var cancelUrl  = req.body.cancelUrl  || SITE_URL;

  if (!STRIPE_SECRET) {
    return res.status(500).json({ error: 'Payment system not configured.' });
  }

  try {
    var params = {
      'payment_method_types[]': 'card',
      'line_items[0][price]':   STRIPE_PRICE_ID,
      'line_items[0][quantity]':'1',
      'mode':                   'subscription',
      'success_url':            successUrl + '&session_id={CHECKOUT_SESSION_ID}',
      'cancel_url':             cancelUrl
    };

    if (email) params['customer_email'] = email;

    var session = await stripeRequest('POST', '/checkout/sessions', params);

    if (session.error) {
      console.error('Stripe error:', session.error.message);
      return res.status(400).json({ error: session.error.message });
    }

    console.log('Checkout session created for:', email || 'anonymous');
    return res.json({ url: session.url });

  } catch(e) {
    console.error('Checkout error:', e.message);
    return res.status(500).json({ error: 'Could not create checkout session.' });
  }
});

// ══════════════════════════════════════════
// CHECK SUBSCRIBER
// Page calls this on login / session restore
// Checks Stripe for active subscription
// ══════════════════════════════════════════
app.post('/check-subscriber', async function(req, res) {
  var email = (req.body.email || '').toLowerCase().trim();

  if (!email) {
    return res.status(400).json({ error: 'Email is required.' });
  }

  try {
    // Check in-memory cache first (fastest)
    if (subscribers[email]) {
      console.log('Pro confirmed from cache:', email);
      return res.json({ isPro: true, email: email });
    }

    // Search Stripe for customer by email
    var customers = await stripeRequest('GET',
      '/customers?email=' + encodeURIComponent(email) + '&limit=1',
      null
    );

    if (!customers.data || customers.data.length === 0) {
      console.log('No Stripe customer found for:', email);
      return res.json({ isPro: false, email: email });
    }

    var customerId = customers.data[0].id;

    // Check for active subscription
    var subscriptions = await stripeRequest('GET',
      '/subscriptions?customer=' + customerId + '&status=active&limit=1',
      null
    );

    var isPro = !!(subscriptions.data && subscriptions.data.length > 0);

    if (isPro) {
      subscribers[email] = true;
      console.log('Pro confirmed from Stripe:', email);
    } else {
      console.log('No active subscription for:', email);
    }

    return res.json({ isPro: isPro, email: email });

  } catch(e) {
    console.error('Subscriber check error:', e.message);
    return res.status(500).json({ error: 'Server error. Please try again.' });
  }
});

// ══════════════════════════════════════════
// STRIPE WEBHOOK
// Stripe calls this when payment succeeds
// Caches the subscriber email immediately
// ══════════════════════════════════════════
app.post('/webhook', function(req, res) {
  var sig  = req.headers['stripe-signature'];
  var body = req.body;

  if (!STRIPE_WEBHOOK) {
    console.log('No webhook secret set — skipping verification');
    return res.sendStatus(200);
  }

  // Verify webhook came from Stripe
  try {
    var parts = sig.split(',').reduce(function(acc, part) {
      var kv = part.split('=');
      acc[kv[0]] = kv[1];
      return acc;
    }, {});

    var payload  = parts.t + '.' + body.toString();
    var expected = crypto.createHmac('sha256', STRIPE_WEBHOOK).update(payload).digest('hex');

    if (expected !== parts.v1) {
      console.log('Webhook signature mismatch — ignoring');
      return res.sendStatus(401);
    }
  } catch(e) {
    console.error('Webhook verification error:', e.message);
    return res.sendStatus(400);
  }

  var event;
  try { event = JSON.parse(body.toString()); }
  catch(e) { return res.sendStatus(400); }

  // Cache subscriber on successful payment
  if (event.type === 'checkout.session.completed' ||
      event.type === 'invoice.payment_succeeded') {
    var obj   = event.data.object;
    var email = obj.customer_email ||
                (obj.customer_details && obj.customer_details.email);
    if (email) {
      subscribers[email.toLowerCase()] = true;
      console.log('New Pro subscriber via webhook:', email);
    }
  }

  // Remove subscriber on cancellation
  if (event.type === 'customer.subscription.deleted') {
    var custId = event.data.object.customer;
    console.log('Subscription cancelled for customer:', custId);
    // Could look up email and remove from cache here
  }

  res.sendStatus(200);
});

app.listen(PORT, function() {
  console.log('Clicking as a Service server running on port', PORT);
});
