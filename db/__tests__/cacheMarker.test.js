import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { withCacheMarker, withoutCacheMarker, moveRollingMarker } from "../../claude.js";

// The rolling cache breakpoint added to askClaude's tool loop must never
// accumulate markers across iterations - Anthropic caps requests at 4
// cache_control breakpoints total, and the system prompt already uses one.
// This simulates a long multi-round-trip turn (like reviewing a call: find
// it, pull the transcript, write the review) and checks the invariant
// directly rather than trusting it by inspection.

function countMarkers(messages) {
  let count = 0;
  for (const m of messages) {
    if (Array.isArray(m.content)) {
      for (const block of m.content) {
        if (block.cache_control) count++;
      }
    }
  }
  return count;
}

describe("rolling cache marker (tool loop)", () => {
  test("never carries more than one rolling marker, across many iterations", () => {
    let messages = [{ role: "user", content: "start" }];
    let rollingIdx = moveRollingMarker(messages, -1);
    assert.equal(countMarkers(messages), 1);

    for (let i = 0; i < 20; i++) {
      messages = [...messages, { role: "assistant", content: [{ type: "text", text: `turn ${i}` }] }];
      rollingIdx = moveRollingMarker(messages, rollingIdx);
      // Exactly one marker in the whole array at all times - the system
      // prompt's own breakpoint is separate (in the `system` array, not
      // `messages`), so this + that = 2 total, well under the 4 cap.
      assert.equal(countMarkers(messages), 1, `iteration ${i} should carry exactly one rolling marker`);
      assert.equal(rollingIdx, messages.length - 1, "marker should sit on the newest message");
    }
  });

  test("withCacheMarker wraps a bare string and marks the last block", () => {
    const blocks = withCacheMarker("hello");
    assert.deepEqual(blocks, [{ type: "text", text: "hello", cache_control: { type: "ephemeral" } }]);
  });

  test("withoutCacheMarker strips the marker back off", () => {
    const marked = withCacheMarker("hello");
    const stripped = withoutCacheMarker(marked);
    assert.equal(stripped[0].cache_control, undefined);
    assert.equal(stripped[0].text, "hello");
  });
});
