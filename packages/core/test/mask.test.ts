import { describe, expect, it } from 'vitest';
import { maskSecrets } from '../src/mask';

// All fixtures below are SYNTHETIC and assembled at runtime from split literals,
// so no contiguous credential pattern ever appears in this source file. The full
// string only exists in memory when the test runs.

describe('maskSecrets — each credential class is redacted', () => {
  it('OpenAI / Anthropic sk- keys', () => {
    const key = 'sk' + '-' + 'ABCDEFGH12345678abcdefghij';
    const masked = maskSecrets(`use ${key} as the key`);
    expect(masked).not.toContain(key);
    expect(masked).toContain('[REDACTED]');
  });

  it('GitHub ghp_ / gho_ tokens', () => {
    const ghp = 'ghp' + '_' + '0123456789abcdef0123456789abcdefABCD';
    const gho = 'gho' + '_' + 'abcdefghij0123456789ABCDEFghijklmn';
    expect(maskSecrets(ghp)).toBe('[REDACTED]');
    expect(maskSecrets(gho)).toBe('[REDACTED]');
  });

  it('Slack xox tokens', () => {
    const xoxb = 'xox' + 'b-' + '1234567890-abcdefghijklmnop';
    const xoxp = 'xox' + 'p-' + '9876543210-ZYXWVUTSRQ';
    expect(maskSecrets(`token=${xoxb}`)).toContain('[REDACTED]');
    expect(maskSecrets(xoxp)).toBe('[REDACTED]');
  });

  it('AWS AKIA / ASIA access key ids', () => {
    const akia = 'AKI' + 'A' + 'IOSFODNN7EXAMPLE';
    const asia = 'ASI' + 'A' + 'J4B2C3D4E5F6G7H8';
    expect(maskSecrets(akia)).toBe('[REDACTED]');
    expect(maskSecrets(`key ${asia} rotates`)).toContain('[REDACTED]');
    expect(maskSecrets(`key ${asia} rotates`)).not.toContain(asia);
  });

  it('JWT triplets', () => {
    const header = 'eyJ' + 'hbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9';
    const jwt = [header, 'eyJzdWIiOiIxMjM0NTY3ODkwIn0', 'dozjgNryP4J3jVmNHl0w5N'].join('.');
    expect(maskSecrets(`bearer ${jwt}`)).not.toContain(header);
    expect(maskSecrets(`bearer ${jwt}`)).toContain('[REDACTED]');
  });

  it('npm tokens', () => {
    const npm = 'npm' + '_' + 'abcdefghijklmnopqrstuvwxyz0123456789';
    expect(maskSecrets(npm)).toBe('[REDACTED]');
  });

  it('underscore-prefixed provider keys (whsec_, secret_ …)', () => {
    const whsec = 'whse' + 'c_' + 'abcdefghijklmnop0123456789';
    const secret = 'secre' + 't_' + 'ABCDEFGHIJKLMNOP1234567890';
    expect(maskSecrets(whsec)).toBe('[REDACTED]');
    expect(maskSecrets(secret)).toBe('[REDACTED]');
  });

  it('generic 32+ char tokens after a marker word', () => {
    const long = 'a'.repeat(40);
    expect(maskSecrets(`token: ${long}`)).toBe('token: [REDACTED]');
    const b64 = 'B'.repeat(32);
    expect(maskSecrets(`password="${b64}"`)).toBe('password="[REDACTED]"');
    const hex = 'deadbeef'.repeat(4); // 32 hex chars
    expect(maskSecrets(`api_key=${hex}`)).toContain('[REDACTED]');
    expect(maskSecrets(`api_key=${hex}`)).not.toContain(hex);
  });
});

describe('maskSecrets — benign text is left untouched', () => {
  it('normal prose', () => {
    const s = 'The quick brown fox jumps over the lazy dog.';
    expect(maskSecrets(s)).toBe(s);
  });

  it('short hex and identifiers', () => {
    const s = 'commit deadbeef and cafe1234 look fine here';
    expect(maskSecrets(s)).toBe(s);
  });

  it('URLs without embedded tokens', () => {
    const s = 'Visit https://example.com/path/to/some/page?q=hello&lang=en';
    expect(maskSecrets(s)).toBe(s);
  });

  it('a bare long value with no marker is not force-masked', () => {
    const s = `the identifier ${'x'.repeat(50)} is fine`;
    expect(maskSecrets(s)).toBe(s);
  });

  it('empty string', () => {
    expect(maskSecrets('')).toBe('');
  });
});
