interface SseEvent {
  raw: string;
  data: Record<string, unknown> | null;
}

/**
 * Codex CLI remote compaction v2 sends a normal `/v1/responses` request whose
 * input ends with a `compaction_trigger` item, then requires the upstream
 * response stream to contain exactly one `compaction` output item. Upstreams
 * without native compaction support (for example DeepSeek) accept the trigger
 * but only reply with ordinary message items, which makes the CLI fail with
 * "expected exactly one compaction output item". This module rewrites such
 * responses by wrapping the upstream summary text into a `compaction` item.
 */

export function isCompactionTriggerRequest(body: unknown): boolean {
  const payload = parseJsonObject(body);
  if (!Array.isArray(payload.input)) return false;
  return payload.input.some((item) => isRecord(item) && item.type === "compaction_trigger");
}

export function adaptCompactionStream(text: string): { adapted: boolean; text: string } {
  const events = splitSseEvents(text);
  if (events.length === 0) return { adapted: false, text };

  let summaryText = "";
  let sawCompactionItem = false;
  let maxOutputIndex = -1;
  const completedIndexes: number[] = [];

  for (const event of events) {
    const data = event.data;
    if (!data) continue;
    const type = String(data.type || "");
    if (type === "response.output_item.added" || type === "response.output_item.done") {
      const index = Number(data.output_index);
      if (Number.isFinite(index)) maxOutputIndex = Math.max(maxOutputIndex, index);
      const item = isRecord(data.item) ? data.item : null;
      if (!item) continue;
      if (item.type === "compaction") sawCompactionItem = true;
      if (type === "response.output_item.done") {
        summaryText += outputTextFromItem(item);
      }
    }
    if (type === "response.completed") completedIndexes.push(events.indexOf(event));
  }

  const summary = summaryText.trim();
  if (sawCompactionItem || completedIndexes.length === 0 || !summary) {
    return { adapted: false, text };
  }

  const nextIndex = Math.max(0, maxOutputIndex + 1);
  const compactionItem = {
    id: `cmp_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`,
    type: "compaction",
    encrypted_content: summary
  };
  const added = sseData({ type: "response.output_item.added", output_index: nextIndex, item: compactionItem });
  const done = sseData({ type: "response.output_item.done", output_index: nextIndex, item: compactionItem });

  const rebuilt: string[] = [];
  let injected = false;
  for (const [index, event] of events.entries()) {
    if (!injected && completedIndexes.includes(index)) {
      rebuilt.push(added, done);
      injected = true;
    }
    rebuilt.push(event.raw);
  }
  return { adapted: true, text: `${rebuilt.join("\n\n")}\n\n` };
}

function outputTextFromItem(item: Record<string, unknown>): string {
  const content = Array.isArray(item.content) ? item.content : [];
  return content.map((part) => {
    if (!isRecord(part)) return "";
    const type = String(part.type || "");
    if (type === "output_text" || type === "text") return String(part.text || "");
    return "";
  }).join("");
}

function splitSseEvents(text: string): SseEvent[] {
  const normalized = String(text || "").replace(/\r\n/g, "\n");
  const blocks = normalized.split(/\n{2,}/);
  const events: SseEvent[] = [];
  for (const block of blocks) {
    const trimmed = block.trim();
    if (!trimmed) continue;
    events.push({ raw: trimmed, data: parseSseData(trimmed) });
  }
  return events;
}

function parseSseData(block: string): Record<string, unknown> | null {
  const lines = block.split("\n");
  const payloads: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const value = trimmed.slice(5).trim();
    if (value) payloads.push(value);
  }
  if (payloads.length === 0) return null;
  try {
    const parsed = JSON.parse(payloads.join("\n"));
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function sseData(value: Record<string, unknown>): string {
  return `data: ${JSON.stringify(value)}`;
}

function parseJsonObject(value: unknown): Record<string, unknown> {
  if (Buffer.isBuffer(value)) {
    try {
      const parsed = JSON.parse(value.toString("utf8"));
      return isRecord(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  if (isRecord(value)) return value;
  try {
    const parsed = JSON.parse(String(value || ""));
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
