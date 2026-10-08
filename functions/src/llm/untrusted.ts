/**
 * Untrusted text for prompts (docs/SECURITY.md "Prompt injection"): CV text, notes and job
 * postings are wrapped in a tag the system prompt names as data, and any copy of that tag inside
 * the text is defused, so the text can't close its own tag and pose as instructions.
 */
export type UntrustedTag = 'cv_text' | 'note' | 'job_posting' | 'email' | 'paste';

export function wrapUntrusted(tag: UntrustedTag, text: string): string {
  const escaped = text.replace(new RegExp(`</?${tag}\\s*>`, 'gi'), (match) =>
    match.replace('<', '&lt;'),
  );
  return `<${tag}>\n${escaped}\n</${tag}>`;
}
