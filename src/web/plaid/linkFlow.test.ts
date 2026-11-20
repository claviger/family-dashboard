import { describe, expect, it } from 'vitest';
import {
  afterSuccess, backLink, exitCall, LINK_FAILED_MESSAGE, LINK_MAYBE_FINISHED_MESSAGE, linkFailedMessage, linkStartAnswer, nextFrom, plainMetadata, purposeFromPage, startCall,
  successCall,
} from './linkFlow.js';

const ORIGIN = 'https://dashboard.example.com';

// Everything here is synthetic: the tokens, institutions, and accounts.
const META = {
  institution: { institution_id: 'ins_fake_bank', name: 'Example Bank' },
  accounts: [{ id: 'acct-1', name: 'Example Rewards', mask: '1111', type: 'credit', subtype: 'credit card', verification_status: null }],
  link_session_id: 'session-1',
  transfer_status: null,
};

describe('startCall', () => {
  it('asks for a new link token on the link page', () => {
    expect(startCall('/connect/plaid/link', '')).toEqual({ path: '/connect/plaid/link-token', body: {} });
  });

  it('asks for update mode with ?item=, and adds accounts only with &accounts=1', () => {
    expect(startCall('/connect/plaid/link', '?item=7')).toEqual({ path: '/connect/plaid/link-token', body: { itemId: 7 } });
    expect(startCall('/connect/plaid/link', '?item=7&accounts=1')).toEqual({ path: '/connect/plaid/link-token', body: { itemId: 7, addAccounts: true } });
    expect(startCall('/connect/plaid/link', '?item=7&accounts=0')).toEqual({ path: '/connect/plaid/link-token', body: { itemId: 7 } });
  });

  it('never turns a reconnect it can\'t read into a new link, which would use a Trial connection', () => {
    for (const item of ['', 'abc', '0', '-3', '1.5', '7x', ' 7', '99999999999999999999']) {
      expect(startCall('/connect/plaid/link', `?item=${encodeURIComponent(item)}`)).toBeNull();
    }
  });

  it('ignores &accounts=1 without a bank, since only a linked bank has accounts to add', () => {
    expect(startCall('/connect/plaid/link', '?accounts=1')).toEqual({ path: '/connect/plaid/link-token', body: {} });
  });

  it('resumes the same link on the OAuth return page, whatever the bank added to the URL', () => {
    expect(startCall('/connect/plaid/oauth-return', '?oauth_state_id=abc')).toEqual({ path: '/connect/plaid/resume', body: {} });
  });

  it('refuses any other path', () => {
    expect(startCall('/plaid-link.html', '')).toBeNull();
    expect(startCall('/connect/plaid/link/', '')).toBeNull();
  });
});

describe('linkStartAnswer', () => {
  it('reads the token, the script URL, and the mode', () => {
    const answer = { linkToken: 'link-sandbox-1', scriptUrl: 'https://cdn.plaid.test/link/v2/stable/link-initialize.js', mode: 'update' };
    expect(linkStartAnswer(answer)).toEqual({ ...answer, purpose: 'spend' });
  });

  it('refuses anything else', () => {
    for (const bad of [null, 'x', {}, { linkToken: '', scriptUrl: 'https://cdn.plaid.test/x.js', mode: 'new' },
      { linkToken: 't', scriptUrl: 'not a url', mode: 'new' }, { linkToken: 't', scriptUrl: 'javascript:alert(1)', mode: 'new' },
      { linkToken: 't', scriptUrl: 'https://cdn.plaid.test/x.js', mode: 'other' }]) {
      expect(linkStartAnswer(bad)).toBeNull();
    }
  });
});

describe('successCall', () => {
  it('exchanges the public token for a new bank', () => {
    expect(successCall('new', 'public-sandbox-1', META)).toEqual({
      path: '/connect/plaid/exchange',
      body: { publicToken: 'public-sandbox-1', metadata: plainMetadata(META) },
    });
  });

  it("only reports update mode's metadata, since there's nothing to exchange", () => {
    expect(successCall('update', 'public-sandbox-1', META)).toEqual({ path: '/connect/plaid/updated', body: { metadata: plainMetadata(META) } });
  });
});

