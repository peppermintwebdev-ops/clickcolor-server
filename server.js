const express  = require('express');
const https    = require('https');
const crypto   = require('crypto');

const app  = express();
const PORT = process.env.PORT || 3000;

const STRIPE_SECRET    = process.env.STRIPE_SECRET;
const STRIPE_WEBHOOK   = process.env.STRIPE_WEBHOOK;
const STRIPE_PRICE_ID  = process.env.STRIPE_PRICE_ID;
const SUPABASE_URL     = process.env.SUPABASE_URL;
const SUPABASE_KEY     = process.env.SUPABASE_SERVICE_KEY;
const SITE_URL         = process.env.SITE_URL || 'https://clickingasaservice.com';

app.use('/webhook', express.raw({ type: 'application/json' }));
app.use(express.json());

app.use(function(req, res, next) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

/* ── PASSWORD HASHING ── */
function hashPassword(password, salt) {
  if (!salt) salt = crypto.randomBytes(16).toString('hex');
  var hash = crypto.createHmac('sha256', salt).update(password).digest('hex');
  return { hash: hash, salt: salt };
}
function verifyPassword(password, salt, storedHash) {
  return hashPassword(password, salt).hash === storedHash;
}

/* ── SUPABASE HELPER ── */
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

/* ── STRIPE HELPER ── */
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

/* ── HEALTH CHECK ── */
app.get('/', function(req, res) {
  res.json({ status: 'Clicking as a Service server running' });
});

/* ══════════════════════════════════════════
   SESSION RESTORE
   Checks Pro status by email only —
   no password needed, called on page load
══════════════════════════════════════════ */
app.post('/session', async function(req, res) {
  var email = (req.body.email || '').toLowerCase().trim();
  if (!email) return res.status(400).json({ error: 'Email required.' });

  try {
    var result = await supabase('GET',
      '/users?email=eq.' + encodeURIComponent(email) + '&select=name,username,is_pro',
      null
    );

    if (!result.data || result.data.length === 0) {
      return res.status(404).json({ error: 'User not found.' });
    }

    var user  = result.data[0];
    var isPro = !!user.is_pro;

    /* Double check with Stripe if not marked Pro in DB */
    if (!isPro && STRIPE_SECRET) {
      try {
        var customers = await stripeRequest('GET',
          '/customers?email=' + encodeURIComponent(email) + '&limit=1', null);
        if (customers.data && customers.data.length > 0) {
          var subs = await stripeRequest('GET',
            '/subscriptions?customer=' + customers.data[0].id + '&status=active&limit=1', null);
          if (subs.data && subs.data.length > 0) {
            isPro = true;
            await supabase('PATCH',
              '/users?email=eq.' + encodeURIComponent(email),
              { is_pro: true });
          }
        }
      } catch(e) { console.error('Stripe session check:', e.message); }
    }

    return res.json({
      name:     user.name,
      username: user.username,
      email:    email,
      isPro:    isPro
    });

  } catch(e) {
    console.error('Session error:', e.message);
    return res.status(500).json({ error: 'Server error.' });
  }
});

/* ══════════════════════════════════════════
   REGISTER
   Now accepts username, checks uniqueness
══════════════════════════════════════════ */
app.post('/register', async function(req, res) {
  var name     = (req.body.name     || '').trim();
  var username = (req.body.username || '').trim().toLowerCase().replace(/[^a-z0-9_]/g, '');
  var email    = (req.body.email    || '').toLowerCase().trim();
  var password = (req.body.password || '');

  if (!name || !username || !email || !password) {
    return res.status(400).json({ error: 'All fields are required.' });
  }
  if (username.length < 3) {
    return res.status(400).json({ error: 'Username must be at least 3 characters.' });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters.' });
  }

  try {
    // Check email exists
    var existingEmail = await supabase('GET',
      '/users?email=eq.' + encodeURIComponent(email) + '&select=id', null);
    if (existingEmail.data && existingEmail.data.length > 0) {
      return res.status(400).json({ error: 'An account with this email already exists.' });
    }

    // Check username exists
    var existingUser = await supabase('GET',
      '/users?username=eq.' + encodeURIComponent(username) + '&select=id', null);
    if (existingUser.data && existingUser.data.length > 0) {
      return res.status(400).json({ error: 'That username is already taken.' });
    }

    var hashed = hashPassword(password);
    var result = await supabase('POST', '/users', {
      name:          name,
      username:      username,
      email:         email,
      password_hash: hashed.salt + ':' + hashed.hash,
      is_pro:        false,
      total_clicks:  0
    });

    if (result.status !== 201) {
      return res.status(500).json({ error: 'Could not create account. Please try again.' });
    }

    var user = Array.isArray(result.data) ? result.data[0] : result.data;
    console.log('New user registered:', email, '| username:', username);
    return res.json({ success: true, name: user.name, username: user.username, email: user.email, isPro: false });

  } catch(e) {
    console.error('Register error:', e.message);
    return res.status(500).json({ error: 'Server error. Please try again.' });
  }
});

/* ══════════════════════════════════════════
   LOGIN
   Returns username along with other fields
══════════════════════════════════════════ */
app.post('/login', async function(req, res) {
  var email    = (req.body.email    || '').toLowerCase().trim();
  var password = (req.body.password || '');

  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required.' });
  }

  try {
    var result = await supabase('GET',
      '/users?email=eq.' + encodeURIComponent(email) + '&select=*', null);

    if (!result.data || result.data.length === 0) {
      return res.status(401).json({ error: 'Invalid email or password.' });
    }

    var user  = result.data[0];
    var parts = (user.password_hash || '').split(':');
    if (parts.length !== 2 || !verifyPassword(password, parts[0], parts[1])) {
      return res.status(401).json({ error: 'Invalid email or password.' });
    }

    var isPro = !!user.is_pro;

    if (!isPro && STRIPE_SECRET) {
      try {
        var customers = await stripeRequest('GET',
          '/customers?email=' + encodeURIComponent(email) + '&limit=1', null);
        if (customers.data && customers.data.length > 0) {
          var subs = await stripeRequest('GET',
            '/subscriptions?customer=' + customers.data[0].id + '&status=active&limit=1', null);
          if (subs.data && subs.data.length > 0) {
            isPro = true;
            await supabase('PATCH',
              '/users?email=eq.' + encodeURIComponent(email),
              { is_pro: true });
          }
        }
      } catch(e) { console.error('Stripe check error:', e.message); }
    }

    console.log('Login:', email, '| Pro:', isPro);
    return res.json({
      success:  true,
      name:     user.name,
      username: user.username || user.name,
      email:    user.email,
      isPro:    isPro,
      total_clicks: user.total_clicks || 0
    });

  } catch(e) {
    console.error('Login error:', e.message);
    return res.status(500).json({ error: 'Server error. Please try again.' });
  }
});

