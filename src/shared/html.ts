import TurndownService from 'turndown';

let turndown: TurndownService | undefined;

/** Rich text (e.g. copied from a browser or docs) → Markdown for a review comment. */
export function htmlToMarkdown(html: string): string {
  turndown ??= new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced', bulletListMarker: '-' });
  return turndown.turndown(html).trim();
}
