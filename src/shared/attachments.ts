import * as fs from 'node:fs';
import * as path from 'node:path';
import { newId } from './store';

/** Pasted images live in `.vibe-review/attachments/` and are referenced from comment bodies by repo-relative path. */
export const ATTACHMENTS_REL = '.vibe-review/attachments';

const MIME_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
};

export function extForMime(mime: string): string | undefined {
  const sub = mime.toLowerCase().replace(/^image\//, '');
  if (sub === 'jpeg' || sub === 'jpg') return 'jpg';
  return MIME_BY_EXT[sub] ? sub : undefined;
}

export function isImagePath(p: string): boolean {
  return path.extname(p).slice(1).toLowerCase() in MIME_BY_EXT;
}

/** Saves image bytes as an attachment and returns its repo-relative path. */
export function saveAttachment(root: string, data: Uint8Array, ext: string): string {
  const dir = path.join(root, ATTACHMENTS_REL);
  // The extension comes from a file name or MIME type: keep it to a plain token so it can't
  // add path segments.
  const safeExt = ext.replace(/[^A-Za-z0-9]/g, '').slice(0, 10) || 'bin';
  fs.mkdirSync(dir, { recursive: true });
  const rel = `${ATTACHMENTS_REL}/${newId('img')}.${safeExt}`;
  fs.writeFileSync(path.join(root, rel), data);
  return rel;
}

// `![alt](.vibe-review/attachments/x.png)`, optionally wrapped in <>.
// Alt text may itself contain brackets, so match lazily up to the attachments link.
const IMAGE_RE = /!\[((?:[^\]\n]|\](?!\())*)\]\(<?(\.vibe-review\/attachments\/[^)\s>]+)>?\)/g;

export interface Attachment {
  alt: string;
  rel: string;
  abs: string;
  mimeType: string;
}

function inside(dir: string, p: string): boolean {
  const rel = path.relative(dir, p);
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * Resolves an attachment reference, or returns undefined if it could point outside the
 * attachments folder: lexically (`../`), or through a symlink in the folder or the file itself.
 */
export function resolveAttachment(root: string, rel: string): string | undefined {
  if (rel.includes('\\') || rel.includes('%')) return undefined;
  const dir = path.join(root, ATTACHMENTS_REL);
  const abs = path.join(root, rel);
  if (!inside(dir, abs)) return undefined;
  try {
    if (!inside(fs.realpathSync(dir), fs.realpathSync(abs))) return undefined;
  } catch {
    // Doesn't exist (yet); the lexical check above is all that applies.
  }
  return abs;
}

export function findAttachments(root: string, body: string): Attachment[] {
  const out: Attachment[] = [];
  for (const m of body.matchAll(IMAGE_RE)) {
    const abs = resolveAttachment(root, m[2]);
    if (!abs || out.some((a) => a.abs === abs)) continue;
    out.push({ alt: m[1], rel: m[2], abs, mimeType: MIME_BY_EXT[path.extname(abs).slice(1).toLowerCase()] ?? 'image/png' });
  }
  return out;
}

/** Rewrites attachment references in a comment body; `to` receives the absolute path. */
export function rewriteAttachments(root: string, body: string, to: (abs: string, alt: string) => string): string {
  return body.replace(IMAGE_RE, (whole, alt: string, rel: string) => {
    const abs = resolveAttachment(root, rel);
    return abs ? to(abs, alt) : whole;
  });
}
