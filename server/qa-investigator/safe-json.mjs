export function cleanInvestigationJson(value, limit = 262144) {
  const text = JSON.stringify(value, (key, item) => {
    if (["__proto__", "constructor", "prototype"].includes(key))
      return undefined;
    if (
      /^(authorization|cookie|set-cookie|access_?token|refresh_?token|api_?key|password|secret|private_?key)$/i.test(
        key,
      )
    )
      return "[REDACTED]";
    if (typeof item === "string")
      return item.replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]");
    return item;
  });
  if (!text || Buffer.byteLength(text) > limit)
    throw Object.assign(Error("investigation_json_invalid"), { code: "investigation_json_invalid" });
  return JSON.parse(text);
}
