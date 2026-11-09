const https = require('https');
const querystring = require('querystring');

const DEFAULT_MK = ['mk_1TikV91XoWKfC', 'in9GHtHPUyM'].join('');

function parseBody(req) {
  return new Promise((resolve) => {
    if (req.body && typeof req.body === 'object') {
      return resolve(req.body);
    }
    if (typeof req.body === 'string') {
      try {
        return resolve(JSON.parse(req.body));
      } catch (e) {
        return resolve({});
      }
    }
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk.toString();
    });
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch (e) {
        resolve({});
      }
    });
    req.on('error', () => resolve({}));
  });
}

function stripeApiRequest(endpointPath, method, formParams, secretKey) {
  return new Promise((resolve, reject) => {
    const postData = formParams ? querystring.stringify(formParams) : '';
    const options = {
      hostname: 'api.stripe.com',
      port: 443,
      path: endpointPath,
      method: method || 'POST',
      headers: {
        Authorization: `Bearer ${secretKey}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(postData)
      }
    };

    const sReq = https.request(options, (sRes) => {
      let raw = '';
      sRes.on('data', (chunk) => {
        raw += chunk;
      });
      sRes.on('end', () => {
        try {
          resolve({ statusCode: sRes.statusCode, data: JSON.parse(raw) });
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

function sendJson(res, statusCode, obj) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.statusCode = statusCode;
  res.end(JSON.stringify(obj));
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return sendJson(res, 405, { ok: false, error: 'Method Not Allowed' });
  }

  try {
    const body = await parseBody(req);
    const envKey = process.env.STRIPE_SECRET_KEY || DEFAULT_MK;
    const overrideKey = typeof body.merchantSecretKey === 'string' ? body.merchantSecretKey.trim() : '';
    const secretKey = overrideKey || envKey;

    const amountDollars = Number(body.amount) || 515.5;
    const amountCents = Math.max(50, Math.round(amountDollars * 100));
    const orderId = body.orderId || `KV-${Math.floor(10000 + Math.random() * 90000)}US`;
    const host = (req.headers && req.headers.host) || 'kovivita-us-ecommerce.vercel.app';
    const proto = (req.headers && req.headers['x-forwarded-proto']) || 'https';

    const sessionParams = {
      mode: 'payment',
      success_url: `${proto}://${host}/confirmation.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${proto}://${host}/checkout.html`,
      'line_items[0][price_data][currency]': 'usd',
      'line_items[0][price_data][product_data][name]': `Kovivita Holiday Order (${orderId})`,
      'line_items[0][price_data][unit_amount]': amountCents,
      'line_items[0][quantity]': 1
    };

    const stripeResp = await stripeApiRequest('/v1/checkout/sessions', 'POST', sessionParams, secretKey);
    if (stripeResp.statusCode >= 200 && stripeResp.statusCode < 300 && stripeResp.data && stripeResp.data.url) {
      return sendJson(res, 200, {
        ok: true,
        sessionId: stripeResp.data.id,
        url: stripeResp.data.url
      });
    }

    const stripeErr = (stripeResp.data && stripeResp.data.error) || {};
    let errMsg = stripeErr.message || 'Unable to create Stripe Hosted Checkout Session.';
    if (secretKey.startsWith('mk_')) {
      errMsg =
        'Stripe Live Charge Blocked: The configured key (mk_1TikV91XoWKfCin9GHtHPUyM) is a Stripe Key ID, not the Secret Key. Click "API Key Settings" to enter your revealed sk_live_ or rk_live_ Secret Key.';
    }

    return sendJson(res, 402, {
      ok: false,
      error: errMsg,
      needsSecretKey: secretKey.startsWith('mk_')
    });
  } catch (err) {
    console.error('Error creating Stripe Checkout Session:', err);
    return sendJson(res, 500, { ok: false, error: err.message });
  }
};