/* ══════════════════════════════════════════
   RECORD CLICK
   Increments total_clicks for logged-in user
══════════════════════════════════════════ */
app.post('/click', async function(req, res) {
  var email = (req.body.email || '').toLowerCase().trim();
  if (!email) return res.status(400).json({ error: 'Email required.' });

  try {
    /* Use Supabase RPC to safely increment */
    var result = await supabase('GET',
      '/users?email=eq.' + encodeURIComponent(email) + '&select=total_clicks', null);

    if (!result.data || result.data.length === 0) {
      return res.status(404).json({ error: 'User not found.' });
    }

    var current = result.data[0].total_clicks || 0;
    await supabase('PATCH',
      '/users?email=eq.' + encodeURIComponent(email),
      { total_clicks: current + 1 }
    );

    return res.json({ success: true, total_clicks: current + 1 });
  } catch(e) {
    console.error('Click error:', e.message);
    return res.status(500).json({ error: 'Server error.' });
  }
});

/* ══════════════════════════════════════════
   LEADERBOARD
   Returns top 20 users by total_clicks
══════════════════════════════════════════ */
app.get('/leaderboard', async function(req, res) {
  try {
    var result = await supabase('GET',
      '/users?select=username,total_clicks&order=total_clicks.desc&limit=20', null);

    if (!result.data) return res.json({ leaders: [] });

    var leaders = result.data
      .filter(function(u) { return u.total_clicks > 0; })
      .map(function(u, i) {
        return {
          rank:         i + 1,
          username:     u.username || 'anonymous',
          total_clicks: u.total_clicks || 0
        };
      });

    return res.json({ leaders: leaders });
  } catch(e) {
    console.error('Leaderboard error:', e.message);
    return res.status(500).json({ leaders: [] });
  }
});

/* ══════════════════════════════════════════
   CHECK SUBSCRIBER
══════════════════════════════════════════ */
app.post('/check-subscriber', async function(req, res) {
  var email = (req.body.email || '').toLowerCase().trim();
  if (!email) return res.status(400).json({ error: 'Email required.' });

  try {
    var customers = await stripeRequest('GET',
      '/customers?email=' + encodeURIComponent(email) + '&limit=1', null);
    if (!customers.data || customers.data.length === 0) {
      return res.json({ isPro: false, email: email });
    }
    var subs = await stripeRequest('GET',
      '/subscriptions?customer=' + customers.data[0].id + '&status=active&limit=1', null);
    var isPro = !!(subs.data && subs.data.length > 0);
    return res.json({ isPro: isPro, email: email });
  } catch(e) {
    console.error('Subscriber check error:', e.message);
    return res.status(500).json({ error: 'Server error.' });
  }
});

/* ══════════════════════════════════════════
   CREATE CHECKOUT SESSION
══════════════════════════════════════════ */
app.post('/create-checkout', async function(req, res) {
  var email      = (req.body.email || '').trim();
  var successUrl = req.body.successUrl || SITE_URL + '?pro=true';
  var cancelUrl  = req.body.cancelUrl  || SITE_URL;

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
    if (session.error) return res.status(400).json({ error: session.error.message });
    return res.json({ url: session.url });
  } catch(e) {
    console.error('Checkout error:', e.message);
    return res.status(500).json({ error: 'Could not create checkout session.' });
  }
});

/* ══════════════════════════════════════════
   STRIPE WEBHOOK
══════════════════════════════════════════ */
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
      if (expected !== parts.v1) return res.sendStatus(401);
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
      try {
        await supabase('PATCH',
          '/users?email=eq.' + encodeURIComponent(email.toLowerCase()),
          { is_pro: true });
        console.log('Marked as Pro:', email);
      } catch(e) { console.error('Supabase update error:', e.message); }
    }
  }

  if (event.type === 'customer.subscription.deleted') {
    var custEmail = event.data.object.customer_email;
    if (custEmail) {
      try {
        await supabase('PATCH',
          '/users?email=eq.' + encodeURIComponent(custEmail.toLowerCase()),
          { is_pro: false });
        console.log('Removed Pro:', custEmail);
      } catch(e) { console.error('Supabase update error:', e.message); }
    }
  }

  res.sendStatus(200);
});

app.listen(PORT, function() {
  console.log('Clicking as a Service server running on port', PORT);
});
