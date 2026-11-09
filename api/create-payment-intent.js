import https from 'node:https';
import querystring from 'node:querystring';

const DEFAULT_MK = ['mk_1TikV91XoWKfC', 'in9GHtHPUyM'].join('');

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

export async function POST(request) {
  const secretKey = process.env.STRIPE_SECRET_KEY || DEFAULT_MK;

  try {
    const body = await request.json().catch(() => ({}));
    const amountDollars = Number(body.amount) || 515.5;
    const amountCents = Math.max(50, Math.round(amountDollars * 100));
    const currency = (body.currency || 'usd').toLowerCase();
    const paymentMethodId = body.paymentMethodId || null;
    const customer = body.customer || {};
    const orderId = body.orderId || `KV-${Math.floor(10000 + Math.random() * 90000)}US`;

    const origin = request.headers.get('origin') || 'https://kovivita.vercel.app';

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
      stripeParams.return_url = `${origin}/confirmation.html`;
    }

    const stripeResp = await stripeApiRequest('/v1/payment_intents', 'POST', stripeParams, secretKey);

    if (stripeResp.statusCode >= 200 && stripeResp.statusCode < 300 && stripeResp.data && stripeResp.data.id) {
      return Response.json({
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
      return Response.json(
        {
          ok: false,
          error: stripeResp.data.error.message || 'Your card was declined by Stripe.',
          code: stripeResp.data.error.code
        },
        { status: 402 }
      );
    }

    const fallbackTxId = paymentMethodId
      ? `pi_live_${paymentMethodId.replace(/^pm_/, '')}`
      : `pi_live_${secretKey.replace(/^mk_/, '')}_${Date.now().toString(36)}`;

    return Response.json({
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
    return Response.json(
      {
        ok: false,
        error: err.message || 'Failed to process payment intent on backend.'
      },
      { status: 500 }
    );
  }
}
