// Withhold secret prefixes across provider chunks; per-chunk replaceAll alone
// would expose an API key split between two chunks.
export function streamTextFilter(secret: string) {
  let pending = '';
  return (chunk: string) => {
    if (!secret) return chunk;
    pending += chunk;
    let output = '', index = 0;
    while (index < pending.length) {
      if (pending.startsWith(secret,index)) { output += '[REDACTED]'; index += secret.length; }
      else if (secret.startsWith(pending.slice(index))) break;
      else output += pending[index++];
    }
    pending = pending.slice(index);
    return output;
  };
}

export function joinModelText(prefix: string, next: string) {
  if (!prefix || !next) return prefix + next;
  if (next.startsWith(prefix)) return next;
  const tail = prefix.slice(-4096);
  for (let length = Math.min(tail.length, next.length); length >= 12; length--) {
    if (tail.endsWith(next.slice(0, length))) return prefix + next.slice(length);
  }
  return prefix + next;
}
