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
