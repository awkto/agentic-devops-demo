// Standalone check for the repetition detector and think stripping.
import assert from 'assert';
import { isDegenerate, stripThink } from './src/oaichat.js';

assert(isDegenerate('thinking ' + '80.80 → '.repeat(60)));
assert(isDegenerate('x'.repeat(400)));
assert(!isDegenerate('The disk on web01 is 91% full; /var/log holds most of it. '.repeat(2)));
assert(!isDegenerate('a normal short answer'));
assert.equal(stripThink('<think>a\nb</think>\nHello'), 'Hello');
assert.equal(stripThink('Hi <think>cut off'), 'Hi');
console.log('ok');
