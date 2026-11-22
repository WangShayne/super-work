export async function* readLinesFromStream(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newlineIdx = buffer.indexOf("\n");
      while (newlineIdx !== -1) {
        const line = buffer.slice(0, newlineIdx).trim();
        buffer = buffer.slice(newlineIdx + 1);
        if (line) yield line;
        newlineIdx = buffer.indexOf("\n");
      }
    }
    buffer += decoder.decode();
    const trailing = buffer.trim();
    if (trailing) yield trailing;
  } finally {
    reader.releaseLock();
  }
}

export function truncateText(input: string, maxLen = 400): string {
  const cleaned = input.trim();
  if (cleaned.length <= maxLen) return cleaned;
  return `${cleaned.slice(0, maxLen - 3)}...`;
}
