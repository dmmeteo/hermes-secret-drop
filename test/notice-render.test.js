// The renderer registry behind the one chat message.
//
// Rendering is the broker's job, not the caller's: the notice wording for every
// platform lives in this repo, so a platform Hermes cannot render richly still
// gets a notice from here rather than model prose.
//
// Three properties are load-bearing:
//
//   - `plain` exists, carries no markup of any kind, and puts the URL on a line
//     of its own, because that is the only shape that survives a platform whose
//     formatting we have not verified end to end.
//   - an *unknown* platform still throws. A silent fallback to `plain` would
//     make an unsupported platform something a caller discovers by not noticing,
//     and §7.3 requires the refusal to be loud.
//   - the two quiet states are byte-identical on every platform, which is what
//     lets the Hermes side treat them as constants instead of asking for them.
//   - every verified-platform state is a `> ` blockquote card on every line, and
//     `plain` is not. That prefix is the whole of the platform-native rendering:
//     Telegram converts it to a native MarkdownV2 blockquote and Discord renders
//     it as a blockquote client-side, so the four user-visible classes read as
//     distinct blocks rather than four similar-looking lines. The card has to
//     hold on the *terminal* states too, or the lifecycle edit would collapse a
//     card into loose prose. Whether the real adapters actually preserve it is a
//     cross-language property, asserted in
//     integrations/hermes-drop/tests/test_notice_adapter_seam.py.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { expiredNotice, receivedNotice, waitingNotice } from '../src/notice.js';

const handoffId = 'abcdefghijklmnopqrstuv';
const url = 'https://drop.example.test/#0123456789abcdefghij_-';
const expiresAt = 1_800_000_000_000;


