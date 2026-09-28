import * as z from 'zod/v4';

export const ReactScreenBindingSchema = z.object({
  apiId: z.string().uuid(), apiVersion: z.number().int().positive(), evidenceId: z.string().uuid(),
  input: z.record(z.string().max(64), z.union([z.string().max(500), z.number().finite(), z.boolean()])),
}).strict();
const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const ScreenQueryExpectationSchema = ReactScreenBindingSchema.extend({
  datasetVersions: z.record(z.string(), hash),
  definitionVersions: z.record(z.string(), z.object({ id: z.string(), version: z.string(), hash }).strict()),
  plan: z.record(z.string(), z.unknown()),
}).strict();
