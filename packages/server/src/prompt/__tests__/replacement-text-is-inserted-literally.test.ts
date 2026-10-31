import { describe, it, expect } from 'vitest';
import { composeUserProfile } from '../user-profile.js';
import { composePrimarySoul } from '../oobe-soul.js';

describe('owner-typed text is inserted literally', () => {
  it('a role containing $$ keeps both dollar signs', () => {
    expect(composeUserProfile({ userName: 'Pat', userRole: 'Sells $$ widgets' })).toContain('Sells $$ widgets');
  });
  it('a name containing $& is not replaced by the matched text', () => {
    expect(composeUserProfile({ userName: 'A$&B' })).toContain('- Name: A$&B');
  });
  it('an owner rule containing $$ keeps both dollar signs', () => {
    expect(composePrimarySoul({ rules: 'Quote prices in $$' })).toContain('Quote prices in $$');
  });
  it('every special pattern survives in name, role and rule together', () => {
    const tricky = ["$$", "$&", "$`", "$'"];
    for (const t of tricky) {
      const md = composeUserProfile({ userName: `N${t}n`, userRole: `R${t}r` });
      expect(md).toContain(`- Name: N${t}n`);
      expect(md).toContain(`- Role: R${t}r`);
      expect(composePrimarySoul({ rules: `Rule ${t} end` })).toContain(`Rule ${t} end`);
    }
  });
});
