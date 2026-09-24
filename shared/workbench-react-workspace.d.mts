/** @param {z.infer<typeof ReactSourceSchema>} source */
export function normalizeReactSource(source: z.infer<typeof ReactSourceSchema>): {
    title: string;
    workspace: {
        schemaVersion: 1;
        entry: string;
        packageSetId: "react18-tailwind4-v1";
        files: Record<string, string>;
    };
};
/** @param {z.infer<typeof ReactWorkspaceSchema>} workspace */
export function canonicalWorkspace(workspace: z.infer<typeof ReactWorkspaceSchema>): string;
/** Legacy identity must remain unchanged for immutable versions and outstanding receipts.
 * @param {z.infer<typeof ReactSourceSchema>} source */
export function reactSourceIdentity(source: z.infer<typeof ReactSourceSchema>): string;
/** @param {z.infer<typeof ReactSourceSchema>} source
 * @param {z.infer<typeof ReactApiRefsSchema>} apis */
export function editorIdentity(source: z.infer<typeof ReactSourceSchema>, apis: z.infer<typeof ReactApiRefsSchema>): string;
export const REACT_PACKAGE_SET_ID: "react18-tailwind4-v1";
export const MAX_WORKSPACE_BYTES: 180000;
export const MAX_WORKSPACE_FILES: 32;
export const MAX_REACT_DIAGNOSTICS: 50;
export const WorkspacePathSchema: z.ZodString;
export const ReactWorkspaceSchema: z.ZodObject<{
    schemaVersion: z.ZodLiteral<1>;
    entry: z.ZodString;
    packageSetId: z.ZodLiteral<"react18-tailwind4-v1">;
    files: z.ZodRecord<z.ZodString, z.ZodString>;
}, z.core.$strict>;
export const WorkspaceSourceSchema: z.ZodObject<{
    title: z.ZodString;
    workspace: z.ZodObject<{
        schemaVersion: z.ZodLiteral<1>;
        entry: z.ZodString;
        packageSetId: z.ZodLiteral<"react18-tailwind4-v1">;
        files: z.ZodRecord<z.ZodString, z.ZodString>;
    }, z.core.$strict>;
}, z.core.$strict>;
export const LegacyReactSourceSchema: z.ZodObject<{
    title: z.ZodString;
    code: z.ZodString;
}, z.core.$strict>;
export const ReactSourceSchema: z.ZodUnion<readonly [z.ZodObject<{
    title: z.ZodString;
    workspace: z.ZodObject<{
        schemaVersion: z.ZodLiteral<1>;
        entry: z.ZodString;
        packageSetId: z.ZodLiteral<"react18-tailwind4-v1">;
        files: z.ZodRecord<z.ZodString, z.ZodString>;
    }, z.core.$strict>;
}, z.core.$strict>, z.ZodObject<{
    title: z.ZodString;
    code: z.ZodString;
}, z.core.$strict>]>;
export const ReactApiRefsSchema: z.ZodArray<z.ZodObject<{
    id: z.ZodString;
    version: z.ZodNumber;
}, z.core.$strict>>;
export const ReactDiagnosticSchema: z.ZodObject<{
    file: z.ZodString;
    line: z.ZodNumber;
    column: z.ZodNumber;
    code: z.ZodUnion<readonly [z.ZodNumber, z.ZodString]>;
    message: z.ZodString;
}, z.core.$strict>;
import * as z from 'zod/v4';
