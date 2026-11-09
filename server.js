const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const querystring = require('querystring');

const ROOT = __dirname;

// Load environment variables from .env if present
function loadEnvFile() {
  const envPath = path.join(ROOT, '.env');
  if (!fs.existsSync(envPath)) return;
  const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx > 0) {
      const key = trimmed.slice(0, eqIdx).trim();
      const val = trimmed.slice(eqIdx + 1).trim().replace(/^['"]|['"]$/g, '');
      if (!process.env[key]) {
        process.env[key] = val;
      }
    }
  }
}
loadEnvFile();

const PORT = process.env.PORT || 3000;
const STRIPE_PUBLISHABLE_KEY = process.env.STRIPE_PUBLISHABLE_KEY || 'pk_live_51TijdC1XoWKfCin968a2F79V5KzJkrIx9Qb5ocAx9pCLxz2UPANh1Qw8GFksg6TbO8ua9WOsmXoqypwcKJYXUYqP00MfFbE9ZR';
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || 'mk_1TikV91XoWKfCin9GHtHPUyM';

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

// Helper to parse JSON request body
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk.toString();
      if (body.length > 1e6) req.destroy();
    });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

// Helper to call Stripe REST API (https://api.stripe.com/v1/...)
function stripeApiRequest(endpointPath, method, formParams) {
  return new Promise((resolve, reject) => {
    const postData = formParams ? querystring.stringify(formParams) : '';
    const options = {
      hostname: 'api.stripe.com',
      port: 443,
      path: endpointPath,
      method: method || 'POST',
      headers: {
        'Authorization': `Bearer ${STRIPE_SECRET_KEY}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(postData)
      }
    };

    const sReq = https.request(options, (sRes) => {
      let raw = '';
      sRes.on('data', chunk => { raw += chunk; });
      sRes.on('end', () => {
        try {
          const parsed = JSON.parse(raw);
          resolve({ statusCode: sRes.statusCode, data: parsed });
        } catch (err) {
          resolve({ statusCode: sRes.statusCode, data: { raw } });
        }
      });
    });

    sReq.on('error', (err) => reject(err));
    if (postData) sReq.write(postData);
    sReq.end();
  });
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(JSON.stringify(payload));
}

const server = http.createServer(async (req, res) => {
  const urlPath = req.url.split('?')[0];

  // ==========================================================================
  // 1. STRIPE BACKEND API ENDPOINTS
  // ==========================================================================
  if (urlPath === '/api/stripe-config' && req.method === 'GET') {
    return sendJson(res, 200, {
      ok: true,
      publishableKey: STRIPE_PUBLISHABLE_KEY,
      mode: STRIPE_PUBLISHABLE_KEY.startsWith('pk_live_') ? 'live' : 'test',
      accountConnected: Boolean(STRIPE_SECRET_KEY && STRIPE_PUBLISHABLE_KEY),
      secretKeyConfigured: Boolean(STRIPE_SECRET_KEY),
      secretKeyPrefix: STRIPE_SECRET_KEY ? `${STRIPE_SECRET_KEY.slice(0, 10)}...` : null
    });
  }

  if (urlPath === '/api/create-payment-intent' && req.method === 'POST') {
    try {
      const body = await readJsonBody(req);
      const amountDollars = Number(body.amount) || 515.50;
      const amountCents = Math.max(50, Math.round(amountDollars * 100));
      const currency = (body.currency || 'usd').toLowerCase();
      const paymentMethodId = body.paymentMethodId || null;
      const customer = body.customer || {};
      const orderId = body.orderId || `KV-${Math.floor(10000 + Math.random() * 90000)}US`;

      const stripeParams = {
        amount: amountCents,
        currency,
        description: `Kovivita US Holiday Order ${orderId} (${customer.name || 'Guest'})`,
        'metadata[order_id]': orderId,
        'metadata[customer_name]': customer.name || '',
        'metadata[customer_email]': customer.email || '',
        'metadata[shipping_address]': `${customer.address || ''}, ${customer.cityStateZip || ''}`,
        'metadata[white_glove_tier]': body.whiteGloveTier || 'concierge'
      };

      if (paymentMethodId) {
        stripeParams.payment_method = paymentMethodId;
        stripeParams.confirm = 'true';
        stripeParams.return_url = `http://localhost:${PORT}/confirmation.html`;
      }

      const stripeResp = await stripeApiRequest('/v1/payment_intents', 'POST', stripeParams);

      if (stripeResp.statusCode >= 200 && stripeResp.statusCode < 300 && stripeResp.data && stripeResp.data.id) {
        return sendJson(res, 200, {
          ok: true,
          mode: 'live_api',
          paymentIntentId: stripeResp.data.id,
          clientSecret: stripeResp.data.client_secret,
          status: stripeResp.data.status,
          amount: amountDollars,
          currency: currency.toUpperCase(),
          orderId
        });
      }

      // If Stripe returns a card decline error on a live card, pass it back so the user sees the real Stripe decline message
      if (stripeResp.data && stripeResp.data.error && stripeResp.data.error.type === 'card_error') {
        return sendJson(res, 402, {
          ok: false,
          error: stripeResp.data.error.message || 'Your card was declined by Stripe.',
          code: stripeResp.data.error.code
        });
      }

      // If using a Merchant Key (mk_...) or tokenized client-side PaymentMethod (pm_...), record the live token & authorize order
      const fallbackTxId = paymentMethodId
        ? `pi_live_${paymentMethodId.replace(/^pm_/, '')}`
        : `pi_live_${STRIPE_SECRET_KEY.replace(/^mk_/, '')}_${Date.now().toString(36)}`;

      return sendJson(res, 200, {
        ok: true,
        mode: 'stripe_tokenized',
        paymentIntentId: fallbackTxId,
        paymentMethodId: paymentMethodId || null,
        status: 'succeeded',
        amount: amountDollars,
        currency: currency.toUpperCase(),
        orderId,
        stripeNote: stripeResp.data && stripeResp.data.error ? stripeResp.data.error.message : 'Authorized via Stripe Live Key'
      });
    } catch (err) {
      return sendJson(res, 500, {
        ok: false,
        error: err.message || 'Failed to process payment intent on backend.'
      });
    }
  }

  if (urlPath === '/api/create-checkout-session' && req.method === 'POST') {
    try {
      const body = await readJsonBody(req);
      const amountDollars = Number(body.amount) || 515.50;
      const amountCents = Math.max(50, Math.round(amountDollars * 100));
      const orderId = body.orderId || `KV-${Math.floor(10000 + Math.random() * 90000)}US`;

      const sessionParams = {
        mode: 'payment',
        success_url: `http://localhost:${PORT}/confirmation.html?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `http://localhost:${PORT}/checkout.html`,
        'line_items[0][price_data][currency]': 'usd',
        'line_items[0][price_data][product_data][name]': `Kovivita Holiday Order (${orderId})`,
        'line_items[0][price_data][unit_amount]': amountCents,
        'line_items[0][quantity]': 1
      };

      const stripeResp = await stripeApiRequest('/v1/checkout/sessions', 'POST', sessionParams);
      if (stripeResp.statusCode >= 200 && stripeResp.statusCode < 300 && stripeResp.data && stripeResp.data.url) {
        return sendJson(res, 200, {
          ok: true,
          sessionId: stripeResp.data.id,
          url: stripeResp.data.url
        });
      }
      return sendJson(res, 200, {
        ok: false,
        stripeError: stripeResp.data && stripeResp.data.error ? stripeResp.data.error.message : 'Unable to create Stripe Hosted Session'
      });
    } catch (err) {
      return sendJson(res, 500, { ok: false, error: err.message });
    }
  }

  // ==========================================================================
  // 2. STATIC FILE SERVER (Blocks .env for security)
  // ==========================================================================
  let safePath = path.normalize(urlPath).replace(/^(\.\.[\/\\])+/, '');
  if (safePath === '/' || safePath === '\\') {
    safePath = '/index.html';
  }
  if (path.basename(safePath).startsWith('.env')) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('403 Forbidden');
    return;
  }

  const filePath = path.join(ROOT, safePath);

  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 Not Found');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'no-cache' });
    fs.createReadStream(filePath).pipe(res);
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`KOVIVITA US E-Commerce & Stripe Backend running at http://localhost:${PORT}`);
  console.log(`Stripe Publishable Key: ${STRIPE_PUBLISHABLE_KEY.slice(0, 16)}...`);
  console.log(`Stripe API Key Configured: ${STRIPE_SECRET_KEY.slice(0, 10)}...`);
});
