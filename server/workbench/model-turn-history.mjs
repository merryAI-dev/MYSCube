const completionContents = new WeakMap();
const messageContents = new WeakMap();
const freeze = (value) => {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
};

export function attachCompletionContent(response, content) {
  const snapshot = freeze(structuredClone(content));
  if (snapshot?.role !== 'model' || !Array.isArray(snapshot.parts)
    || snapshot.parts.some((part) => !part || typeof part !== 'object' || Array.isArray(part))
    || snapshot.parts.filter((part) => part.functionCall).length !== 1) throw new Error('Invalid model completion content.');
  completionContents.set(response, snapshot);
  return response;
}

export function getNativeMessageContent(message) {
  return messageContents.get(message);
}

export function appendToolResult(messages, response, { step, result, label }) {
  const assistant = { role: 'assistant', content: JSON.stringify(step) };
  const user = { role: 'user', content: `${label}:${JSON.stringify(result)}` };
  const native = completionContents.get(response);
  if (native) {
    const call = native.parts.find((part) => part.functionCall).functionCall;
    messageContents.set(assistant, native);
    messageContents.set(user, freeze(structuredClone({ role: 'user', parts: [{ functionResponse: {
      name: call.name, ...(call.id !== undefined ? { id: call.id } : {}), response: { result },
    } }] })));
  }
  messages.push(assistant, user);
}
