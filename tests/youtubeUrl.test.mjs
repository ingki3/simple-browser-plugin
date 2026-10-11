import test from "node:test";
import assert from "node:assert/strict";

import { youtubeVideoId } from "../src/lib/youtubeUrl.ts";

test("youtubeVideoId recognizes watch, shorts and live pages", () => {
  assert.equal(youtubeVideoId("https://www.youtube.com/watch?v=arj7oStGLkU"), "arj7oStGLkU");
  assert.equal(youtubeVideoId("https://m.youtube.com/watch?v=abc123&t=10s"), "abc123");
  assert.equal(youtubeVideoId("https://www.youtube.com/shorts/g1FjkO9tmsQ"), "g1FjkO9tmsQ");
  assert.equal(youtubeVideoId("https://www.youtube.com/live/jfKfPfyJRdk?si=x"), "jfKfPfyJRdk");
});

test("youtubeVideoId rejects non-video pages and other hosts", () => {
  assert.equal(youtubeVideoId("https://www.youtube.com/"), null);
  assert.equal(youtubeVideoId("https://www.youtube.com/watch"), null);
  assert.equal(youtubeVideoId("https://www.youtube.com/@TED"), null);
  assert.equal(youtubeVideoId("https://notyoutube.com/watch?v=abc123"), null);
  assert.equal(youtubeVideoId("https://youtube.com.evil.test/watch?v=abc123"), null);
  assert.equal(youtubeVideoId("not a url"), null);
});