describe('the notice renderer registry', () => {
  it('renders a `plain` waiting notice with no markup at all', () => {
    const notice = waitingNotice({ handoffId, url, expiresAt, platform: 'plain' });

    for (const markup of ['**', '](', '<a ', '<b>', '<code>', '<t:', '`']) {
      assert.ok(!notice.includes(markup), `plain carries no ${markup}`);
    }
    assert.ok(!/[<>]/.test(notice), 'and no angle brackets at all, so nothing can be an HTML tag');
  });

  it('puts the bare URL on a line of its own, so no unfurler has to be trusted', () => {
    const lines = waitingNotice({ handoffId, url, expiresAt, platform: 'plain' }).split('\n');
    assert.ok(
      lines.includes(url),
      `the url must be a whole line by itself; got ${JSON.stringify(lines)}`,
    );
    assert.equal(lines.filter((line) => line.includes(url)).length, 1, 'named exactly once');
  });

  it('renders one compact relative expiry line outside Discord', () => {
    const notice = waitingNotice({ handoffId, url, expiresAt, platform: 'plain' });
    assert.match(notice.split('\n').at(-1), /^Expires in \d+ min\.$/);
    assert.ok(!notice.includes('<t:'), 'no Discord relative stamp outside Discord');
  });

  it('keeps transport metadata out of the notice', () => {
    const notice = waitingNotice({ handoffId, url, expiresAt, platform: 'plain' });
    assert.ok(!notice.includes(`drop:${handoffId}`));
  });

  it('carries no capability-shaped token outside the link itself', () => {
    const notice = waitingNotice({ handoffId, url, expiresAt, platform: 'plain' });
    const rest = notice.split(url).join('').split(handoffId).join('');
    assert.ok(!/[A-Za-z0-9_-]{22}/.test(rest));
  });

  it('renders discord as a masked Markdown link with a relative stamp', () => {
    const discord = waitingNotice({ handoffId, url, expiresAt, platform: 'discord' });
    assert.equal(discord, waitingNotice({ handoffId, url, expiresAt }), 'discord is the default');
    assert.ok(discord.includes(`<t:${Math.floor(expiresAt / 1000)}:R>`));
    assert.match(discord, /\[[^\]]+\]\(https:\/\/drop\.example\.test\/#[^)]+\)/);
  });

  // Review H1. The `telegram` renderer used to emit `<b>` and `<a href>`, which
  // was correct for the superseded raw-Bot-API design. The delivered design posts
  // through `TelegramAdapter.send`, which runs `format_message` and posts with
  // `parse_mode=MARKDOWN_V2` — so HTML was escaped and *displayed*, putting the
  // whole capability URL in plain view. Markdown is the only shape that renders.
  //
  // This asserts the shape; the behaviour is asserted where it can be, against
  // the real adapter, in
  // integrations/hermes-drop/tests/test_notice_adapter_seam.py.
  it('renders telegram as Markdown, never HTML, so MarkdownV2 can carry it', () => {
    const telegram = waitingNotice({ handoffId, url, expiresAt, platform: 'telegram' });

    assert.match(
      telegram,
      /\[open the secure form\]\(https:\/\/drop\.example\.test\/#[^)]+\)/,
      'a masked Markdown link, so the capability is a link target and not text',
    );
    // Review H1's property, kept exact while the card marker is allowed through:
    // an HTML tag needs a `<`, so `<` is banned outright, and the only `>` that
    // may appear is the blockquote prefix that opens each line.
    assert.ok(!telegram.includes('<'), 'no `<` can open a literal tag');
    const uncarded = telegram.split('\n').map((line) => line.replace(/^> /, '')).join('\n');
    assert.ok(
      !/[<>]/.test(uncarded),
      `no angle bracket beyond the card prefix; got ${JSON.stringify(uncarded)}`,
    );
    assert.ok(telegram.includes('🔒 **Private input requested**'),
      'the lock and Markdown title survive until MarkdownV2 conversion');
    assert.match(telegram.split('\n').at(-1), /^> Expires in \d+ min\.$/);
    assert.ok(!telegram.includes('<t:'), 'and no Discord stamp, which would be literal here');
  });

  it('keeps a non-round expiry compact too', () => {
    const ragged = Date.UTC(2027, 0, 15, 8, 0, 0, 542);
    for (const platform of ['telegram', 'plain']) {
      const notice = waitingNotice({ handoffId, url, expiresAt: ragged, platform });
      // `plain` has no card, the verified platforms do — the expiry line is the
      // last one either way.
      const prefix = platform === 'plain' ? '' : '> ';
      assert.match(notice.split('\n').at(-1), new RegExp(`^${prefix}Expires in \\d+ min\\.$`));
      assert.ok(!notice.includes('.542'), `${platform}: milliseconds are not a deadline`);
    }
  });

  it('fails closed on a platform it does not render', () => {
    for (const platform of ['slack', 'matrix', 'whatsapp', 'PLAIN', 'Discord', '', 'plain ']) {
      assert.throws(
        () => waitingNotice({ handoffId, url, expiresAt, platform }),
        /unsupported notice platform/,
        `unknown platform ${JSON.stringify(platform)} must throw, never fall back`,
      );
    }
  });

  it('never lets a caller reach a renderer by prototype lookup', () => {
    for (const platform of ['toString', 'constructor', '__proto__', 'hasOwnProperty']) {
      assert.throws(
        () => waitingNotice({ handoffId, url, expiresAt, platform }),
        /unsupported notice platform/,
        `${platform} is not a renderer`,
      );
    }
  });

  it('renders the two quiet states byte-identically on every platform', () => {
    // They take no platform at all — that is the point. Asserting it here means
    // a future platform argument cannot quietly start varying them, because the
    // Hermes side treats both as constants (§S1: no `notice` control op).
    assert.equal(receivedNotice.length, 0, 'receivedNotice takes no arguments');
    assert.equal(expiredNotice.length, 0, 'expiredNotice takes no arguments');

    for (const platform of ['discord', 'telegram', 'plain']) {
      assert.equal(receivedNotice(platform), '> ✓ **Private input received**');
      assert.equal(expiredNotice(platform), '> ✕ **Private input link expired**');
    }
  });
});

// The native-rendering half of the packet, at the level this suite can reach:
// the *shape* the adapters are handed. That the real adapters preserve it is
// asserted against real `format_message` in the plugin suite.
describe('the notice states as platform-native cards', () => {
  const live = (platform) => waitingNotice({ handoffId, url, expiresAt, platform });

  it('renders every verified-platform state as a blockquote card on every line', () => {
    for (const platform of ['discord', 'telegram']) {
      for (const [state, notice] of [
        ['waiting', live(platform)],
        ['received', receivedNotice()],
        ['expired', expiredNotice()],
      ]) {
        const lines = notice.split('\n');
        assert.ok(lines.length > 0, `${platform}/${state} renders something`);
        for (const line of lines) {
          assert.ok(
            line.startsWith('> '),
            `${platform}/${state}: every line must carry the card prefix; got ${JSON.stringify(line)}`,
          );
        }
      }
    }
  });

  // A lone `>` would escape to a literal `\>` under MarkdownV2 *and* split the
  // card into two blockquotes, so the card is contiguous by construction.
  it('never emits a bare `>` separator inside a card', () => {
    for (const notice of [live('discord'), live('telegram'), receivedNotice(), expiredNotice()]) {
      for (const line of notice.split('\n')) {
        assert.notEqual(line.trimEnd(), '>', 'a bare `>` line breaks the card in two');
        assert.ok(line.trim().length > 1, 'and an empty card line is never emitted');
      }
    }
  });

  it('leaves `plain` uncarded, because nothing there renders a blockquote', () => {
    const notice = waitingNotice({ handoffId, url, expiresAt, platform: 'plain' });
    assert.ok(!notice.includes('>'), 'plain carries no blockquote marker at all');
    for (const line of notice.split('\n')) {
      assert.ok(!line.startsWith('> '), `plain must not be carded; got ${JSON.stringify(line)}`);
    }
  });

  // The acceptance criterion: the classes a user has to tell apart at a glance.
  // Outbound-ready is the fourth and lives in outbound-structured.test.js.
  it('makes the three inbound classes mutually distinguishable', () => {
    const states = {
      waiting: live('discord'),
      received: receivedNotice(),
      expired: expiredNotice(),
    };
    const seen = new Set(Object.values(states));
    assert.equal(seen.size, 3, 'no two inbound classes render the same text');

    // A distinct leading glyph is what carries the state on Discord, where an
    // accent colour is not reachable from a plugin at all.
    assert.ok(states.waiting.startsWith('> 🔒 '), 'waiting is the lock');
    assert.ok(states.received.startsWith('> ✓ '), 'received is the check');
    assert.ok(states.expired.startsWith('> ✕ '), 'expired is the cross');
  });

  // Live states may carry the one-time URL; terminal states must carry no link
  // and no capability of any kind.
  it('strips every link and capability from the terminal states', () => {
    for (const [state, notice] of [['received', receivedNotice()], ['expired', expiredNotice()]]) {
      assert.ok(!notice.includes(']('), `${state} has no Markdown link`);
      assert.ok(!notice.includes('http'), `${state} has no URL`);
      assert.ok(!notice.includes(url), `${state} does not carry the drop URL`);
      assert.ok(!notice.includes(handoffId), `${state} does not carry the id`);
      assert.ok(!/[A-Za-z0-9_-]{22}/.test(notice), `${state} has no capability-shaped token`);
    }
  });

  it('keeps the one-time link in the live states, inside the card', () => {
    for (const platform of ['discord', 'telegram']) {
      const notice = live(platform);
      const linked = notice.split('\n').filter((line) => line.includes(url));
      assert.equal(linked.length, 1, `${platform}: the URL appears on exactly one line`);
      assert.ok(linked[0].startsWith('> '), `${platform}: and that line is inside the card`);
      assert.match(linked[0], /\[[^\]]+\]\([^)]+\)/, `${platform}: as a masked link`);
    }
  });
});
