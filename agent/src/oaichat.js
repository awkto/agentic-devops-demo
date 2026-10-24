// Minimal OpenAI-compatible chat loop. One runTurn() call is one agent turn:
// keep calling the model while it returns tool calls, execute them, feed the
// results back, and stop when it replies with plain text (or the iteration cap
// or an abort hits). Works against any /chat/completions endpoint: Fireworks,
// vLLM, or Anthropic's compatibility layer.

// A completion that degenerates into repetition (e.g. "80.80 -> 80.80 -> ...")
// runs to max_tokens. Look for a short period repeating through the tail.
export function isDegenerate(text) {
  const tail = String(text || '').slice(-1500);
  if (tail.length < 200) return false;
  for (let p = 1; p <= 150; p++) {
    let run = 0;
    for (let i = tail.length - 1; i >= p && tail[i] === tail[i - p]; i--) run++;
    if (run >= Math.max(150, p * 8)) return true;
  }
  return false;
}

// Reasoning models put <think> blocks in content. Drop them (and an unclosed
// trailing one) so they are not sent back to the model on every later call.
export function stripThink(text) {
  return String(text).replace(/<think>[\s\S]*?<\/think>/g, '').replace(/<think>[\s\S]*$/, '').trim();
}

// One timeout (or network drop) is retried; a second one fails the call.
async function chatOnce({ baseUrl, apiKey, model, messages, tools, maxTokens, temperature, signal, timeoutMs, onCall }) {
  let lastErr;
  let timeouts = 0;
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, 2000 * attempt));
    const t0 = Date.now();
    const sigs = [AbortSignal.timeout(timeoutMs)];
    if (signal) sigs.push(signal);
    try {
      const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/chat/completions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, messages, tools, tool_choice: 'auto', max_tokens: maxTokens, temperature }),
        signal: AbortSignal.any(sigs),
      });
      if (res.ok) {
        const data = await res.json();
        const m = data.choices?.[0]?.message;
        const len = (m?.content || '').length +
          (m?.tool_calls || []).reduce((n, c) => n + (c.function?.arguments || '').length, 0);
        console.log(`model call ${Date.now() - t0}ms, ${len} chars`);
        onCall?.({ model, latencyMs: Date.now() - t0, chars: len, usage: data.usage || null, toolCalls: (m?.tool_calls || []).length });
        return data;
      }
      lastErr = new Error(`model API ${res.status}: ${(await res.text()).slice(0, 400)}`);
      if (res.status < 500 && res.status !== 429) break;
    } catch (err) {
      if (err.name !== 'TimeoutError' || signal?.aborted) throw err;
      console.log(`model call timed out after ${Date.now() - t0}ms`);
      lastErr = new Error(`model call timed out after ${timeoutMs}ms`);
      if (++timeouts > 1) break;
    }
  }
  throw lastErr;
}

// invoke(name, args) -> string. isAborted() is checked between model calls;
// signal cancels an in-flight request. injectUser() may return user messages
// queued mid-turn (engineer steering), delivered between tool batches.
// onBatch() runs after each tool batch so callers can persist messages.
export async function runTurn({
  baseUrl, apiKey, model, messages, tools, invoke,
  isAborted, injectUser, onBatch, onCall, signal, timeoutMs = 180000, maxIters = 80, maxTokens = 4096, temperature = 0.3,
}) {
  let lastSig = null;
  let repeats = 0;
  let nudged = false;
  for (let i = 0; i < maxIters; i++) {
    if (isAborted?.()) return { stop: 'aborted' };
    for (const extra of injectUser?.() ?? []) {
      messages.push({ role: 'user', content: extra });
    }
    let data;
    try {
      data = await chatOnce({ baseUrl, apiKey, model, messages, tools, maxTokens, temperature, signal, timeoutMs, onCall });
    } catch (err) {
      if (err.name === 'AbortError') return { stop: 'aborted' };
      throw err;
    }
    const m = data.choices?.[0]?.message;
    if (!m) throw new Error(`model API returned no message: ${JSON.stringify(data).slice(0, 300)}`);
    if (isDegenerate(m.content)) {
      // Drop the runaway completion; one retry with a nudge, then give up.
      console.log('model completion degenerated into repetition, dropped');
      if (nudged) return { stop: 'degenerate' };
      nudged = true;
      messages.push({ role: 'user', content: '[Your previous reply degenerated into repetition and was discarded. Answer again, briefly, without repeating yourself.]' });
      continue;
    }
    messages.push(typeof m.content === 'string' ? { ...m, content: stripThink(m.content) } : m);
    const calls = m.tool_calls || [];
    if (!calls.length) return { stop: 'end_turn', text: messages[messages.length - 1].content || '' };
    for (const c of calls) {
      // A model stuck in a loop repeats one call verbatim. Cut the turn rather
      // than let it run to the iteration cap.
      const sig = `${c.function.name}:${c.function.arguments || ''}`;
      repeats = sig === lastSig ? repeats + 1 : 0;
      lastSig = sig;
      if (repeats >= 3) return { stop: 'repeat_loop' };
      let out;
      try {
        out = await invoke(c.function.name, JSON.parse(c.function.arguments || '{}'));
      } catch (err) {
        out = `tool error: ${err.message}`;
      }
      messages.push({
        role: 'tool',
        tool_call_id: c.id,
        content: String(out).slice(0, 40000) || '(no output)',
      });
    }
    onBatch?.();
  }
  return { stop: 'max_iters' };
}
