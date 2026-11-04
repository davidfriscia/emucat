import type { FastifySchemaCompiler } from 'fastify';
import type { ZodType } from 'zod';

/** Lets routes declare `schema: { body, querystring, params, headers }` with Zod schemas. */
export const zodValidatorCompiler: FastifySchemaCompiler<ZodType> =
  ({ schema }) =>
  (data) => {
    const result = schema.safeParse(data);
    return result.success ? { value: result.data } : { error: result.error };
  };
