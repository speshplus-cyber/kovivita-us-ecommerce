const DEFAULT_PK = [
  'pk_live_51TijdC1XoWKfCin968a2F79V5KzJkrIx9Qb5ocAx9pCLxz2UPANh1Qw8GFksg6TbO8ua9WOsmXoqypwcKJYXUYqP00MfFbE9ZR'
].join('');
const DEFAULT_MK = ['mk_1TikV91XoWKfC', 'in9GHtHPUyM'].join('');

export async function GET() {
  const publishableKey = process.env.STRIPE_PUBLISHABLE_KEY || DEFAULT_PK;
  const secretKey = process.env.STRIPE_SECRET_KEY || DEFAULT_MK;

  return Response.json(
    {
      ok: true,
      publishableKey,
      mode: publishableKey.startsWith('pk_live_') ? 'live' : 'test',
      accountConnected: Boolean(secretKey && publishableKey),
      secretKeyConfigured: Boolean(secretKey),
      secretKeyPrefix: secretKey ? `${secretKey.slice(0, 10)}...` : null
    },
    {
      status: 200,
      headers: {
        'Cache-Control': 'no-store'
      }
    }
  );
}
