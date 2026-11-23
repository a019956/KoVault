// @vitest-environment node
import { expect, it } from 'vitest';
import { gunzipToText, gzip } from '../src/lib/compress';

it('gzips and gunzips, and passes plain text through', async () => {
  const text = JSON.stringify({ hello: 'world'.repeat(200) });
  const z = await gzip(text);
  expect(z.length).toBeLessThan(text.length / 5);
  expect(await gunzipToText(z)).toBe(text);
  expect(await gunzipToText(new TextEncoder().encode('{"a":1}'))).toBe('{"a":1}');
});
