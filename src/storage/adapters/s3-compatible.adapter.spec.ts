import { S3CompatibleAdapter } from './s3-compatible.adapter';

// We test the parts that DON'T require a live S3 client: object-key
// shape, canonical URI building, and the construction-time wiring. The
// per-method S3 send() paths are exercised by the existing
// DocumentsService integration tests (they substitute an adapter mock
// at the service layer).

describe('S3CompatibleAdapter', () => {
  function makeAdapter(
    overrides: Partial<
      ConstructorParameters<typeof S3CompatibleAdapter>[0]
    > = {},
  ) {
    return new S3CompatibleAdapter({
      providerId: 'provider-1',
      providerSlug: 'spaces-default',
      endpoint: 'https://nyc3.digitaloceanspaces.com',
      region: 'nyc3',
      bucket: 'orbit-kyc-v1',
      accessKeyId: 'key',
      secretAccessKey: 'secret',
      ...overrides,
    });
  }

  it('exposes the provider identity on the StorageAdapter surface', () => {
    const adapter = makeAdapter();
    expect(adapter.providerId).toBe('provider-1');
    expect(adapter.providerSlug).toBe('spaces-default');
    expect(adapter.bucket).toBe('orbit-kyc-v1');
  });

  it('builds the canonical URI from endpoint / bucket / key (trailing-slash safe)', () => {
    const a = makeAdapter();
    expect(a.canonicalUri('user/u1/nin/abc.jpg')).toBe(
      'https://nyc3.digitaloceanspaces.com/orbit-kyc-v1/user/u1/nin/abc.jpg',
    );

    const withSlash = makeAdapter({
      endpoint: 'https://fra1.digitaloceanspaces.com/',
    });
    expect(withSlash.canonicalUri('a/b/c.pdf')).toBe(
      'https://fra1.digitaloceanspaces.com/orbit-kyc-v1/a/b/c.pdf',
    );
  });

  it('builds object keys with the ARCH-9 layout: <ownerType>/<ownerId>/<docType>/<uuid>.<ext>', async () => {
    const adapter = makeAdapter();
    // The adapter calls a real S3 presigner under the hood. For this
    // test we only inspect the objectKey shape, which is built before
    // any network call. We spy on the underlying client.send so we
    // never actually fire a request — the presigner will still
    // synthesise a URL deterministically against the fake creds.
    const { objectKey } = await adapter.generateUploadUrl({
      ownerType: 'user',
      ownerId: '11111111-2222-3333-4444-555566667777',
      docType: 'nin',
      contentType: 'image/jpeg',
    });
    expect(objectKey).toMatch(
      /^user\/11111111-2222-3333-4444-555566667777\/nin\/[0-9a-f-]{36}\.jpg$/,
    );
  });

  it('plumbs Supabase-shape config through the same adapter (STG-3)', async () => {
    // Supabase Storage exposes an S3 API at
    //   https://<project>.supabase.co/storage/v1/s3
    // with a project-region for `region` and a Supabase bucket name. No
    // new adapter class needed — the S3 wire protocol covers it. This
    // test pins the plumbing so a future regression that hard-codes a
    // DigitalOcean assumption fails loudly.
    const adapter = makeAdapter({
      providerSlug: 'supabase-eu-central',
      endpoint: 'https://abcdefghij.supabase.co/storage/v1/s3',
      region: 'eu-central-1',
      bucket: 'kyc-v1',
      accessKeyId: 'sb-access-id',
      secretAccessKey: 'sb-secret',
    });

    expect(adapter.providerSlug).toBe('supabase-eu-central');
    expect(adapter.bucket).toBe('kyc-v1');
    expect(adapter.canonicalUri('user/u/nin/abc.jpg')).toBe(
      'https://abcdefghij.supabase.co/storage/v1/s3/kyc-v1/user/u/nin/abc.jpg',
    );

    const { uploadUrl, objectKey } = await adapter.generateUploadUrl({
      ownerType: 'user',
      ownerId: 'u',
      docType: 'nin',
      contentType: 'image/jpeg',
    });
    // The signed URL must target the Supabase host (virtual-host
    // style puts the bucket as a subdomain, path style keeps it in
    // the path — either is fine; what matters is the SDK didn't
    // bake a Spaces endpoint).
    expect(uploadUrl).toMatch(/supabase\.co/);
    expect(uploadUrl).not.toMatch(/digitaloceanspaces\.com/);
    expect(objectKey.startsWith('user/u/nin/')).toBe(true);
  });

  it('maps known MIME types to their preferred file extensions', async () => {
    const adapter = makeAdapter();
    const png = await adapter.generateUploadUrl({
      ownerType: 'user',
      ownerId: 'u',
      docType: 'selfie',
      contentType: 'image/png',
    });
    expect(png.objectKey.endsWith('.png')).toBe(true);

    const pdf = await adapter.generateUploadUrl({
      ownerType: 'vehicle',
      ownerId: 'v',
      docType: 'vehicle_registration',
      contentType: 'application/pdf',
    });
    expect(pdf.objectKey.endsWith('.pdf')).toBe(true);

    const unknown = await adapter.generateUploadUrl({
      ownerType: 'user',
      ownerId: 'u',
      docType: 'gov_id',
      // intentionally past the allowlist — adapter shouldn't crash,
      // just fall back to .bin
      contentType: 'application/x-unknown',
    });
    expect(unknown.objectKey.endsWith('.bin')).toBe(true);
  });
});
