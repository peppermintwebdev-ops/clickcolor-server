const express = require('express');
const https   = require('https');

const app  = express();
const PORT = process.env.PORT || 3000;

const STRIPE_SECRET     = process.env.STRIPE_SECRET;
const STRIPE_WEBHOOK    = process.env.STRIPE_WEBHOOK;
const STRIPE_PRICE_ID   = process.env.STRIPE_PRICE_ID;

app.use('/webhook', express.raw({ type: 'application/json' }));
app.use(express.json());

app.use(function(req, res, next) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// helper — stripe API calls
function stripeRequest(method, path, data) {
  return new Promise(function(resolve, reject) {
    var body = data ? Object.keys(data).map(function(k) {
      return encodeURIComponent(k) + '=' + encodeURIComponent(data[k]);
    }).join('&') : '';

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

    var req = https.request(options, function(res) {
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

// in-memory subscriber store
var subscribers = {};

// health check
app.get('/', function(req, res) {
  res.json({ status: 'ClickColor server running' });
});

// ══════════════════════════════════════
// CREATE CHECKOUT SESSION
// Called when user clicks Subscribe
// Returns a Stripe checkout URL
// ══════════════════════════════════════
app.post('/create-checkout', async function(req, res) {
  var email       = (req.body.email || '').trim();
var successUrl  = req.body.successUrl || process.env.SUCCESS_URL + '?pro=true';
var cancelUrl   = req.body.cancelUrl  || process.env.CANCEL_URL;

  try {
    var session = await stripeRequest('POST', '/checkout/sessions', {
      'payment_method_types[]':        'card',
      'line_items[0][price]':          STRIPE_PRICE_ID,
      'line_items[0][quantity]':       '1',
      'mode':                          'subscription',
      'customer_email':                email,
      'success_url':                   successUrl + '&session_id={CHECKOUT_SESSION_ID}',
      'cancel_url':                    cancelUrl
    });

    if (session.error) {
      return res.status(400).json({ error: session.error.message });
    }

    return res.json({ url: session.url });

  } catch(e) {
    console.error('Checkout error:', e.message);
    return res.status(500).json({ error: 'Could not create checkout session.' });
  }
});

// ══════════════════════════════════════
// CHECK SUBSCRIBER
// Called on login — checks if email
// has an active Stripe subscription
// ══════════════════════════════════════
app.post('/check-subscriber', async function(req, res) {
  var email = (req.body.email || '').toLowerCase().trim();

  if (!email) {
    return res.status(400).json({ error: 'Email is required.' });
  }

  try {
    // check in-memory list first (fastest)
    if (subscribers[email]) {
      return res.json({ isPro: true, email: email });
    }

    // search Stripe for a customer with this email
    var customers = await stripeRequest('GET',
      '/customers?email=' + encodeURIComponent(email) + '&limit=1', null
    );

    if (!customers.data || customers.data.length === 0) {
      return res.json({ isPro: false, email: email });
    }

    var customerId = customers.data[0].id;

    // check if they have an active subscription
    var subscriptions = await stripeRequest('GET',
      '/subscriptions?customer=' + customerId + '&status=active&limit=1', null
    );

    var isPro = subscriptions.data && subscriptions.data.length > 0;

    if (isPro) subscribers[email] = true;

    return res.json({ isPro: isPro, email: email });

  } catch(e) {
    console.error('Subscriber check error:', e.message);
    return res.status(500).json({ error: 'Server error. Please try again.' });
  }
});

// ══════════════════════════════════════
// STRIPE WEBHOOK
// Stripe calls this when payment succeeds
// ══════════════════════════════════════
app.post('/webhook', async function(req, res) {
  var sig  = req.headers['stripe-signature'];
  var body = req.body;

  // verify webhook signature
  try {
    var crypto  = require('crypto');
    var parts   = sig.split(',').reduce(function(acc, part) {
      var kv = part.split('=');
      acc[kv[0]] = kv[1];
      return acc;
    }, {});

    var timestamp  = parts.t;
    var signature  = parts.v1;
    var payload    = timestamp + '.' + body.toString();
    var expected   = crypto.createHmac('sha256', STRIPE_WEBHOOK).update(payload).digest('hex');

    if (expected !== signature) {
      console.log('Webhook signature mismatch');
      return res.sendStatus(401);
    }
  } catch(e) {
    return res.sendStatus(400);
  }

  var event;
  try { event = JSON.parse(body.toString()); }
  catch(e) { return res.sendStatus(400); }

  // handle successful payment
  if (event.type === 'checkout.session.completed' ||
      event.type === 'invoice.payment_succeeded') {
    var email = event.data.object.customer_email ||
                (event.data.object.customer_details && event.data.object.customer_details.email);
    if (email) {
      subscribers[email.toLowerCase()] = true;
      console.log('New Pro subscriber:', email);
    }
  }

  res.sendStatus(200);
});

app.listen(PORT, function() {
  console.log('ClickColor server running on port', PORT);
});
