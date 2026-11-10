// DeepSeek Chat Completions documents 384K as 384 * 1024 tokens.
export const maxOutputTokens = 393216;
export const modelContextTokens = 1000000;
// Local resource bounds include text, JSON escaping and SSE framing overhead;
// character/byte limits are not token counts.
export const maxOutputCharacters = 4 * 1024 * 1024;
export const maxToolArgumentCharacters = 8 * 1024 * 1024;
export const maxModelStreamBytes = 256 * 1024 * 1024;
export const maxTaskBytes = 64 * 1024 * 1024;
export const maxArtifactBytes = 32 * 1024 * 1024;
// DeepSeek Chat Completions accepts one inline image up to 32 MiB.
export const maxInlineImageBytes = 32 * 1024 * 1024;
export const maxImageArtifactBytes = Math.ceil(maxInlineImageBytes / 3) * 4 + 1024;
export const modelIdleTimeoutMs = 120000;
