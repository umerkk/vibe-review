import * as fs from 'node:fs';
import * as path from 'node:path';
import TurndownService from 'turndown';
import * as vscode from 'vscode';
import { extForMime, isImagePath, saveAttachment } from '../shared/attachments';

const IMAGE_KIND = vscode.DocumentDropOrPasteEditKind.Empty.append('markdown', 'vibeReview', 'image');
const HTML_KIND = vscode.DocumentDropOrPasteEditKind.Empty.append('markdown', 'vibeReview', 'html');
/** VS Code puts this on the clipboard when copying from an editor; that HTML is just syntax highlighting. */
const VSCODE_EDITOR_MIME = 'vscode-editor-data';

/**
 * Comment boxes are in-memory Markdown documents with the `comment` scheme. New-comment boxes
 * carry the controller ID as authority. Boxes for editing an existing comment have none, so we
 * accept those too (they only exist for comments VS Code is editing on our behalf).
 */
function isOurCommentBox(doc: vscode.TextDocument): boolean {
  return doc.uri.scheme === 'comment' && (doc.uri.authority === 'vibe-review' || doc.uri.authority === '');
}

function imageMarkdown(rel: string, name: string): string {
  return `![${name.replace(/[[\]]/g, '')}](${rel})`;
}

/**
 * Copied/dragged image files win over raw image data: Finder also puts the file's icon on the
 * clipboard as an image, which we don't want to attach.
 */
async function collectImages(root: string, data: vscode.DataTransfer): Promise<string[]> {
  const fromFiles = await imagesFromUris(root, data);
  return fromFiles.length ? fromFiles : imagesFromData(root, data);
}

/** Pasted image data (e.g. a screenshot) → saved attachments. */
async function imagesFromData(root: string, data: vscode.DataTransfer): Promise<string[]> {
  const out: string[] = [];
  for (const [mime, item] of data) {
    const ext = extForMime(mime);
    const file = ext ? item.asFile() : undefined;
    if (!ext || !file) continue;
    out.push(imageMarkdown(saveAttachment(root, await file.data(), ext), file.name ? path.parse(file.name).name : 'screenshot'));
  }
  return out;
}

/** Image files copied in Finder/Explorer or dragged in → copied into attachments. */
async function imagesFromUris(root: string, data: vscode.DataTransfer): Promise<string[]> {
  const list = await data.get('text/uri-list')?.asString();
  if (!list) return [];
  const out: string[] = [];
  for (const line of list.split(/\r?\n/)) {
    if (!line.trim() || line.startsWith('#')) continue;
    let uri: vscode.Uri;
    try {
      uri = vscode.Uri.parse(line.trim(), true);
    } catch {
      continue;
    }
    if (uri.scheme !== 'file' || !isImagePath(uri.fsPath)) continue;
    try {
      const bytes = fs.readFileSync(uri.fsPath);
      out.push(imageMarkdown(saveAttachment(root, bytes, path.extname(uri.fsPath).slice(1).toLowerCase()), path.parse(uri.fsPath).name));
    } catch {
      // Unreadable file: let VS Code's default paste handle it.
    }
  }
  return out;
}

let turndown: TurndownService | undefined;
function htmlToMarkdown(html: string): string {
  turndown ??= new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced', bulletListMarker: '-' });
  return turndown.turndown(html).trim();
}

export function registerPasteSupport(root: string, ensureStore: () => void): vscode.Disposable {
  const selector: vscode.DocumentSelector = { scheme: 'comment' };

  const pasteProvider: vscode.DocumentPasteEditProvider = {
    async provideDocumentPasteEdits(document, _ranges, data, _context, token) {
      if (!isOurCommentBox(document)) return undefined;

      if ([...data].some(([mime]) => mime.startsWith('image/')) || data.get('text/uri-list')) {
        ensureStore();
        const images = await collectImages(root, data);
        if (token.isCancellationRequested) return undefined;
        if (images.length) {
          return [new vscode.DocumentPasteEdit(images.join('\n'), 'Insert image for the agent', IMAGE_KIND)];
        }
      }

      const html = await data.get('text/html')?.asString();
      if (!html || data.get(VSCODE_EDITOR_MIME)) return undefined;
      const plain = (await data.get('text/plain')?.asString())?.trim();
      const md = htmlToMarkdown(html);
      if (!md || md === plain) return undefined;
      return [new vscode.DocumentPasteEdit(md, 'Paste as Markdown (keep formatting)', HTML_KIND)];
    },
  };

  const dropProvider: vscode.DocumentDropEditProvider = {
    async provideDocumentDropEdits(document, _position, data, token) {
      if (!isOurCommentBox(document)) return undefined;
      ensureStore();
      const images = await collectImages(root, data);
      if (token.isCancellationRequested || !images.length) return undefined;
      return new vscode.DocumentDropEdit(images.join('\n'), 'Insert image for the agent', IMAGE_KIND);
    },
  };

  return vscode.Disposable.from(
    vscode.languages.registerDocumentPasteEditProvider(selector, pasteProvider, {
      providedPasteEditKinds: [IMAGE_KIND, HTML_KIND],
      pasteMimeTypes: ['image/*', 'text/uri-list', 'text/html'],
    }),
    vscode.languages.registerDocumentDropEditProvider(selector, dropProvider, {
      providedDropEditKinds: [IMAGE_KIND],
      dropMimeTypes: ['image/*', 'text/uri-list'],
    }),
  );
}
