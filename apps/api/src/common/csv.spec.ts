import { describe, expect, it } from 'vitest';
import { csvCell } from './csv';

describe('csvCell', () => {
  it('exports a pure signed number (phone, negative amount) verbatim', () => {
    // The exact client-reported corruption: every exported phone carried a
    // literal leading apostrophe.
    expect(csvCell('+96176851162')).toBe('+96176851162');
    expect(csvCell('-150.00')).toBe('-150.00');
    expect(csvCell('12.5')).toBe('12.5');
  });

  it('still escapes formula starts', () => {
    expect(csvCell('=1+2')).toBe("'=1+2");
    expect(csvCell('@SUM(A1)')).toBe("'@SUM(A1)");
    expect(csvCell("+cmd|' /C calc'!A0")).toBe("'+cmd|' /C calc'!A0");
  });

  it('escapes +/- cells that are not one pure number — Excel would EVALUATE them', () => {
    // `+961-70-000-000` renders as 891 in Excel if left bare; the quote
    // preserves the data (shown literally, but intact).
    expect(csvCell('+961-70-000-000')).toBe("'+961-70-000-000");
    expect(csvCell('-150.00 - 10')).toBe("'-150.00 - 10");
    expect(csvCell('+961 3 123456')).toBe("'+961 3 123456");
    expect(csvCell('+')).toBe("'+");
  });

  it('RFC-4180 quotes cells containing separators', () => {
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('line\nbreak')).toBe('"line\nbreak"');
  });

  it('passes ordinary text and empties through untouched', () => {
    expect(csvCell('John Doe')).toBe('John Doe');
    expect(csvCell('')).toBe('');
    expect(csvCell(null)).toBe('');
    expect(csvCell(undefined)).toBe('');
    expect(csvCell(42)).toBe('42');
  });
});
