import { z } from 'zod';
import { EMULATOR_TYPES } from './emulator.js';

export const APP_NAME = 'EmuCat';
export const APP_VERSION = '0.1.0';
export const API_VERSION = 'v1';
export const API_PREFIX = `/api/${API_VERSION}`;

export const errorResponseSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    requestId: z.string(),
    details: z.array(z.object({ path: z.string(), message: z.string() })).optional(),
  }),
});
export type ErrorResponse = z.infer<typeof errorResponseSchema>;

export const healthResponseSchema = z.object({ status: z.literal('ok') });
export type HealthResponse = z.infer<typeof healthResponseSchema>;

const checkResultSchema = z.enum(['ok', 'failed', 'skipped']);

export const readyResponseSchema = z.object({
  status: z.enum(['ready', 'not_ready']),
  checks: z.object({ database: checkResultSchema, migrations: checkResultSchema }),
});
export type ReadyResponse = z.infer<typeof readyResponseSchema>;

export const infoResponseSchema = z.object({
  name: z.literal(APP_NAME),
  version: z.string(),
  apiVersion: z.string(),
  protocolVersion: z.number().int().positive(),
  emulatorTypes: z.array(z.enum(EMULATOR_TYPES)),
});
export type InfoResponse = z.infer<typeof infoResponseSchema>;
