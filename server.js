const express = require('express');
const app = express();
const PORT = process.env.PORT || 3000;

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

app.post('/login', function(req, res) {
  res.json({ name: 'Test User', email: req.body.email, isPro: false });
});

app.listen(PORT, function() {
  console.log('Server running on port', PORT);
});
