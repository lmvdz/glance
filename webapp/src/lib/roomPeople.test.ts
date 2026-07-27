import { describe, expect, it } from 'bun:test';
import { inviteConsequence, joinPolicyLine, outboundKeyLine, whatTheirWordDoes } from './roomPeople';

describe('whatTheirWordDoes', () => {
  it('describes consequences, not capabilities', () => {
    // "can remove members" is a checkbox; "can end someone's access" is what happens.
    expect(whatTheirWordDoes('owner')).toContain('end anyone’s access');
    expect(whatTheirWordDoes('member')).toContain('bind the whole fleet');
  });

  it('admits it has no sentence for a role it does not know', () => {
    const line = whatTheirWordDoes('auditor');
    expect(line).toContain('unknown from here');
    expect(line).toContain('worth resolving before relying on it');
  });
});

describe('joinPolicyLine', () => {
  it('says what auto-join actually means for the fleet', () => {
    expect(joinPolicyLine('auto', 0)).toContain('bind the fleet from that moment');
  });

  it('counts who is waiting rather than implying nobody is', () => {
    expect(joinPolicyLine('approval', 3)).toContain('3 are waiting now');
    expect(joinPolicyLine('approval', 0)).toContain('Nobody is waiting');
  });

  it('refuses to read an unset policy as closed', () => {
    const line = joinPolicyLine(null, 0);
    expect(line).toContain('not "closed"');
    expect(line).toContain('nobody here has decided it');
  });
});

describe('inviteConsequence', () => {
  it('says what the invited person will be able to do before it is sent', () => {
    expect(inviteConsequence('admin')).toContain('speak to the fleet immediately');
    expect(inviteConsequence('admin')).toContain('bring people in');
  });
});

describe('outboundKeyLine', () => {
  it('keeps a switched-off key apart from no key', () => {
    expect(outboundKeyLine(null)).toContain('nothing here can reach that service');
    const off = outboundKeyLine({ configured: true, enabled: false, last4: 'ab12' });
    expect(off).toContain('different from having no key');
    expect(off).toContain('ab12');
  });

  it('names who put a live key there', () => {
    expect(outboundKeyLine({ configured: true, enabled: true, updatedBy: 'db:mara' })).toContain('mara is who put it there');
  });
});
