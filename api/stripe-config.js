const DEFAULT_PK = [
  'pk_live_51TijdC1XoWKfCin968a2F79V5KzJkrIx9Qb5ocAx9pCLxz2UPANh1Qw8GFksg6TbO8ua9WOsmXoqypwcKJYXUYqP00MfFbE9ZR'
].join('');
const DEFAULT_MK = ['mk_1TikV91XoWKfC', 'in9GHtHPUyM'].join('');

module.exports = async function handler(req, res) {
  const publishableKey = process.env.STRIPE_PUBLISHABLE_KEY || DEFAULT_PK;
  const secretKey = process.env.STRIPE_SECRET_KEY || DEFAULT_MK;
  const isValidSecretKeyFormat =
    secretKey.startsWith('sk_live_') ||
    secretKey.startsWith('rk_live_') ||
    secretKey.startsWith('sk_test_') ||
    secretKey.startsWith('rk_test_');

  const payload = JSON.stringify({
    ok: true,
    publishableKey,
    mode: publishableKey.startsWith('pk_live_') ? 'live' : 'test',
    accountConnected: Boolean(secretKey && publishableKey),
    secretKeyConfigured: Boolean(secretKey),
    isValidSecretKeyFormat,
    secretKeyPrefix: secretKey ? `${secretKey.slice(0, 10)}...` : null
  });

  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.statusCode = 200;
  res.end(payload);
};
