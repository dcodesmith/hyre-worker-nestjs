// Intercept stdout/stderr BEFORE any imports to suppress NestJS logs
const originalStdoutWrite = process.stdout.write.bind(process.stdout);
const originalStderrWrite = process.stderr.write.bind(process.stderr);

const shouldSuppress = (message: string): boolean => {
  // Match [Nest] - strip ANSI codes first for reliable matching
  // Use ESC character code (27) to avoid linter warnings about control chars
  const ansiPattern = new RegExp(String.raw`${String.fromCodePoint(27)}\[[0-9;]*m`, "g");
  const stripped = message.replaceAll(ansiPattern, "");
  return stripped.includes("[Nest]");
};

const createWriteInterceptor =
  (originalWrite: typeof process.stdout.write) =>
  (
    chunk: string | Uint8Array,
    encodingOrCb?: BufferEncoding | ((error?: Error | null) => void),
    cb?: (error?: Error | null) => void,
  ): boolean => {
    const message = typeof chunk === "string" ? chunk : chunk.toString();
    if (shouldSuppress(message)) {
      if (typeof cb === "function") cb();
      else if (typeof encodingOrCb === "function") encodingOrCb();
      return true;
    }
    return originalWrite(chunk, encodingOrCb as BufferEncoding, cb);
  };

process.stdout.write = createWriteInterceptor(originalStdoutWrite);
process.stderr.write = createWriteInterceptor(originalStderrWrite);

import "reflect-metadata";
