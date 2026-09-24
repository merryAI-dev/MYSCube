export function isRemoteDomStyleValue(property: any, value: any): any;
export const REMOTE_DOM_LIMITS: Readonly<{
    nodes: 1500;
    depth: 40;
    textBytes: 120000;
    snapshotBytes: 480000;
    stylesPerNode: 90;
    attributesPerNode: 24;
    inputLength: 2000;
    eventBytes: 16000;
    replayFrames: 16;
    layoutArea: 16000000;
}>;
export const REMOTE_DOM_TAGS: readonly string[];
export const REMOTE_DOM_ATTRIBUTE_NAMES: readonly string[];
export const REMOTE_DOM_REFERENCE_ATTRIBUTES: readonly string[];
export const REMOTE_DOM_STYLE_PROPERTIES: readonly string[];
export const REMOTE_DOM_UNSUPPORTED_STYLE_DEFAULTS: Readonly<{
    'background-image': "none";
    filter: "none";
    'backdrop-filter': "none";
    transform: "none";
    translate: "none";
    rotate: "none";
    scale: "none";
    'clip-path': "none";
    clip: "auto";
    'animation-name': "none";
    'mask-image': "none";
    'offset-path': "none";
    'content-visibility': "visible";
    '-webkit-text-security': "none";
    'mix-blend-mode': "normal";
    perspective: "none";
    'writing-mode': "horizontal-tb";
    float: "none";
    zoom: "1";
}>;
export const REMOTE_DOM_UNSUPPORTED_STYLES: readonly string[];
export const RemoteDomControlSchema: z.ZodObject<{
    type: z.ZodEnum<{
        number: "number";
        email: "email";
        url: "url";
        textarea: "textarea";
        select: "select";
        text: "text";
        search: "search";
        tel: "tel";
        checkbox: "checkbox";
        radio: "radio";
    }>;
    value: z.ZodString;
    checked: z.ZodBoolean;
    selectedValues: z.ZodArray<z.ZodString>;
    disabled: z.ZodBoolean;
    readOnly: z.ZodBoolean;
    selectionStart: z.ZodNullable<z.ZodNumber>;
    selectionEnd: z.ZodNullable<z.ZodNumber>;
}, z.core.$strict>;
export const RemoteDomNodeSchema: z.ZodDiscriminatedUnion<[z.ZodObject<{
    id: z.ZodString;
    parentId: z.ZodNullable<z.ZodString>;
    kind: z.ZodLiteral<"text">;
    text: z.ZodString;
}, z.core.$strict>, z.ZodObject<{
    id: z.ZodString;
    parentId: z.ZodNullable<z.ZodString>;
    kind: z.ZodLiteral<"element">;
    tag: z.ZodEnum<{
        [x: string]: string;
    }>;
    attributes: z.ZodRecord<z.ZodString, z.ZodString>;
    style: z.ZodRecord<z.ZodString, z.ZodString>;
    control: z.ZodOptional<z.ZodObject<{
        type: z.ZodEnum<{
            number: "number";
            email: "email";
            url: "url";
            textarea: "textarea";
            select: "select";
            text: "text";
            search: "search";
            tel: "tel";
            checkbox: "checkbox";
            radio: "radio";
        }>;
        value: z.ZodString;
        checked: z.ZodBoolean;
        selectedValues: z.ZodArray<z.ZodString>;
        disabled: z.ZodBoolean;
        readOnly: z.ZodBoolean;
        selectionStart: z.ZodNullable<z.ZodNumber>;
        selectionEnd: z.ZodNullable<z.ZodNumber>;
    }, z.core.$strict>>;
}, z.core.$strict>], "kind">;
export const RemoteDomSnapshotSchema: z.ZodObject<{
    schemaVersion: z.ZodLiteral<1>;
    revision: z.ZodNumber;
    rootNodeId: z.ZodString;
    nodes: z.ZodArray<z.ZodDiscriminatedUnion<[z.ZodObject<{
        id: z.ZodString;
        parentId: z.ZodNullable<z.ZodString>;
        kind: z.ZodLiteral<"text">;
        text: z.ZodString;
    }, z.core.$strict>, z.ZodObject<{
        id: z.ZodString;
        parentId: z.ZodNullable<z.ZodString>;
        kind: z.ZodLiteral<"element">;
        tag: z.ZodEnum<{
            [x: string]: string;
        }>;
        attributes: z.ZodRecord<z.ZodString, z.ZodString>;
        style: z.ZodRecord<z.ZodString, z.ZodString>;
        control: z.ZodOptional<z.ZodObject<{
            type: z.ZodEnum<{
                number: "number";
                email: "email";
                url: "url";
                textarea: "textarea";
                select: "select";
                text: "text";
                search: "search";
                tel: "tel";
                checkbox: "checkbox";
                radio: "radio";
            }>;
            value: z.ZodString;
            checked: z.ZodBoolean;
            selectedValues: z.ZodArray<z.ZodString>;
            disabled: z.ZodBoolean;
            readOnly: z.ZodBoolean;
            selectionStart: z.ZodNullable<z.ZodNumber>;
            selectionEnd: z.ZodNullable<z.ZodNumber>;
        }, z.core.$strict>>;
    }, z.core.$strict>], "kind">>;
    focusedNodeId: z.ZodNullable<z.ZodString>;
    ack: z.ZodNullable<z.ZodObject<{
        eventId: z.ZodString;
        inputRevision: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strict>>;
}, z.core.$strict>;
export const RemoteDomFrameSchema: z.ZodObject<{
    sequence: z.ZodNumber;
    width: z.ZodNumber;
    height: z.ZodNumber;
    snapshot: z.ZodObject<{
        schemaVersion: z.ZodLiteral<1>;
        revision: z.ZodNumber;
        rootNodeId: z.ZodString;
        nodes: z.ZodArray<z.ZodDiscriminatedUnion<[z.ZodObject<{
            id: z.ZodString;
            parentId: z.ZodNullable<z.ZodString>;
            kind: z.ZodLiteral<"text">;
            text: z.ZodString;
        }, z.core.$strict>, z.ZodObject<{
            id: z.ZodString;
            parentId: z.ZodNullable<z.ZodString>;
            kind: z.ZodLiteral<"element">;
            tag: z.ZodEnum<{
                [x: string]: string;
            }>;
            attributes: z.ZodRecord<z.ZodString, z.ZodString>;
            style: z.ZodRecord<z.ZodString, z.ZodString>;
            control: z.ZodOptional<z.ZodObject<{
                type: z.ZodEnum<{
                    number: "number";
                    email: "email";
                    url: "url";
                    textarea: "textarea";
                    select: "select";
                    text: "text";
                    search: "search";
                    tel: "tel";
                    checkbox: "checkbox";
                    radio: "radio";
                }>;
                value: z.ZodString;
                checked: z.ZodBoolean;
                selectedValues: z.ZodArray<z.ZodString>;
                disabled: z.ZodBoolean;
                readOnly: z.ZodBoolean;
                selectionStart: z.ZodNullable<z.ZodNumber>;
                selectionEnd: z.ZodNullable<z.ZodNumber>;
            }, z.core.$strict>>;
        }, z.core.$strict>], "kind">>;
        focusedNodeId: z.ZodNullable<z.ZodString>;
        ack: z.ZodNullable<z.ZodObject<{
            eventId: z.ZodString;
            inputRevision: z.ZodOptional<z.ZodNumber>;
        }, z.core.$strict>>;
    }, z.core.$strict>;
    sessionId: z.ZodString;
    sourceHash: z.ZodString;
    documentEpoch: z.ZodString;
    kind: z.ZodLiteral<"dom">;
}, z.core.$strict>;
export const RemoteDomEventSchema: z.ZodDiscriminatedUnion<[z.ZodObject<{
    type: z.ZodLiteral<"focus">;
    eventId: z.ZodString;
    nodeId: z.ZodString;
    baseRevision: z.ZodNumber;
    sessionId: z.ZodString;
    sourceHash: z.ZodString;
    documentEpoch: z.ZodString;
}, z.core.$strict>, z.ZodObject<{
    type: z.ZodLiteral<"click">;
    eventId: z.ZodString;
    nodeId: z.ZodString;
    baseRevision: z.ZodNumber;
    sessionId: z.ZodString;
    sourceHash: z.ZodString;
    documentEpoch: z.ZodString;
}, z.core.$strict>, z.ZodObject<{
    type: z.ZodLiteral<"input">;
    value: z.ZodString;
    inputType: z.ZodEnum<{
        insertText: "insertText";
        insertFromPaste: "insertFromPaste";
        deleteContentBackward: "deleteContentBackward";
        deleteContentForward: "deleteContentForward";
        deleteByCut: "deleteByCut";
        insertLineBreak: "insertLineBreak";
        historyUndo: "historyUndo";
        historyRedo: "historyRedo";
        insertReplacementText: "insertReplacementText";
    }>;
    data: z.ZodNullable<z.ZodString>;
    selectionStart: z.ZodNullable<z.ZodNumber>;
    selectionEnd: z.ZodNullable<z.ZodNumber>;
    inputRevision: z.ZodNumber;
    eventId: z.ZodString;
    nodeId: z.ZodString;
    baseRevision: z.ZodNumber;
    sessionId: z.ZodString;
    sourceHash: z.ZodString;
    documentEpoch: z.ZodString;
}, z.core.$strict>, z.ZodObject<{
    type: z.ZodLiteral<"check">;
    checked: z.ZodBoolean;
    inputRevision: z.ZodNumber;
    eventId: z.ZodString;
    nodeId: z.ZodString;
    baseRevision: z.ZodNumber;
    sessionId: z.ZodString;
    sourceHash: z.ZodString;
    documentEpoch: z.ZodString;
}, z.core.$strict>, z.ZodObject<{
    type: z.ZodLiteral<"select">;
    values: z.ZodArray<z.ZodString>;
    inputRevision: z.ZodNumber;
    eventId: z.ZodString;
    nodeId: z.ZodString;
    baseRevision: z.ZodNumber;
    sessionId: z.ZodString;
    sourceHash: z.ZodString;
    documentEpoch: z.ZodString;
}, z.core.$strict>, z.ZodObject<{
    type: z.ZodLiteral<"composition">;
    phase: z.ZodEnum<{
        start: "start";
        end: "end";
        update: "update";
        cancel: "cancel";
    }>;
    text: z.ZodString;
    selectionStart: z.ZodNumber;
    selectionEnd: z.ZodNumber;
    inputRevision: z.ZodNumber;
    eventId: z.ZodString;
    nodeId: z.ZodString;
    baseRevision: z.ZodNumber;
    sessionId: z.ZodString;
    sourceHash: z.ZodString;
    documentEpoch: z.ZodString;
}, z.core.$strict>, z.ZodObject<{
    type: z.ZodLiteral<"key">;
    key: z.ZodEnum<{
        Enter: "Enter";
        Escape: "Escape";
        Backspace: "Backspace";
        Delete: "Delete";
        ArrowUp: "ArrowUp";
        ArrowDown: "ArrowDown";
        ArrowLeft: "ArrowLeft";
        ArrowRight: "ArrowRight";
        Home: "Home";
        End: "End";
        PageUp: "PageUp";
        PageDown: "PageDown";
    }>;
    eventId: z.ZodString;
    nodeId: z.ZodString;
    baseRevision: z.ZodNumber;
    sessionId: z.ZodString;
    sourceHash: z.ZodString;
    documentEpoch: z.ZodString;
}, z.core.$strict>, z.ZodObject<{
    type: z.ZodLiteral<"submit">;
    submitterNodeId: z.ZodNullable<z.ZodString>;
    eventId: z.ZodString;
    nodeId: z.ZodString;
    baseRevision: z.ZodNumber;
    sessionId: z.ZodString;
    sourceHash: z.ZodString;
    documentEpoch: z.ZodString;
}, z.core.$strict>, z.ZodObject<{
    type: z.ZodLiteral<"scroll">;
    top: z.ZodNumber;
    left: z.ZodNumber;
    eventId: z.ZodString;
    nodeId: z.ZodString;
    baseRevision: z.ZodNumber;
    sessionId: z.ZodString;
    sourceHash: z.ZodString;
    documentEpoch: z.ZodString;
}, z.core.$strict>], "type">;
export const RemoteDomUnsupportedSchema: z.ZodArray<z.ZodObject<{
    code: z.ZodString;
    message: z.ZodString;
    nodeId: z.ZodOptional<z.ZodString>;
}, z.core.$strict>>;
import * as z from 'zod/v4';
