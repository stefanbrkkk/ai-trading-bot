import { describe, expect, it } from 'vitest';
import { validateSql } from '@/lib/investgpt/validate';

describe('generated SQL cannot evade forbidden-function checks with quoting', () => {
  it.each(['"randomblob"', '`randomblob`', '[zeroblob]', '"load_extension"', '`readfile`', '[writefile]'])(
    'rejects SQLite quoted function syntax %s',
    (name) => {
      const result = validateSql(`SELECT ${name}(1000) FROM v_equity_snapshot LIMIT 1`);
      expect(result.valid).toBe(false);
      expect(result.issues.some((issue) => issue.code === 'FORBIDDEN_FUNCTION')).toBe(true);
    },
  );

  it('keeps harmless quoted columns and ordinary aggregate functions working', () => {
    expect(validateSql('SELECT "symbol", count(*) FROM v_equity_snapshot GROUP BY "symbol" LIMIT 10').valid).toBe(true);
  });
});
