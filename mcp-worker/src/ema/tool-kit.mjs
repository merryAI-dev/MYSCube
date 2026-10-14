// EMA MCP 도구 공통 도우미. 도구 파일들이 서로를 import 하지 않도록 따로 둔다.
export const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
export const WRITES = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false };

export function ok(data) {
  return { content: [{ type: 'text', text: JSON.stringify(data) }] };
}

export function fail(error, fallback) {
  return { content: [{ type: 'text', text: error instanceof Error && error.message ? error.message : fallback }], isError: true };
}

export function tool(server, name, { title, description, input = {}, annotations = READ_ONLY }, run) {
  server.registerTool(name, { title, description, inputSchema: input, annotations }, async (args) => {
    try { return ok(await run(args)); }
    catch (error) { return fail(error, `${title}에 실패했습니다.`); }
  });
}
