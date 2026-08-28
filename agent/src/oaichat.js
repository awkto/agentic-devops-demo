// Minimal OpenAI-compatible chat loop. One runTurn() call is one agent turn:
// keep calling the model while it returns tool calls, execute them, feed the
// results back, and stop when it replies with plain text (or the iteration cap
// or an abort hits). Works against any /chat/completions endpoint: Fireworks,
// vLLM, or Anthropic's compatibility layer.

async function chatOnce({ baseUrl, apiKey, model, messages, tools, maxTokens, temperature, signal }) {
  let lastErr;
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, 2000 * attempt));
    const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages, tools, tool_choice: 'auto', max_tokens: maxTokens, temperature }),
      signal,
    });
    if (res.ok) return res.json();
    lastErr = new Error(`model API ${res.status}: ${(await res.text()).slice(0, 400)}`);
    if (res.status < 500 && res.status !== 429) break;
  }
  throw lastErr;
}

// invoke(name, args) -> string. isAborted() is checked between model calls;
// signal cancels an in-flight request. injectUser() may return user messages
// queued mid-turn (engineer steering), delivered between tool batches.
export async function runTurn({
  baseUrl, apiKey, model, messages, tools, invoke,
  isAborted, injectUser, signal, maxIters = 80, maxTokens = 4096, temperature = 0.3,
}) {
  let lastSig = null;
  let repeats = 0;
  for (let i = 0; i < maxIters; i++) {
    if (isAborted?.()) return { stop: 'aborted' };
    for (const extra of injectUser?.() ?? []) {
      messages.push({ role: 'user', content: extra });
    }
    let data;
    try {
      data = await chatOnce({ baseUrl, apiKey, model, messages, tools, maxTokens, temperature, signal });
    } catch (err) {
      if (err.name === 'AbortError') return { stop: 'aborted' };
      throw err;
    }
    const m = data.choices?.[0]?.message;
    if (!m) throw new Error(`model API returned no message: ${JSON.stringify(data).slice(0, 300)}`);
    messages.push(m);
    const calls = m.tool_calls || [];
    if (!calls.length) return { stop: 'end_turn', text: m.content || '' };
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
  }
  return { stop: 'max_iters' };
}
