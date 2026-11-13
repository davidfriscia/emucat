import { expect, it } from 'vitest';
import { captureCommandSchema, captureRequestSchema, captureRetrySchema } from '../src/index.js';
import { fixture } from './helpers.js';

const examples = fixture<{
  valid: Record<string, unknown>;
  invalidFields: Record<string, unknown>[];
}>('captures');
it('accepts only capture identities, using the fixture shared with Rust', () => {
  expect(captureCommandSchema.safeParse(examples.valid).success).toBe(true);
  for (const invalid of examples.invalidFields)
    expect(captureCommandSchema.safeParse({ ...examples.valid, ...invalid }).success).toBe(false);
});
it('bounds retries and refuses commands or paths in the browser request', () => {
  const requestId = examples.valid.operationId;
  expect(captureRequestSchema.safeParse({ requestId }).success).toBe(true);
  for (const invalid of examples.invalidFields)
    expect(captureRequestSchema.safeParse({ requestId, ...invalid }).success).toBe(false);
  for (const attempt of [0, 4, -1, 1.5])
    expect(captureRetrySchema.safeParse({ operationId: requestId, attempt }).success).toBe(false);
  expect(captureRetrySchema.safeParse({ operationId: requestId, attempt: 3 }).success).toBe(true);
});
