// Plain text of a Google Docs body. A table block arrives as table.tableRows[].tableCells[].content[]
// (each cell holds the same kind of blocks as the body), so this walks it recursively.

export interface DocBlock {
  paragraph?: { elements?: Array<{ textRun?: { content?: string } }> };
  table?: { tableRows?: Array<{ tableCells?: Array<{ content?: DocBlock[] }> }> };
}

export function docBlocksToText(blocks: DocBlock[] | undefined): string {
  let text = '';
  for (const block of blocks ?? []) {
    if (block?.paragraph?.elements) {
      for (const element of block.paragraph.elements) {
        if (element?.textRun?.content) text += element.textRun.content;
      }
    }
    if (block?.table?.tableRows) {
      const rows = block.table.tableRows.map((row) =>
        (row.tableCells ?? []).map((cell) => docBlocksToText(cell.content).replace(/\n$/, '')).join('\t'));
      text += rows.join('\n') + '\n';
    }
  }
  return text;
}
