import assert from "node:assert/strict";
import { test } from "vitest";
import {
  adaptCompactionStream,
  GATEWAY_PLAINTEXT_COMPACTION_ID_PREFIX,
  isCompactionTriggerRequest,
  rewriteGatewayCompactionRequest
} from "../src/main/gateway/compaction-adapter.ts";

test("detects a compaction_trigger input item in responses bodies", () => {
  const body = JSON.stringify({
    model: "deepseek-v4-flash",
    input: [
      { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
      { type: "compaction_trigger" }
    ]
  });
  assert.equal(isCompactionTriggerRequest(body), true);
  assert.equal(isCompactionTriggerRequest(JSON.stringify({ model: "m", input: [{ type: "message" }] })), false);
  assert.equal(isCompactionTriggerRequest(JSON.stringify({ model: "m" })), false);
  assert.equal(isCompactionTriggerRequest("not-json"), false);
  assert.equal(isCompactionTriggerRequest(null), false);
});

test("wraps upstream summary text into exactly one compaction output item", () => {
  const source = [
    'data: {"type":"response.created","response":{"id":"r1"}}',
    "",
    'data: {"type":"response.output_item.done","output_index":0,"item":{"id":"msg_1","type":"message","role":"assistant","content":[{"type":"output_text","text":"First part"}]}}',
    "",
    'data: {"type":"response.output_item.done","output_index":1,"item":{"id":"msg_2","type":"message","role":"assistant","content":[{"type":"output_text","text":" and second"}]}}',
    "",
    'data: {"type":"response.completed","response":{"id":"r1","usage":{"input_tokens":1,"output_tokens":2,"total_tokens":3}}}',
    ""
  ].join("\n");

  const result = adaptCompactionStream(source);
  assert.equal(result.adapted, true);
  const events = result.text.split(/\n{2,}/).filter(Boolean).map(parseSseData);
  const compactionDones = events.filter((event) => event.type === "response.output_item.done" && event.item?.type === "compaction");
  assert.equal(compactionDones.length, 1);
  assert.equal(compactionDones[0].item.encrypted_content, "First part and second");
  assert.equal(compactionDones[0].item.id.startsWith(GATEWAY_PLAINTEXT_COMPACTION_ID_PREFIX), true);

  const completedIndex = events.findIndex((event) => event.type === "response.completed");
  const doneIndex = events.findIndex((event) => event.type === "response.output_item.done" && event.item?.type === "compaction");
  assert.ok(doneIndex > -1 && doneIndex < completedIndex, "compaction item must be emitted before response.completed");
  const addedIndex = events.findIndex((event) => event.type === "response.output_item.added" && event.item?.type === "compaction");
  assert.ok(addedIndex > -1 && addedIndex < doneIndex, "compaction item must be added before done");
  assert.ok(events.some((event) => event.type === "response.created"));
});

test("rewrites only gateway plaintext compactions into assistant messages", () => {
  const nativeCompaction = { id: "cmp_native", type: "compaction", encrypted_content: "opaque" };
  const body = Buffer.from(JSON.stringify({
    model: "third-party-model",
    input: [
      { type: "message", role: "user", content: [{ type: "input_text", text: "continue" }] },
      {
        id: `${GATEWAY_PLAINTEXT_COMPACTION_ID_PREFIX}abc123`,
        type: "compaction",
        encrypted_content: "Portable summary"
      },
      nativeCompaction
    ]
  }));

  const result = rewriteGatewayCompactionRequest(body);
  assert.equal(result.adapted, true);
  assert.equal(Buffer.isBuffer(result.body), true);
  const rewritten = JSON.parse(String(result.body));
  assert.deepEqual(rewritten.input[1], {
    type: "message",
    role: "assistant",
    content: [{ type: "output_text", text: "Portable summary" }]
  });
  assert.deepEqual(rewritten.input[2], nativeCompaction);
});

test("does not inspect compaction content without the gateway id prefix", () => {
  const body = JSON.stringify({
    input: [{ id: "cmp_unmarked", type: "compaction", encrypted_content: "Obvious plaintext summary" }]
  });
  const result = rewriteGatewayCompactionRequest(body);
  assert.equal(result.adapted, false);
  assert.equal(result.body, body);
});

test("leaves streams unchanged when the upstream already emits a compaction item", () => {
  const source = [
    'data: {"type":"response.output_item.done","output_index":0,"item":{"type":"compaction","encrypted_content":"native"}}',
    "",
    'data: {"type":"response.completed","response":{"id":"r2"}}',
    ""
  ].join("\n");
  const result = adaptCompactionStream(source);
  assert.equal(result.adapted, false);
  assert.equal(result.text, source);
});

test("leaves streams unchanged when no summary text is available", () => {
  const source = 'data: {"type":"response.completed","response":{"id":"r3"}}\n\n';
  const result = adaptCompactionStream(source);
  assert.equal(result.adapted, false);
  assert.equal(result.text, source);
});

function parseSseData(block: string): Record<string, any> {
  const payload = block.split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .join("\n");
  return JSON.parse(payload);
}