describe('plainMetadata', () => {
  it("keeps only the fields the server reads, and nulls for Link's missing ones", () => {
    expect(plainMetadata(META)).toEqual({
      institution: { institution_id: 'ins_fake_bank', name: 'Example Bank' },
      accounts: [{ id: 'acct-1', name: 'Example Rewards', mask: '1111', type: 'credit', subtype: 'credit card' }],
      link_session_id: 'session-1',
    });
    expect(plainMetadata({ institution: null, accounts: [{ id: 'a', name: 'Card', type: 'credit' }] })).toEqual({
      institution: null,
      accounts: [{ id: 'a', name: 'Card', mask: null, type: 'credit', subtype: null }],
    });
  });

  it('passes on something unreadable as it is, for the server to refuse', () => {
    expect(plainMetadata(null)).toBeNull();
    expect(plainMetadata({ institution: null, accounts: 'nope' })).toEqual({ institution: null, accounts: 'nope' });
  });
});

describe('exitCall', () => {
  it("sends Link's error code, or null when the admin just closed it", () => {
    expect(exitCall({ error_type: 'RATE_LIMIT_EXCEEDED', error_code: 'TRIAL_CONNECTION_LIMIT' })).toEqual({
      path: '/connect/plaid/exit', body: { errorCode: 'TRIAL_CONNECTION_LIMIT' },
    });
    expect(exitCall(null)).toEqual({ path: '/connect/plaid/exit', body: { errorCode: null } });
    expect(exitCall({ error_code: 42 })).toEqual({ path: '/connect/plaid/exit', body: { errorCode: null } });
    expect(exitCall({ error_code: 'X'.repeat(101) })).toEqual({ path: '/connect/plaid/exit', body: { errorCode: null } });
  });
});

describe('afterSuccess', () => {
  it("follows the server's next, refusals included", () => {
    expect(afterSuccess({ status: 200, body: { next: '/spend?tab=settings&bank=3' } }, ORIGIN)).toEqual({ next: '/spend?tab=settings&bank=3' });
    expect(afterSuccess({ status: 409, body: { error: { details: { next: '/spend?tab=settings&bank_error=duplicate' } } } }, ORIGIN))
      .toEqual({ next: '/spend?tab=settings&bank_error=duplicate' });
    expect(afterSuccess({ status: 503, body: { error: { details: { next: '/spend?tab=settings&bank_error=busy' } } } }, ORIGIN))
      .toEqual({ next: '/spend?tab=settings&bank_error=busy' });
  });

  it("says the bank may already be connected when there's no answer, it isn't JSON, or it's a 5xx without a next", () => {
    const maybe = { message: LINK_MAYBE_FINISHED_MESSAGE };
    expect(LINK_MAYBE_FINISHED_MESSAGE).toBe('This may have finished. Check Spend settings before trying again.');
    expect(afterSuccess(null, ORIGIN)).toEqual(maybe);
    // nginx's 504 page, say.
    expect(afterSuccess({ status: 504, body: null }, ORIGIN)).toEqual(maybe);
    expect(afterSuccess({ status: 200, body: null }, ORIGIN)).toEqual(maybe);
    expect(afterSuccess({ status: 500, body: { error: { code: 'internal', message: 'Something went wrong.' } } }, ORIGIN)).toEqual(maybe);
    expect(afterSuccess({ status: 502, body: { next: 'https://example.com/' } }, ORIGIN)).toEqual(maybe);
    // A 2xx is the server saying it finished: one without a next it can follow may have (review C-M2).
    expect(afterSuccess({ status: 200, body: {} }, ORIGIN)).toEqual(maybe);
    expect(afterSuccess({ status: 200, body: { next: 'https://example.com/' } }, ORIGIN)).toEqual(maybe);
  });

  it("says Plaid finished but the dashboard couldn't save it for the app's refusal with nowhere to go, with the server's message (review C-M2)", () => {
    expect(afterSuccess({ status: 400, body: { error: { code: 'validation', message: 'Choose a bank account.' } } }, ORIGIN)).toEqual({
      message: "Plaid finished, but the dashboard couldn't save the connection: Choose a bank account.",
    });
    expect(afterSuccess({ status: 403, body: { error: { code: 'forbidden' } } }, ORIGIN)).toEqual({ message: "Plaid finished, but the dashboard couldn't save the connection." });
    // A message too long to be the app's own is left out.
    expect(afterSuccess({ status: 409, body: { error: { message: 'x'.repeat(301) } } }, ORIGIN)).toEqual({ message: "Plaid finished, but the dashboard couldn't save the connection." });
  });
});

