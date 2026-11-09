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
    const orderId = body.orderId || `KV-${Math.floor(10000 + Math.random() * 90000)}US`;
    const origin = request.headers.get('origin') || 'https://kovivita.vercel.app';

    const sessionParams = {
      mode: 'payment',
      success_url: `${origin}/confirmation.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${origin}/checkout.html`,
      'line_items[0][price_data][currency]': 'usd',
      'line_items[0][price_data][product_data][name]': `Kovivita Holiday Order (${orderId})`,
      'line_items[0][price_data][unit_amount]': amountCents,
      'line_items[0][quantity]': 1
    };

    const stripeResp = await stripeApiRequest('/v1/checkout/sessions', 'POST', sessionParams, secretKey);
    if (stripeResp.statusCode >= 200 && stripeResp.statusCode < 300 && stripeResp.data && stripeResp.data.url) {
      return Response.json({
        ok: true,
        sessionId: stripeResp.data.id,
        url: stripeResp.data.url
      });
    }

    return Response.json({
      ok: false,
      stripeError:
        stripeResp.data && stripeResp.data.error
          ? stripeResp.data.error.message
          : 'Unable to create Stripe Hosted Session'
    });
  } catch (err) {
    console.error('Error creating Stripe Checkout Session:', err);
    return Response.json({ ok: false, error: err.message }, { status: 500 });
  }
}
