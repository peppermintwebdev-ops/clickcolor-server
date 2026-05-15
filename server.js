const express  = require('express');
const https    = require('https');
const crypto   = require('crypto');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── ENV VARS — set in Railway dashboard ──
const STRIPE_SECRET    = process.env.STRIPE_SECRET;
const STRIPE_WEBHOOK   = process.env.STRIPE_WEBHOOK;
const STRIPE_PRICE_ID  = process.env.STRIPE_PRICE_ID;
const SUPABASE_URL     = process.env.SUPABASE_URL;       // https://xxxx.supabase.co
const SUPABASE_KEY     = process.env.SUPABASE_SERVICE_KEY; // service_role key
const SITE_URL         = process.env.SITE_URL || 'https://clickingasaservice.com';

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

// ── PASSWORD HASHING ──
// Uses SHA-256 with a salt — no extra dependencies needed
function hashPassword(password, salt) {
  if (!salt) salt = crypto.randomBytes(16).toString('hex');
  var hash = crypto.createHmac('sha256', salt).update(password).digest('hex');
  return { hash: hash, salt: salt };
}

function verifyPassword(password, salt, storedHash) {
  var result = hashPassword(password, salt);
  return result.hash === storedHash;
}

// ── SUPABASE HELPER ──
function supabase(method, path, body) {
  return new Promise(function(resolve, reject) {
    var data = body ? JSON.stringify(body) : '';
    var url  = new URL(SUPABASE_URL + '/rest/v1' + path);

    var options = {
      hostname: url.hostname,
      path:     url.pathname + url.search,
      method:   method,
      headers: {
        'apikey':        SUPABASE_KEY,
        'Authorization': 'Bearer ' + SUPABASE_KEY,
        'Content-Type':  'application/json',
        'Prefer':        'return=representation'
      }
    };

    if (data) options.headers['Content-Length'] = Buffer.byteLength(data);

    var req = https.request(options, function(res) {
      var chunks = [];
      res.on('data', function(c) { chunks.push(c); });
      res.on('end', function() {
        var text = Buffer.concat(chunks).toString();
        try { resolve({ status: res.statusCode, data: JSON.parse(text) }); }
        catch(e) { resolve({ status: res.statusCode, data: text }); }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

// ── STRIPE HELPER ──
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
        'Content-Type':  'application/x-www-form-urlencoded',
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

// ── HEALTH CHECK ──
app.get('/', function(req, res) {
  res.json({ status: 'Clicking as a Service server running' });
});

// ══════════════════════════════════════════
// REGISTER
// Creates a new user in Supabase
// ══════════════════════════════════════════
app.post('/register', async function(req, res) {
  var name     = (req.body.name     || '').trim();
  var email    = (req.body.email    || '').toLowerCase().trim();
  var password = (req.body.password || '');

  if (!name || !email || !password) {
    return res.status(400).json({ error: 'All fields are required.' });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters.' });
  }

  try {
    // Check if email already exists
    var existing = await supabase('GET',
      '/users?email=eq.' + encodeURIComponent(email) + '&select=id',
      null
    );

    if (existing.data && existing.data.length > 0) {
      return res.status(400).json({ error: 'An account with this email already exists.' });
    }

    // Hash the password
    var hashed = hashPassword(password);

    // Insert new user
    var result = await supabase('POST', '/users', {
      name:          name,
      email:         email,
      password_hash: hashed.salt + ':' + hashed.hash,
      is_pro:        false
    });

    if (result.status !== 201) {
      console.error('Supabase insert error:', result.data);
      return res.status(500).json({ error: 'Could not create account. Please try again.' });
    }

    var user = Array.isArray(result.data) ? result.data[0] : result.data;
    console.log('New user registered:', email);

    return res.json({ success: true, name: user.name, email: user.email, isPro: false });

  } catch(e) {
    console.error('Register error:', e.message);
    return res.status(500).json({ error: 'Server error. Please try again.' });
  }
});

// ══════════════════════════════════════════
// LOGIN
// Verifies password against Supabase,
// checks Stripe for active subscription
// ══════════════════════════════════════════
app.post('/login', async function(req, res) {
  var email    = (req.body.email    || '').toLowerCase().trim();
  var password = (req.body.password || '');

  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required.' });
  }

  try {
    // Look up user in Supabase
    var result = await supabase('GET',
      '/users?email=eq.' + encodeURIComponent(email) + '&select=*',
      null
    );

    if (!result.data || result.data.length === 0) {
      return res.status(401).json({ error: 'Invalid email or password.' });
    }

    var user = result.data[0];

    // Verify password
    var parts = (user.password_hash || '').split(':');
    if (parts.length !== 2) {
      return res.status(401).json({ error: 'Invalid email or password.' });
    }

    var salt       = parts[0];
    var storedHash = parts[1];

    if (!verifyPassword(password, salt, storedHash)) {
      return res.status(401).json({ error: 'Invalid email or password.' });
    }

    // Check Pro status — use stored flag first, then verify with Stripe
    var isPro = !!user.is_pro;

    if (!isPro && STRIPE_SECRET) {
      try {
        var customers = await stripeRequest('GET',
          '/customers?email=' + encodeURIComponent(email) + '&limit=1',
          null
        );

        if (customers.data && customers.data.length > 0) {
          var customerId = customers.data[0].id;
          var subs = await stripeRequest('GET',
            '/subscriptions?customer=' + customerId + '&status=active&limit=1',
            null
          );

          if (subs.data && subs.data.length > 0) {
            isPro = true;
            // Update Supabase so next login is faster
            await supabase('PATCH',
              '/users?email=eq.' + encodeURIComponent(email),
              { is_pro: true, stripe_customer_id: customerId }
            );
          }
        }
      } catch(stripeErr) {
        console.error('Stripe check error:', stripeErr.message);
        // Non-fatal — continue with Supabase value
      }
    }

    console.log('Login:', email, '| Pro:', isPro);
    return res.json({ success: true, name: user.name, email: user.email, isPro: isPro });

  } catch(e) {
    console.error('Login error:', e.message);
    return res.status(500).json({ error: 'Server error. Please try again.' });
  }
});

// ══════════════════════════════════════════
// CREATE CHECKOUT SESSION
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
// STRIPE WEBHOOK
// Marks user as Pro in Supabase on payment
// ══════════════════════════════════════════
app.post('/webhook', async function(req, res) {
  var sig  = req.headers['stripe-signature'];
  var body = req.body;

  if (STRIPE_WEBHOOK) {
    try {
      var parts    = sig.split(',').reduce(function(acc, p) {
        var kv = p.split('='); acc[kv[0]] = kv[1]; return acc;
      }, {});
      var payload  = parts.t + '.' + body.toString();
      var expected = crypto.createHmac('sha256', STRIPE_WEBHOOK).update(payload).digest('hex');
      if (expected !== parts.v1) {
        console.log('Webhook signature mismatch');
        return res.sendStatus(401);
      }
    } catch(e) { return res.sendStatus(400); }
  }

  var event;
  try { event = JSON.parse(body.toString()); }
  catch(e) { return res.sendStatus(400); }

  if (event.type === 'checkout.session.completed' ||
      event.type === 'invoice.payment_succeeded') {
    var obj   = event.data.object;
    var email = obj.customer_email ||
                (obj.customer_details && obj.customer_details.email);

    if (email) {
      email = email.toLowerCase();
      console.log('Payment confirmed for:', email);

      // Mark user as Pro in Supabase
      try {
        await supabase('PATCH',
          '/users?email=eq.' + encodeURIComponent(email),
          { is_pro: true }
        );
        console.log('Marked as Pro in Supabase:', email);
      } catch(e) {
        console.error('Supabase update error:', e.message);
      }
    }
  }

  // Handle subscription cancellation
  if (event.type === 'customer.subscription.deleted') {
    var custEmail = event.data.object.customer_email;
    if (custEmail) {
      custEmail = custEmail.toLowerCase();
      try {
        await supabase('PATCH',
          '/users?email=eq.' + encodeURIComponent(custEmail),
          { is_pro: false }
        );
        console.log('Removed Pro from:', custEmail);
      } catch(e) {
        console.error('Supabase update error:', e.message);
      }
    }
  }

  res.sendStatus(200);
});

app.listen(PORT, function() {
  console.log('Clicking as a Service server running on port', PORT);
});
