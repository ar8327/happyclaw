import assert from 'node:assert/strict';
import {
  formatCommandHelp,
  isLikelyCommandToken,
  parseSlashCommand,
  stripLeadingMentions,
} from './im-command-utils.js';
import { analyzeIntent } from './intent-analyzer.js';

function testMentionStripping(): void {
  // Bot display names containing a space used to break the old ^@\S+\s+ regex,
  // swallowing the command into the agent's message stream.
  assert.equal(
    stripLeadingMentions('@Happy Claw /status', ['Happy Claw']),
    '/status',
  );
  assert.equal(stripLeadingMentions('@bot /status', ['bot']), '/status');
  // Feishu renders a mention with an unknown display name as a bare "@".
  assert.equal(stripLeadingMentions('@ /status', ['']), '/status');
  // Several mentions in front of the command.
  assert.equal(
    stripLeadingMentions('@Happy Claw @张三 /bind ws', ['Happy Claw', '张三']),
    '/bind ws',
  );
  // Unknown names still fall back to the generic strip.
  assert.equal(stripLeadingMentions('@someone /help', []), '/help');
  // Plain text is untouched.
  assert.equal(stripLeadingMentions('看下 /tmp/a.log', []), '看下 /tmp/a.log');
  assert.equal(stripLeadingMentions('  /stop  ', []), '/stop');
  // An email-ish body must not be eaten from the middle.
  assert.equal(
    stripLeadingMentions('ping a@b.com 一下', []),
    'ping a@b.com 一下',
  );
}

function testSlashParsing(): void {
  assert.deepEqual(parseSlashCommand('/stop'), { cmd: 'stop', body: 'stop' });
  assert.deepEqual(parseSlashCommand('/require_mention true'), {
    cmd: 'require_mention',
    body: 'require_mention true',
  });
  // Telegram appends the bot username in group chats.
  assert.deepEqual(parseSlashCommand('/status@HappyClawBot'), {
    cmd: 'status',
    body: 'status',
  });
  assert.deepEqual(parseSlashCommand('/bind myws/a3b'), {
    cmd: 'bind',
    body: 'bind myws/a3b',
  });
  // Paths parse into a command token that is not command-shaped, so the
  // dispatcher lets them fall through to the agent.
  assert.equal(parseSlashCommand('/tmp/a.log 这个文件看下')?.cmd, 'tmp/a.log');
  assert.equal(parseSlashCommand('hello /stop'), null);
  assert.equal(parseSlashCommand('/ stop'), null);
  assert.equal(parseSlashCommand(''), null);
}

function testCommandTokenHeuristic(): void {
  assert.equal(isLikelyCommandToken('stpo'), true);
  assert.equal(isLikelyCommandToken('require_metnion'), true);
  assert.equal(isLikelyCommandToken('tmp/a.log'), false);
  assert.equal(isLikelyCommandToken('usr/bin'), false);
  assert.equal(isLikelyCommandToken('说明一下'), false);
  assert.equal(isLikelyCommandToken('1password'), false);
  assert.equal(isLikelyCommandToken('a'.repeat(40)), false);
}

function testGroupStopIntentSurvivesMentions(): void {
  // The mention prefix pushed the text over the "keyword + extra content"
  // threshold, so an explicit stop was downgraded to 'correction' — which no
  // longer hard-interrupts. Stripping first restores the stop intent.
  assert.equal(analyzeIntent('@Happy Claw 停'), 'correction');
  assert.equal(
    analyzeIntent(stripLeadingMentions('@Happy Claw 停', ['Happy Claw'])),
    'stop',
  );
  assert.equal(
    analyzeIntent(stripLeadingMentions('@Happy Claw /stop', ['Happy Claw'])),
    'stop',
  );
}

function testHelpText(): void {
  const help = formatCommandHelp();
  for (const expected of ['/stop', '/require_mention', '/help', '/bind']) {
    assert.ok(help.includes(expected), `help missing ${expected}`);
  }
}

testMentionStripping();
testSlashParsing();
testCommandTokenHeuristic();
testGroupStopIntentSurvivesMentions();
testHelpText();
console.log('IM slash command tests passed');
