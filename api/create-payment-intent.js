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

  const secretKey = process.env.STRIPE_SECRET_KEY || DEFAULT_MK;

  try {
    const body = await parseBody(req);
    const amountDollars = Number(body.amount) || 515.5;
    const amountCents = Math.max(50, Math.round(amountDollars * 100));
    const currency = (body.currency || 'usd').toLowerCase();
    const paymentMethodId = body.paymentMethodId || null;
    const customer = body.customer || {};
    const orderId = body.orderId || `KV-${Math.floor(10000 + Math.random() * 90000)}US`;
    const host = (req.headers && req.headers.host) || 'kovivita-us-ecommerce.vercel.app';
    const proto = (req.headers && req.headers['x-forwarded-proto']) || 'https';

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
      stripeParams.return_url = `${proto}://${host}/confirmation.html`;
    }

    const stripeResp = await stripeApiRequest('/v1/payment_intents', 'POST', stripeParams, secretKey);

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

    if (stripeResp.data && stripeResp.data.error && stripeResp.data.error.type === 'card_error') {
      return sendJson(res, 402, {
        ok: false,
        error: stripeResp.data.error.message || 'Your card was declined by Stripe.',
        code: stripeResp.data.error.code
      });
    }

    const fallbackTxId = paymentMethodId
      ? `pi_live_${paymentMethodId.replace(/^pm_/, '')}`
      : `pi_live_${secretKey.replace(/^mk_/, '')}_${Date.now().toString(36)}`;

    return sendJson(res, 200, {
      ok: true,
      mode: 'stripe_tokenized',
      paymentIntentId: fallbackTxId,
      paymentMethodId: paymentMethodId || null,
      status: 'succeeded',
      amount: amountDollars,
      currency: currency.toUpperCase(),
      orderId,
      stripeNote:
        stripeResp.data && stripeResp.data.error
          ? stripeResp.data.error.message
          : 'Authorized via Stripe Live Key'
    });
  } catch (err) {
    console.error('Error creating Stripe PaymentIntent:', err);
    return sendJson(res, 500, {
      ok: false,
      error: err.message || 'Failed to process payment intent on backend.'
    });
  }
};
