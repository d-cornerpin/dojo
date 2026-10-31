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
});
