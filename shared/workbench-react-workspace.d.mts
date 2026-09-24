/** @param {unknown} value */
export function selectReactRuntimeArtifact(value: unknown): {
    bundle: string;
    css: string;
    bundleHash: string;
    cssHash: string;
    runtimeVersion: "react-preview-v1";
    packageSetHash: string;
};
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
export const REACT_ARTIFACT_SCHEMA_VERSION: 1;
export const REACT_REVISION_SCHEMA_VERSION: 1;
export const REACT_RUNTIME_VERSION: "react-preview-v1";
export const REACT_BUILD_DEPENDENCIES: readonly Readonly<{
    name: string;
    version: string;
}>[];
export const REACT_TYPE_DEPENDENCIES: readonly Readonly<{
    name: string;
    version: string;
}>[];
export const ReactTypecheckSchema: z.ZodObject<{
    status: z.ZodLiteral<"passed">;
    declarationHash: z.ZodString;
    typescriptVersion: z.ZodLiteral<"5.9.3">;
    dependencies: z.ZodArray<z.ZodObject<{
        name: z.ZodString;
        version: z.ZodString;
    }, z.core.$strict>>;
}, z.core.$strict>;
export const ReactRuntimeArtifactSchema: z.ZodObject<{
    bundle: z.ZodString;
    css: z.ZodString;
    bundleHash: z.ZodString;
    cssHash: z.ZodString;
    runtimeVersion: z.ZodLiteral<"react-preview-v1">;
    packageSetHash: z.ZodString;
}, z.core.$strict>;
export const ReactRuntimeArtifactJsonSchema: z.core.ZodStandardJSONSchemaPayload<z.ZodObject<{
    bundle: z.ZodString;
    css: z.ZodString;
    bundleHash: z.ZodString;
    cssHash: z.ZodString;
    runtimeVersion: z.ZodLiteral<"react-preview-v1">;
    packageSetHash: z.ZodString;
}, z.core.$strict>>;
export const ReactLegacyArtifactSchema: z.ZodObject<{
    workspaceHash: z.ZodOptional<z.ZodString>;
    typecheck: z.ZodOptional<z.ZodObject<{
        status: z.ZodLiteral<"passed">;
        typescriptVersion: z.ZodString;
        dependencies: z.ZodArray<z.ZodObject<{
            name: z.ZodString;
            version: z.ZodString;
        }, z.core.$strict>>;
        declarationHash: z.ZodString;
    }, z.core.$strict>>;
    bundle: z.ZodString;
    css: z.ZodString;
    sourceHash: z.ZodString;
    bundleHash: z.ZodString;
    cssHash: z.ZodString;
    runtimeVersion: z.ZodLiteral<"react-preview-v1">;
    packageSetHash: z.ZodString;
    dependencies: z.ZodArray<z.ZodObject<{
        name: z.ZodString;
        version: z.ZodString;
    }, z.core.$strict>>;
}, z.core.$strict>;
export const ReactCompiledArtifactSchema: z.ZodObject<{
    schemaVersion: z.ZodLiteral<1>;
    workspaceHash: z.ZodString;
    dependencies: z.ZodArray<z.ZodObject<{
        name: z.ZodString;
        version: z.ZodString;
    }, z.core.$strict>>;
    typecheck: z.ZodObject<{
        status: z.ZodLiteral<"passed">;
        declarationHash: z.ZodString;
        typescriptVersion: z.ZodLiteral<"5.9.3">;
        dependencies: z.ZodArray<z.ZodObject<{
            name: z.ZodString;
            version: z.ZodString;
        }, z.core.$strict>>;
    }, z.core.$strict>;
    bundle: z.ZodString;
    css: z.ZodString;
    sourceHash: z.ZodString;
    bundleHash: z.ZodString;
    cssHash: z.ZodString;
    runtimeVersion: z.ZodLiteral<"react-preview-v1">;
    packageSetHash: z.ZodString;
}, z.core.$strict>;
export const ReactArtifactSchema: z.ZodUnion<readonly [z.ZodObject<{
    schemaVersion: z.ZodLiteral<1>;
    workspaceHash: z.ZodString;
    dependencies: z.ZodArray<z.ZodObject<{
        name: z.ZodString;
        version: z.ZodString;
    }, z.core.$strict>>;
    typecheck: z.ZodObject<{
        status: z.ZodLiteral<"passed">;
        declarationHash: z.ZodString;
        typescriptVersion: z.ZodLiteral<"5.9.3">;
        dependencies: z.ZodArray<z.ZodObject<{
            name: z.ZodString;
            version: z.ZodString;
        }, z.core.$strict>>;
    }, z.core.$strict>;
    bundle: z.ZodString;
    css: z.ZodString;
    sourceHash: z.ZodString;
    bundleHash: z.ZodString;
    cssHash: z.ZodString;
    runtimeVersion: z.ZodLiteral<"react-preview-v1">;
    packageSetHash: z.ZodString;
}, z.core.$strict>, z.ZodObject<{
    workspaceHash: z.ZodOptional<z.ZodString>;
    typecheck: z.ZodOptional<z.ZodObject<{
        status: z.ZodLiteral<"passed">;
        typescriptVersion: z.ZodString;
        dependencies: z.ZodArray<z.ZodObject<{
            name: z.ZodString;
            version: z.ZodString;
        }, z.core.$strict>>;
        declarationHash: z.ZodString;
    }, z.core.$strict>>;
    bundle: z.ZodString;
    css: z.ZodString;
    sourceHash: z.ZodString;
    bundleHash: z.ZodString;
    cssHash: z.ZodString;
    runtimeVersion: z.ZodLiteral<"react-preview-v1">;
    packageSetHash: z.ZodString;
    dependencies: z.ZodArray<z.ZodObject<{
        name: z.ZodString;
        version: z.ZodString;
    }, z.core.$strict>>;
}, z.core.$strict>]>;
export const ReactExecutionArtifactSchema: z.ZodUnion<readonly [z.ZodObject<{
    schemaVersion: z.ZodLiteral<1>;
    workspaceHash: z.ZodString;
    dependencies: z.ZodArray<z.ZodObject<{
        name: z.ZodString;
        version: z.ZodString;
    }, z.core.$strict>>;
    typecheck: z.ZodObject<{
        status: z.ZodLiteral<"passed">;
        declarationHash: z.ZodString;
        typescriptVersion: z.ZodLiteral<"5.9.3">;
        dependencies: z.ZodArray<z.ZodObject<{
            name: z.ZodString;
            version: z.ZodString;
        }, z.core.$strict>>;
    }, z.core.$strict>;
    bundle: z.ZodString;
    css: z.ZodString;
    sourceHash: z.ZodString;
    bundleHash: z.ZodString;
    cssHash: z.ZodString;
    runtimeVersion: z.ZodLiteral<"react-preview-v1">;
    packageSetHash: z.ZodString;
    executionId: z.ZodString;
}, z.core.$strict>, z.ZodObject<{
    workspaceHash: z.ZodOptional<z.ZodString>;
    typecheck: z.ZodOptional<z.ZodObject<{
        status: z.ZodLiteral<"passed">;
        typescriptVersion: z.ZodString;
        dependencies: z.ZodArray<z.ZodObject<{
            name: z.ZodString;
            version: z.ZodString;
        }, z.core.$strict>>;
        declarationHash: z.ZodString;
    }, z.core.$strict>>;
    bundle: z.ZodString;
    css: z.ZodString;
    sourceHash: z.ZodString;
    bundleHash: z.ZodString;
    cssHash: z.ZodString;
    runtimeVersion: z.ZodLiteral<"react-preview-v1">;
    packageSetHash: z.ZodString;
    dependencies: z.ZodArray<z.ZodObject<{
        name: z.ZodString;
        version: z.ZodString;
    }, z.core.$strict>>;
    executionId: z.ZodString;
}, z.core.$strict>]>;
export const ReactCurrentRevisionSchema: z.ZodObject<{
    schemaVersion: z.ZodLiteral<1>;
    source: z.ZodObject<{
        title: z.ZodString;
        workspace: z.ZodObject<{
            schemaVersion: z.ZodLiteral<1>;
            entry: z.ZodString;
            packageSetId: z.ZodLiteral<"react18-tailwind4-v1">;
            files: z.ZodRecord<z.ZodString, z.ZodString>;
        }, z.core.$strict>;
    }, z.core.$strict>;
    artifact: z.ZodObject<{
        schemaVersion: z.ZodLiteral<1>;
        workspaceHash: z.ZodString;
        dependencies: z.ZodArray<z.ZodObject<{
            name: z.ZodString;
            version: z.ZodString;
        }, z.core.$strict>>;
        typecheck: z.ZodObject<{
            status: z.ZodLiteral<"passed">;
            declarationHash: z.ZodString;
            typescriptVersion: z.ZodLiteral<"5.9.3">;
            dependencies: z.ZodArray<z.ZodObject<{
                name: z.ZodString;
                version: z.ZodString;
            }, z.core.$strict>>;
        }, z.core.$strict>;
        bundle: z.ZodString;
        css: z.ZodString;
        sourceHash: z.ZodString;
        bundleHash: z.ZodString;
        cssHash: z.ZodString;
        runtimeVersion: z.ZodLiteral<"react-preview-v1">;
        packageSetHash: z.ZodString;
    }, z.core.$strict>;
    id: z.ZodString;
    version: z.ZodNumber;
    sourceHash: z.ZodString;
    apis: z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        version: z.ZodNumber;
    }, z.core.$strict>>;
    updatedAt: z.ZodISODateTime;
    updatedBy: z.ZodString;
    restoredFrom: z.ZodNullable<z.ZodNumber>;
}, z.core.$strict>;
export const ReactLegacyRevisionSchema: z.ZodObject<{
    source: z.ZodUnion<readonly [z.ZodObject<{
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
    artifact: z.ZodUnion<readonly [z.ZodObject<{
        schemaVersion: z.ZodLiteral<1>;
        workspaceHash: z.ZodString;
        dependencies: z.ZodArray<z.ZodObject<{
            name: z.ZodString;
            version: z.ZodString;
        }, z.core.$strict>>;
        typecheck: z.ZodObject<{
            status: z.ZodLiteral<"passed">;
            declarationHash: z.ZodString;
            typescriptVersion: z.ZodLiteral<"5.9.3">;
            dependencies: z.ZodArray<z.ZodObject<{
                name: z.ZodString;
                version: z.ZodString;
            }, z.core.$strict>>;
        }, z.core.$strict>;
        bundle: z.ZodString;
        css: z.ZodString;
        sourceHash: z.ZodString;
        bundleHash: z.ZodString;
        cssHash: z.ZodString;
        runtimeVersion: z.ZodLiteral<"react-preview-v1">;
        packageSetHash: z.ZodString;
    }, z.core.$strict>, z.ZodObject<{
        workspaceHash: z.ZodOptional<z.ZodString>;
        typecheck: z.ZodOptional<z.ZodObject<{
            status: z.ZodLiteral<"passed">;
            typescriptVersion: z.ZodString;
            dependencies: z.ZodArray<z.ZodObject<{
                name: z.ZodString;
                version: z.ZodString;
            }, z.core.$strict>>;
            declarationHash: z.ZodString;
        }, z.core.$strict>>;
        bundle: z.ZodString;
        css: z.ZodString;
        sourceHash: z.ZodString;
        bundleHash: z.ZodString;
        cssHash: z.ZodString;
        runtimeVersion: z.ZodLiteral<"react-preview-v1">;
        packageSetHash: z.ZodString;
        dependencies: z.ZodArray<z.ZodObject<{
            name: z.ZodString;
            version: z.ZodString;
        }, z.core.$strict>>;
    }, z.core.$strict>]>;
    id: z.ZodString;
    version: z.ZodNumber;
    sourceHash: z.ZodString;
    apis: z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        version: z.ZodNumber;
    }, z.core.$strict>>;
    updatedAt: z.ZodISODateTime;
    updatedBy: z.ZodString;
    restoredFrom: z.ZodNullable<z.ZodNumber>;
}, z.core.$strict>;
export const ReactRevisionSchema: z.ZodUnion<readonly [z.ZodObject<{
    schemaVersion: z.ZodLiteral<1>;
    source: z.ZodObject<{
        title: z.ZodString;
        workspace: z.ZodObject<{
            schemaVersion: z.ZodLiteral<1>;
            entry: z.ZodString;
            packageSetId: z.ZodLiteral<"react18-tailwind4-v1">;
            files: z.ZodRecord<z.ZodString, z.ZodString>;
        }, z.core.$strict>;
    }, z.core.$strict>;
    artifact: z.ZodObject<{
        schemaVersion: z.ZodLiteral<1>;
        workspaceHash: z.ZodString;
        dependencies: z.ZodArray<z.ZodObject<{
            name: z.ZodString;
            version: z.ZodString;
        }, z.core.$strict>>;
        typecheck: z.ZodObject<{
            status: z.ZodLiteral<"passed">;
            declarationHash: z.ZodString;
            typescriptVersion: z.ZodLiteral<"5.9.3">;
            dependencies: z.ZodArray<z.ZodObject<{
                name: z.ZodString;
                version: z.ZodString;
            }, z.core.$strict>>;
        }, z.core.$strict>;
        bundle: z.ZodString;
        css: z.ZodString;
        sourceHash: z.ZodString;
        bundleHash: z.ZodString;
        cssHash: z.ZodString;
        runtimeVersion: z.ZodLiteral<"react-preview-v1">;
        packageSetHash: z.ZodString;
    }, z.core.$strict>;
    id: z.ZodString;
    version: z.ZodNumber;
    sourceHash: z.ZodString;
    apis: z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        version: z.ZodNumber;
    }, z.core.$strict>>;
    updatedAt: z.ZodISODateTime;
    updatedBy: z.ZodString;
    restoredFrom: z.ZodNullable<z.ZodNumber>;
}, z.core.$strict>, z.ZodObject<{
    source: z.ZodUnion<readonly [z.ZodObject<{
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
    artifact: z.ZodUnion<readonly [z.ZodObject<{
        schemaVersion: z.ZodLiteral<1>;
        workspaceHash: z.ZodString;
        dependencies: z.ZodArray<z.ZodObject<{
            name: z.ZodString;
            version: z.ZodString;
        }, z.core.$strict>>;
        typecheck: z.ZodObject<{
            status: z.ZodLiteral<"passed">;
            declarationHash: z.ZodString;
            typescriptVersion: z.ZodLiteral<"5.9.3">;
            dependencies: z.ZodArray<z.ZodObject<{
                name: z.ZodString;
                version: z.ZodString;
            }, z.core.$strict>>;
        }, z.core.$strict>;
        bundle: z.ZodString;
        css: z.ZodString;
        sourceHash: z.ZodString;
        bundleHash: z.ZodString;
        cssHash: z.ZodString;
        runtimeVersion: z.ZodLiteral<"react-preview-v1">;
        packageSetHash: z.ZodString;
    }, z.core.$strict>, z.ZodObject<{
        workspaceHash: z.ZodOptional<z.ZodString>;
        typecheck: z.ZodOptional<z.ZodObject<{
            status: z.ZodLiteral<"passed">;
            typescriptVersion: z.ZodString;
            dependencies: z.ZodArray<z.ZodObject<{
                name: z.ZodString;
                version: z.ZodString;
            }, z.core.$strict>>;
            declarationHash: z.ZodString;
        }, z.core.$strict>>;
        bundle: z.ZodString;
        css: z.ZodString;
        sourceHash: z.ZodString;
        bundleHash: z.ZodString;
        cssHash: z.ZodString;
        runtimeVersion: z.ZodLiteral<"react-preview-v1">;
        packageSetHash: z.ZodString;
        dependencies: z.ZodArray<z.ZodObject<{
            name: z.ZodString;
            version: z.ZodString;
        }, z.core.$strict>>;
    }, z.core.$strict>]>;
    id: z.ZodString;
    version: z.ZodNumber;
    sourceHash: z.ZodString;
    apis: z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        version: z.ZodNumber;
    }, z.core.$strict>>;
    updatedAt: z.ZodISODateTime;
    updatedBy: z.ZodString;
    restoredFrom: z.ZodNullable<z.ZodNumber>;
}, z.core.$strict>]>;
export const ReactPageSchema: z.ZodUnion<readonly [z.ZodObject<{
    schemaVersion: z.ZodLiteral<1>;
    source: z.ZodObject<{
        title: z.ZodString;
        workspace: z.ZodObject<{
            schemaVersion: z.ZodLiteral<1>;
            entry: z.ZodString;
            packageSetId: z.ZodLiteral<"react18-tailwind4-v1">;
            files: z.ZodRecord<z.ZodString, z.ZodString>;
        }, z.core.$strict>;
    }, z.core.$strict>;
    artifact: z.ZodObject<{
        schemaVersion: z.ZodLiteral<1>;
        workspaceHash: z.ZodString;
        dependencies: z.ZodArray<z.ZodObject<{
            name: z.ZodString;
            version: z.ZodString;
        }, z.core.$strict>>;
        typecheck: z.ZodObject<{
            status: z.ZodLiteral<"passed">;
            declarationHash: z.ZodString;
            typescriptVersion: z.ZodLiteral<"5.9.3">;
            dependencies: z.ZodArray<z.ZodObject<{
                name: z.ZodString;
                version: z.ZodString;
            }, z.core.$strict>>;
        }, z.core.$strict>;
        bundle: z.ZodString;
        css: z.ZodString;
        sourceHash: z.ZodString;
        bundleHash: z.ZodString;
        cssHash: z.ZodString;
        runtimeVersion: z.ZodLiteral<"react-preview-v1">;
        packageSetHash: z.ZodString;
    }, z.core.$strict>;
    id: z.ZodString;
    version: z.ZodNumber;
    sourceHash: z.ZodString;
    apis: z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        version: z.ZodNumber;
    }, z.core.$strict>>;
    updatedAt: z.ZodISODateTime;
    updatedBy: z.ZodString;
    restoredFrom: z.ZodNullable<z.ZodNumber>;
}, z.core.$strict>, z.ZodObject<{
    source: z.ZodUnion<readonly [z.ZodObject<{
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
    artifact: z.ZodUnion<readonly [z.ZodObject<{
        schemaVersion: z.ZodLiteral<1>;
        workspaceHash: z.ZodString;
        dependencies: z.ZodArray<z.ZodObject<{
            name: z.ZodString;
            version: z.ZodString;
        }, z.core.$strict>>;
        typecheck: z.ZodObject<{
            status: z.ZodLiteral<"passed">;
            declarationHash: z.ZodString;
            typescriptVersion: z.ZodLiteral<"5.9.3">;
            dependencies: z.ZodArray<z.ZodObject<{
                name: z.ZodString;
                version: z.ZodString;
            }, z.core.$strict>>;
        }, z.core.$strict>;
        bundle: z.ZodString;
        css: z.ZodString;
        sourceHash: z.ZodString;
        bundleHash: z.ZodString;
        cssHash: z.ZodString;
        runtimeVersion: z.ZodLiteral<"react-preview-v1">;
        packageSetHash: z.ZodString;
    }, z.core.$strict>, z.ZodObject<{
        workspaceHash: z.ZodOptional<z.ZodString>;
        typecheck: z.ZodOptional<z.ZodObject<{
            status: z.ZodLiteral<"passed">;
            typescriptVersion: z.ZodString;
            dependencies: z.ZodArray<z.ZodObject<{
                name: z.ZodString;
                version: z.ZodString;
            }, z.core.$strict>>;
            declarationHash: z.ZodString;
        }, z.core.$strict>>;
        bundle: z.ZodString;
        css: z.ZodString;
        sourceHash: z.ZodString;
        bundleHash: z.ZodString;
        cssHash: z.ZodString;
        runtimeVersion: z.ZodLiteral<"react-preview-v1">;
        packageSetHash: z.ZodString;
        dependencies: z.ZodArray<z.ZodObject<{
            name: z.ZodString;
            version: z.ZodString;
        }, z.core.$strict>>;
    }, z.core.$strict>]>;
    id: z.ZodString;
    version: z.ZodNumber;
    sourceHash: z.ZodString;
    apis: z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        version: z.ZodNumber;
    }, z.core.$strict>>;
    updatedAt: z.ZodISODateTime;
    updatedBy: z.ZodString;
    restoredFrom: z.ZodNullable<z.ZodNumber>;
}, z.core.$strict>]>;
export const ReactPageListItemSchema: z.ZodObject<{
    id: z.ZodString;
    version: z.ZodNumber;
    source: z.ZodObject<{
        title: z.ZodString;
    }, z.core.$strict>;
    sourceHash: z.ZodString;
    updatedAt: z.ZodISODateTime;
    schemaVersion: z.ZodOptional<z.ZodLiteral<1>>;
}, z.core.$strict>;
export const ReactHistoryItemSchema: z.ZodObject<{
    id: z.ZodString;
    version: z.ZodNumber;
    source: z.ZodObject<{
        title: z.ZodString;
    }, z.core.$strict>;
    sourceHash: z.ZodString;
    updatedAt: z.ZodISODateTime;
    schemaVersion: z.ZodOptional<z.ZodLiteral<1>>;
    restoredFrom: z.ZodNullable<z.ZodNumber>;
}, z.core.$strict>;
export const ReactPageListSchema: z.ZodObject<{
    schemaVersion: z.ZodOptional<z.ZodLiteral<1>>;
    items: z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        version: z.ZodNumber;
        source: z.ZodObject<{
            title: z.ZodString;
        }, z.core.$strict>;
        sourceHash: z.ZodString;
        updatedAt: z.ZodISODateTime;
        schemaVersion: z.ZodOptional<z.ZodLiteral<1>>;
    }, z.core.$strict>>;
    truncated: z.ZodBoolean;
}, z.core.$strict>;
export const ReactHistorySchema: z.ZodObject<{
    schemaVersion: z.ZodOptional<z.ZodLiteral<1>>;
    items: z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        version: z.ZodNumber;
        source: z.ZodObject<{
            title: z.ZodString;
        }, z.core.$strict>;
        sourceHash: z.ZodString;
        updatedAt: z.ZodISODateTime;
        schemaVersion: z.ZodOptional<z.ZodLiteral<1>>;
        restoredFrom: z.ZodNullable<z.ZodNumber>;
    }, z.core.$strict>>;
}, z.core.$strict>;
export const ReactGitResultSchema: z.ZodObject<{
    status: z.ZodEnum<{
        complete: "complete";
        disabled: "disabled";
        failed: "failed";
        retryable: "retryable";
    }>;
    message: z.ZodOptional<z.ZodString>;
    id: z.ZodOptional<z.ZodString>;
    repository: z.ZodOptional<z.ZodString>;
    baseBranch: z.ZodOptional<z.ZodString>;
    branch: z.ZodOptional<z.ZodString>;
    pageId: z.ZodOptional<z.ZodString>;
    version: z.ZodOptional<z.ZodNumber>;
    sourceHash: z.ZodOptional<z.ZodString>;
    commitSha: z.ZodOptional<z.ZodString>;
    pullNumber: z.ZodOptional<z.ZodNumber>;
    pullUrl: z.ZodOptional<z.ZodString>;
    pullState: z.ZodOptional<z.ZodEnum<{
        open: "open";
        closed: "closed";
    }>>;
    merged: z.ZodOptional<z.ZodBoolean>;
    verifiedAt: z.ZodOptional<z.ZodISODateTime>;
    createdAt: z.ZodOptional<z.ZodISODateTime>;
    updatedAt: z.ZodOptional<z.ZodISODateTime>;
}, z.core.$strict>;
export const ReactPageMutationResponseSchema: z.ZodUnion<readonly [z.ZodObject<{
    schemaVersion: z.ZodLiteral<1>;
    source: z.ZodObject<{
        title: z.ZodString;
        workspace: z.ZodObject<{
            schemaVersion: z.ZodLiteral<1>;
            entry: z.ZodString;
            packageSetId: z.ZodLiteral<"react18-tailwind4-v1">;
            files: z.ZodRecord<z.ZodString, z.ZodString>;
        }, z.core.$strict>;
    }, z.core.$strict>;
    artifact: z.ZodObject<{
        schemaVersion: z.ZodLiteral<1>;
        workspaceHash: z.ZodString;
        dependencies: z.ZodArray<z.ZodObject<{
            name: z.ZodString;
            version: z.ZodString;
        }, z.core.$strict>>;
        typecheck: z.ZodObject<{
            status: z.ZodLiteral<"passed">;
            declarationHash: z.ZodString;
            typescriptVersion: z.ZodLiteral<"5.9.3">;
            dependencies: z.ZodArray<z.ZodObject<{
                name: z.ZodString;
                version: z.ZodString;
            }, z.core.$strict>>;
        }, z.core.$strict>;
        bundle: z.ZodString;
        css: z.ZodString;
        sourceHash: z.ZodString;
        bundleHash: z.ZodString;
        cssHash: z.ZodString;
        runtimeVersion: z.ZodLiteral<"react-preview-v1">;
        packageSetHash: z.ZodString;
    }, z.core.$strict>;
    id: z.ZodString;
    version: z.ZodNumber;
    sourceHash: z.ZodString;
    apis: z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        version: z.ZodNumber;
    }, z.core.$strict>>;
    updatedAt: z.ZodISODateTime;
    updatedBy: z.ZodString;
    restoredFrom: z.ZodNullable<z.ZodNumber>;
    git: z.ZodOptional<z.ZodObject<{
        status: z.ZodEnum<{
            complete: "complete";
            disabled: "disabled";
            failed: "failed";
            retryable: "retryable";
        }>;
        message: z.ZodOptional<z.ZodString>;
        id: z.ZodOptional<z.ZodString>;
        repository: z.ZodOptional<z.ZodString>;
        baseBranch: z.ZodOptional<z.ZodString>;
        branch: z.ZodOptional<z.ZodString>;
        pageId: z.ZodOptional<z.ZodString>;
        version: z.ZodOptional<z.ZodNumber>;
        sourceHash: z.ZodOptional<z.ZodString>;
        commitSha: z.ZodOptional<z.ZodString>;
        pullNumber: z.ZodOptional<z.ZodNumber>;
        pullUrl: z.ZodOptional<z.ZodString>;
        pullState: z.ZodOptional<z.ZodEnum<{
            open: "open";
            closed: "closed";
        }>>;
        merged: z.ZodOptional<z.ZodBoolean>;
        verifiedAt: z.ZodOptional<z.ZodISODateTime>;
        createdAt: z.ZodOptional<z.ZodISODateTime>;
        updatedAt: z.ZodOptional<z.ZodISODateTime>;
    }, z.core.$strict>>;
}, z.core.$strict>, z.ZodObject<{
    source: z.ZodUnion<readonly [z.ZodObject<{
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
    artifact: z.ZodUnion<readonly [z.ZodObject<{
        schemaVersion: z.ZodLiteral<1>;
        workspaceHash: z.ZodString;
        dependencies: z.ZodArray<z.ZodObject<{
            name: z.ZodString;
            version: z.ZodString;
        }, z.core.$strict>>;
        typecheck: z.ZodObject<{
            status: z.ZodLiteral<"passed">;
            declarationHash: z.ZodString;
            typescriptVersion: z.ZodLiteral<"5.9.3">;
            dependencies: z.ZodArray<z.ZodObject<{
                name: z.ZodString;
                version: z.ZodString;
            }, z.core.$strict>>;
        }, z.core.$strict>;
        bundle: z.ZodString;
        css: z.ZodString;
        sourceHash: z.ZodString;
        bundleHash: z.ZodString;
        cssHash: z.ZodString;
        runtimeVersion: z.ZodLiteral<"react-preview-v1">;
        packageSetHash: z.ZodString;
    }, z.core.$strict>, z.ZodObject<{
        workspaceHash: z.ZodOptional<z.ZodString>;
        typecheck: z.ZodOptional<z.ZodObject<{
            status: z.ZodLiteral<"passed">;
            typescriptVersion: z.ZodString;
            dependencies: z.ZodArray<z.ZodObject<{
                name: z.ZodString;
                version: z.ZodString;
            }, z.core.$strict>>;
            declarationHash: z.ZodString;
        }, z.core.$strict>>;
        bundle: z.ZodString;
        css: z.ZodString;
        sourceHash: z.ZodString;
        bundleHash: z.ZodString;
        cssHash: z.ZodString;
        runtimeVersion: z.ZodLiteral<"react-preview-v1">;
        packageSetHash: z.ZodString;
        dependencies: z.ZodArray<z.ZodObject<{
            name: z.ZodString;
            version: z.ZodString;
        }, z.core.$strict>>;
    }, z.core.$strict>]>;
    id: z.ZodString;
    version: z.ZodNumber;
    sourceHash: z.ZodString;
    apis: z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        version: z.ZodNumber;
    }, z.core.$strict>>;
    updatedAt: z.ZodISODateTime;
    updatedBy: z.ZodString;
    restoredFrom: z.ZodNullable<z.ZodNumber>;
    git: z.ZodOptional<z.ZodObject<{
        status: z.ZodEnum<{
            complete: "complete";
            disabled: "disabled";
            failed: "failed";
            retryable: "retryable";
        }>;
        message: z.ZodOptional<z.ZodString>;
        id: z.ZodOptional<z.ZodString>;
        repository: z.ZodOptional<z.ZodString>;
        baseBranch: z.ZodOptional<z.ZodString>;
        branch: z.ZodOptional<z.ZodString>;
        pageId: z.ZodOptional<z.ZodString>;
        version: z.ZodOptional<z.ZodNumber>;
        sourceHash: z.ZodOptional<z.ZodString>;
        commitSha: z.ZodOptional<z.ZodString>;
        pullNumber: z.ZodOptional<z.ZodNumber>;
        pullUrl: z.ZodOptional<z.ZodString>;
        pullState: z.ZodOptional<z.ZodEnum<{
            open: "open";
            closed: "closed";
        }>>;
        merged: z.ZodOptional<z.ZodBoolean>;
        verifiedAt: z.ZodOptional<z.ZodISODateTime>;
        createdAt: z.ZodOptional<z.ZodISODateTime>;
        updatedAt: z.ZodOptional<z.ZodISODateTime>;
    }, z.core.$strict>>;
}, z.core.$strict>]>;
export const ReactSaveRequestSchema: z.ZodObject<{
    expectedVersion: z.ZodNumber;
    source: z.ZodUnion<readonly [z.ZodObject<{
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
    apis: z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        version: z.ZodNumber;
    }, z.core.$strict>>;
}, z.core.$strict>;
export const ReactRestoreRequestSchema: z.ZodObject<{
    expectedVersion: z.ZodNumber;
    version: z.ZodNumber;
}, z.core.$strict>;
export const ReactPreviewRequestSchema: z.ZodObject<{
    source: z.ZodUnion<readonly [z.ZodObject<{
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
    apis: z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        version: z.ZodNumber;
    }, z.core.$strict>>;
}, z.core.$strict>;
import * as z from 'zod/v4';