describe('nextFrom', () => {
  it("reads a success's next and a refusal's details.next", () => {
    expect(nextFrom({ next: '/spend?tab=settings&bank=3' }, ORIGIN)).toBe('/spend?tab=settings&bank=3');
    expect(nextFrom({ error: { code: 'conflict', message: 'x', details: { next: '/spend?tab=settings&bank_error=duplicate' } } }, ORIGIN)).toBe('/spend?tab=settings&bank_error=duplicate');
    expect(nextFrom({ error: { code: 'unauthenticated', details: { next: '/' } } }, ORIGIN)).toBe('/');
  });

  it("goes back to settings when update mode's finish found the bank busy syncing (a 503)", () => {
    const busy = { error: { code: 'integration_unavailable', message: 'That bank is busy syncing. Try again in a minute.', details: { next: '/spend?tab=settings&bank_error=busy' } } };
    expect(nextFrom(busy, ORIGIN)).toBe('/spend?tab=settings&bank_error=busy');
  });

  it('only follows a path on this site, as the browser would resolve it', () => {
    for (const bad of [null, {}, { next: 3 }, { next: 'https://example.com/' }, { next: '//example.com/' }, { next: '/\\example.com' }, { next: 'spend' },
      { error: { details: { next: 'javascript:alert(1)' } } }, { error: { details: null } },
      // The URL parser drops tabs and newlines, so these are //example.com to a browser.
      { next: '/\t/example.com/' }, { next: '/\n/example.com/' }, { next: '\t//example.com/' },
      { next: `${ORIGIN}/spend` }]) {
      expect(nextFrom(bad, ORIGIN), JSON.stringify(bad)).toBeNull();
    }
  });
});

describe('a Savings link on the Link page', () => {
  it('asks for a Savings link token with ?for=savings, and never with ?item=', () => {
    expect(startCall('/connect/plaid/link', '?for=savings')).toEqual({ path: '/connect/plaid/link-token', body: { purpose: 'savings' } });
    expect(startCall('/connect/plaid/link', '?item=3&for=savings')).toEqual({ path: '/connect/plaid/link-token', body: { itemId: 3 } });
    expect(purposeFromPage('/connect/plaid/link', '?for=savings')).toBe('savings');
    expect(purposeFromPage('/connect/plaid/link', '')).toBeNull();
    expect(purposeFromPage('/connect/plaid/oauth-return', '?oauth_state_id=x')).toBeNull();
  });

  it("reads the purpose from the start's answer, Spend when it's missing", () => {
    expect(linkStartAnswer({ linkToken: 't', scriptUrl: 'https://cdn.plaid.com/x.js', mode: 'new', purpose: 'savings' })).toMatchObject({ purpose: 'savings' });
    expect(linkStartAnswer({ linkToken: 't', scriptUrl: 'https://cdn.plaid.com/x.js', mode: 'new' })).toMatchObject({ purpose: 'spend' });
    expect(linkStartAnswer({ linkToken: 't', scriptUrl: 'https://cdn.plaid.com/x.js', mode: 'new', purpose: 'other' })).toBeNull();
  });

  it('names the settings page each purpose goes back to', () => {
    expect(backLink('savings')).toEqual({ href: '/savings?tab=settings', text: 'Back to Savings settings' });
    expect(backLink('spend')).toEqual({ href: '/spend?tab=settings', text: 'Back to Spend settings' });
    expect(linkFailedMessage('savings')).toBe("Couldn't start connecting the account. Go back to Savings settings and try again.");
    expect(linkFailedMessage('spend')).toBe(LINK_FAILED_MESSAGE);
    expect(afterSuccess(null, 'http://x', 'savings')).toEqual({ message: 'This may have finished. Check Savings settings before trying again.' });
  });
});
