import { StreamableFile } from '@nestjs/common';
import { Readable } from 'node:stream';

// Rows per keyset chunk for streaming CSV exports. Each chunk is its own short
// RLS-scoped query so memory stays bounded and no transaction is held open
// across the whole (potentially large) download.
export const CSV_EXPORT_CHUNK = 1000;

// UTF-8 byte-order mark. Prefix every CSV with it so Excel (which otherwise
// decodes with the OS ANSI code page, e.g. Windows-1252) reads the file as UTF-8
// — without it a "•" in an invoice shows up as "â€¢". Modern CSV parsers strip it.
export const UTF8_BOM = '\uFEFF';

/**
 * RFC-4180 quote a single cell AND neutralize spreadsheet formula injection:
 * Excel/Sheets execute a cell that begins with = + - @ (or a leading tab/CR).
 * Many exported columns (references, customer/recipient names, notes) come
 * verbatim from untrusted source-provider / company payloads, so prefix any such
 * value with a single quote before quoting. System-controlled columns are
 * unaffected by the prefix (they never start with those characters).
 */
export function csvCell(value: string | number | null | undefined): string {
  const s = value == null ? '' : String(value);
  // `=`/`@`/tab/CR starts are always escaped. `+`/`-` starts are escaped only
  // when the remainder could actually form a formula (contains letters/symbols,
  // e.g. the DDE payload `+cmd|' /C calc'!A0`): a purely numeric/phone-shaped
  // cell like `+96176851162` or `-12.50` cannot execute anything, and the guard
  // quote would otherwise surface as literal data — a stray leading `'` on
  // every exported phone number.
  const needsPrefix = /^[=@\t\r]/.test(s) || (/^[+-]/.test(s) && !/^[+-][\d\s().-]*$/.test(s));
  const v = needsPrefix ? `'${s}` : s;
  if (v.includes(',') || v.includes('"') || v.includes('\n')) {
    return `"${v.replace(/"/g, '""')}"`;
  }
  return v;
}

/** Keyset cursor for the shared streaming exporter — (createdAt desc, id desc). */
export type CsvKeysetCursor = { createdAt: Date; id: string };

/**
 * Stream an arbitrarily large result set as CSV, walked in keyset chunks over
 * (createdAt desc, id desc). Generic over the row type: callers supply how to
 * fetch the next chunk (given the previous cursor), how to derive the cursor
 * from a row, and how to project a row to ordered cells. Rows are emitted as
 * produced — memory is bounded to one chunk. New rows inserted mid-export land
 * at the top of the order we've already passed, so the walk never double-reads
 * or skips. Mirrors the original per-module streamers, centralised so every
 * list (transactions, ledger, withdrawals, payouts, loads, activity, audit,
 * logs) exports the same safe, consistent way.
 */
export function streamCsvKeyset<T>(opts: {
  filename: string;
  header: readonly string[];
  fetchPage: (cursor: CsvKeysetCursor | null, take: number) => Promise<T[]>;
  cursorOf: (row: T) => CsvKeysetCursor;
  toCells: (row: T) => ReadonlyArray<string | number | null | undefined>;
  chunk?: number;
}): StreamableFile {
  const chunk = opts.chunk ?? CSV_EXPORT_CHUNK;

  async function* generate(): AsyncGenerator<string> {
    // Lead with a UTF-8 BOM so Excel (which otherwise assumes the OS ANSI code
    // page, e.g. Windows-1252) decodes multi-byte characters correctly — without
    // it a "•" in an invoice renders as "â€¢". Modern CSV parsers strip the BOM.
    yield UTF8_BOM + opts.header.join(',') + '\n';
    let cursor: CsvKeysetCursor | null = null;
    for (;;) {
      const page = await opts.fetchPage(cursor, chunk);
      if (page.length === 0) break;
      let buf = '';
      for (const row of page) {
        buf += opts.toCells(row).map(csvCell).join(',') + '\n';
      }
      yield buf;
      if (page.length < chunk) break;
      cursor = opts.cursorOf(page[page.length - 1]!);
    }
  }

  return new StreamableFile(Readable.from(generate()), {
    type: 'text/csv; charset=utf-8',
    disposition: `attachment; filename="${opts.filename}"`,
  });
}
