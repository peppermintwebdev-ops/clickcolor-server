const express = require('express');
const https   = require('https');

const app  = express();
const PORT = process.env.PORT || 3000;

const SHOPIFY_STORE            = process.env.SHOPIFY_STORE;
const SHOPIFY_STOREFRONT_TOKEN = process.env.SHOPIFY_STOREFRONT_TOKEN;

app.use(express.json());

app.use(function(req, res, next) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.get('/', function(req, res) {
  res.json({ status: 'ClickColor server running' });
});

function shopifyQuery(query) {
  return new Promise(function(resolve, reject) {
    var body = JSON.stringify({ query: query });
    var options = {
      hostname: SHOPIFY_STORE,
      path: '/api/2024-01/graphql.json',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Storefront-Access-Token': SHOPIFY_STOREFRONT_TOKEN,
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
    req.write(body);
    req.end();
  });
}

app.post('/login', async function(req, res) {
  var email    = (req.body.email || '').replace(/"/g, '');
  var password = (req.body.password || '').replace(/"/g, '');

  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required.' });
  }

  try {
    var tokenData = await shopifyQuery(
      'mutation { customerAccessTokenCreate(input: { email: "' + email + '", password: "' + password + '" }) { customerAccessToken { accessToken } customerUserErrors { message } } }'
    );

    var tokenResult = tokenData.data && tokenData.data.customerAccessTokenCreate;
    if (!tokenResult || tokenResult.customerUserErrors.length > 0) {
      return res.status(401).json({ error: 'Invalid email or password.' });
    }

    var accessToken = tokenResult.customerAccessToken.accessToken;

    var customerData = await shopifyQuery(
      '{ customer(customerAccessToken: "' + accessToken + '") { firstName lastName orders(first: 20) { edges { node { financialStatus lineItems(first: 5) { edges { node { title } } } } } } } }'
    );

    var customer = customerData.data && customerData.data.customer;
    if (!customer) {
      return res.status(401).json({ error: 'Could not load account.' });
    }

    var name = [customer.firstName, customer.lastName].filter(Boolean).join(' ') || email;

    var isPro = false;
    if (customer.orders && customer.orders.edges) {
      customer.orders.edges.forEach(function(edge) {
        if (edge.node.financialStatus === 'PAID') {
          edge.node.lineItems.edges.forEach(function(item) {
            var title = (item.node.title || '').toLowerCase();
            if (title.includes('clickcolor') || title.includes('pro')) isPro = true;
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
  console.log('Server running on port', PORT);
});
