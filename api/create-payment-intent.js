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
    const currency = (body.currency || 'usd').toLowerCase();
    const paymentMethodId = body.paymentMethodId || null;
    const customer = body.customer || {};
    const orderId = body.orderId || `KV-${Math.floor(10000 + Math.random() * 90000)}US`;
    const host = (req.headers && req.headers.host) || 'kovivita-us-ecommerce.vercel.app';
    const proto = (req.headers && req.headers['x-forwarded-proto']) || 'https';

    if (!paymentMethodId) {
      return sendJson(res, 400, {
        ok: false,
        error: 'A valid credit or debit card is required to authorize payment.'
      });
    }

    const stripeParams = {
      amount: amountCents,
      currency,
      payment_method: paymentMethodId,
      confirm: 'true',
      return_url: `${proto}://${host}/confirmation.html`,
      description: `Kovivita US Holiday Order ${orderId} (${customer.name || 'Guest'})`,
      'metadata[order_id]': orderId,
      'metadata[customer_name]': customer.name || '',
      'metadata[customer_email]': customer.email || '',
      'metadata[shipping_address]': `${customer.address || ''}, ${customer.cityStateZip || ''}`,
      'metadata[white_glove_tier]': body.whiteGloveTier || 'concierge'
    };

    const stripeResp = await stripeApiRequest('/v1/payment_intents', 'POST', stripeParams, secretKey);

    // Strictly verify that Stripe created a real PaymentIntent
    if (
      stripeResp.statusCode >= 200 &&
      stripeResp.statusCode < 300 &&
      stripeResp.data &&
      stripeResp.data.id &&
      (stripeResp.data.status === 'succeeded' || stripeResp.data.status === 'requires_action')
    ) {
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

    // If Stripe returned an error (card declined, insufficient funds, expired card, or invalid API key mk_...)
    const stripeErr = (stripeResp.data && stripeResp.data.error) || {};
    let errMsg = stripeErr.message || 'Payment could not be completed by your card issuer.';

    if (secretKey.startsWith('mk_')) {
      errMsg =
        'Stripe Live Charge Blocked: The configured key (mk_1TikV91XoWKfCin9GHtHPUyM) is a Stripe Key ID, not the Secret Key. To charge real cards, click "API Key Settings" above (or update STRIPE_SECRET_KEY in Vercel) with your revealed Secret Key starting with sk_live_ or rk_live_ from https://dashboard.stripe.com/apikeys.';
    }

    return sendJson(res, 402, {
      ok: false,
      error: errMsg,
      code: stripeErr.code || stripeErr.type || 'payment_failed',
      needsSecretKey: secretKey.startsWith('mk_')
    });
  } catch (err) {
    console.error('Error creating Stripe PaymentIntent:', err);
    return sendJson(res, 500, {
      ok: false,
      error: err.message || 'Failed to process payment intent on backend.'
    });
  }
};
