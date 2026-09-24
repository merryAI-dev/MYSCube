export const ReactScreenBindingSchema: z.ZodObject<{
    apiId: z.ZodString;
    apiVersion: z.ZodNumber;
    evidenceId: z.ZodString;
    input: z.ZodRecord<z.ZodString, z.ZodUnion<readonly [z.ZodString, z.ZodNumber, z.ZodBoolean]>>;
}, z.core.$strict>;
export const ScreenQueryExpectationSchema: z.ZodObject<{
    apiId: z.ZodString;
    apiVersion: z.ZodNumber;
    evidenceId: z.ZodString;
    input: z.ZodRecord<z.ZodString, z.ZodUnion<readonly [z.ZodString, z.ZodNumber, z.ZodBoolean]>>;
    datasetVersions: z.ZodRecord<z.ZodString, z.ZodString>;
    definitionVersions: z.ZodRecord<z.ZodString, z.ZodObject<{
        id: z.ZodString;
        version: z.ZodString;
        hash: z.ZodString;
    }, z.core.$strict>>;
    plan: z.ZodRecord<z.ZodString, z.ZodUnknown>;
}, z.core.$strict>;
import * as z from 'zod/v4';
