import { query } from '@anthropic-ai/claude-agent-sdk';
import { config } from './config.js';
import * as mm from './mattermost.js';
import * as zammad from './zammad.js';
import * as sessions from './sessions.js';
import { buildOpsServer, allowedToolNames, openaiToolSchemas, runTool } from './tools.js';
import { runTurn } from './oaichat.js';
import * as activity from './activity.js';
import { systemPrompt, incidentPrompt, followupPrompt, mentionPrompt } from './prompts.js';

const CLOSE = Symbol('close');

export class Incident {
  // opts: { rootId, resume, mode, ticketId } for follow-up and mention sessions
  constructor(key, trigger, opts = {}) {
    this.key = key;
    this.trigger = trigger;
    this.state = {
      mode: opts.mode || config.defaultMode,
      ticketId: opts.ticketId ?? trigger.ticketId ?? null,
    };
    this.rootId = opts.rootId || null;
    this.resume = opts.resume || null;
    this.sessionId = null;
    this.queue = [];
    this.waiter = null;
    this.done = false;
    this.idleTimer = null;
    this.q = null;
  }

  async postUpdate(message, threadId) {
    const root = threadId || this.rootId;
    const posted = await mm.post(message, root);
    activity.record({ kind: 'post', key: this.key, threadId: root || posted.id, text: message });
    return posted;
  }

  enqueue(item) {
    this.queue.push(item);
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = null;
      w();
    }
  }

  nextInput() {
    if (this.queue.length) return Promise.resolve(this.queue.shift());
    return new Promise((resolve) => {
      this.waiter = () => resolve(this.queue.shift());
    });
  }

  resetIdleTimer() {
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.close('idle timeout, session closed'),
      config.idleMinutes * 60 * 1000);
  }

  close(reason) {
    if (this.done) return;
    this.done = true;
    clearTimeout(this.idleTimer);
    this.enqueue(CLOSE);
    if (reason) mm.post(`(${reason})`, this.rootId).catch(() => {});
  }

  async stop() {
    this.stopped = true;
    this.close('stopped by engineer');
    try { this.aborter?.abort(); } catch {}
    try { await this.q?.interrupt(); } catch {}
  }

  async handleThreadReply(text, username) {
    const cmd = text.trim().toLowerCase().replace(/^@agent[,:]?\s*/, '');
    if (cmd === 'stop') {
      await this.stop();
      return;
    }
    if (cmd === 'read-only') {
      this.state.mode = 'read-only';
      await this.postUpdate('Mode set to read-only. I will only run diagnostic commands.');
      this.enqueue(`[${username} in Mattermost] Switch to read-only mode: investigate but do not change anything on the host.`);
      this.resetIdleTimer();
      return;
    }
    if (cmd === 'read-write' || cmd === 'go ahead') {
      this.state.mode = 'read-write';
      await this.postUpdate('Mode set to read-write. Fixes are allowed again.');
      this.enqueue(`[${username} in Mattermost] Read-write mode restored: you may apply fixes now.`);
      this.resetIdleTimer();
      return;
    }
    this.enqueue(`[${username} in Mattermost] ${text}`);
    this.resetIdleTimer();
  }

  async *inputStream(initial) {
    yield { type: 'user', message: { role: 'user', content: [{ type: 'text', text: initial }] } };
    while (true) {
      const item = await this.nextInput();
      if (item === CLOSE) return;
      yield { type: 'user', message: { role: 'user', content: [{ type: 'text', text: item }] } };
    }
  }

  async buildInitialPrompt() {
    const t = this.trigger;

    if (t.source === 'followup') {
      return followupPrompt(t.username, t.message, this.state.mode);
    }
    if (t.source === 'mention') {
      return mentionPrompt(t.username, t.message, this.state.mode, t.transcript);
    }

    const title = t.source === 'icinga'
      ? `[${t.host}] ${t.service} ${t.state}`
      : `Ticket #${t.ticketNumber}: ${t.title}`;

    const root = await mm.post(
      `Incident: ${title}\nSource: ${t.source}. Investigating, updates follow in this thread. ` +
      `Reply here to guide me ("stop", "read-only", "read-write", or free text).`
    );
    this.rootId = root.id;
    activity.record({
      kind: 'incident-opened',
      key: this.key,
      threadId: this.rootId,
      text: `${title} (source ${t.source})`,
    });

    let ticketInfo;
    if (t.source === 'icinga') {
      try {
        const ticket = await zammad.createTicket(
          `[icinga] ${t.host}/${t.service} ${t.state}`,
          `Automated ticket for Icinga alert.\n\nHost: ${t.host}\nService: ${t.service}\nState: ${t.state}\nOutput: ${t.output}`
        );
        this.state.ticketId = ticket.id;
        ticketInfo = `Zammad ticket #${ticket.number} (id ${ticket.id}) was created for this alert.`;
        await this.postUpdate(`Created Zammad ticket #${ticket.number} for this alert.`);
      } catch (err) {
        console.error('zammad ticket create failed', err);
        ticketInfo = 'Ticket creation in Zammad failed; continue without a ticket and mention this in the summary.';
        await this.postUpdate('Could not create a Zammad ticket (API error). Continuing without one.');
      }
    } else {
      ticketInfo = `This incident came from Zammad ticket id ${this.state.ticketId}.`;
    }
    return incidentPrompt(t, this.state.mode, ticketInfo);
  }

  // Queue items that arrived while a turn is running, minus CLOSE (close()
  // already set done, which the loop checks). Feeds mid-turn steering.
  drainQueued() {
    const out = [];
    while (this.queue.length) {
      const item = this.queue.shift();
      if (item !== CLOSE) out.push(item);
    }
    return out;
  }

  run() {
    return config.modelBaseUrl ? this.runOpenAI() : this.runSdk();
  }

  // Provider-agnostic loop against any OpenAI-compatible endpoint. We own the
  // message array and persist it per session id, so follow-ups resume with
  // full context regardless of provider.
  async runOpenAI() {
    const initialPrompt = await this.buildInitialPrompt();
    this.sessionId = this.resume || crypto.randomUUID();
    this.messages = (this.resume && sessions.load(this.resume)) ||
      [{ role: 'system', content: systemPrompt }];
    this.aborter = new AbortController();
    const tools = openaiToolSchemas();

    let input = initialPrompt;
    try {
      while (true) {
        this.messages.push({ role: 'user', content: input });
        const r = await runTurn({
          baseUrl: config.modelBaseUrl,
          apiKey: config.modelApiKey,
          model: config.model,
          messages: this.messages,
          tools,
          invoke: (name, args) => runTool(this, name, args),
          isAborted: () => this.done,
          injectUser: () => this.drainQueued(),
          signal: this.aborter.signal,
          maxTokens: config.maxTokens,
          temperature: config.temperature,
        });
        sessions.save(this.sessionId, this.messages);
        if (r.stop === 'max_iters') {
          await mm.post('Agent session hit the turn limit and stopped.', this.rootId);
        }
        if (this.done) return;
        // Turn finished. Keep the thread open for follow-up questions.
        this.resetIdleTimer();
        const item = await this.nextInput();
        if (item === CLOSE) return;
        input = item;
      }
    } catch (err) {
      console.error(`incident ${this.key} failed`, err);
      await mm.post(`Agent session crashed: ${err.message}`, this.rootId).catch(() => {});
    } finally {
      this.done = true;
      clearTimeout(this.idleTimer);
      if (this.messages) {
        // Leave a trace of an engineer stop in the transcript, so a later
        // resume knows the session was interrupted rather than abandoned.
        if (this.stopped) {
          this.messages.push({ role: 'user', content: '[The engineer sent "stop". The session was interrupted and closed at this point.]' });
        }
        sessions.save(this.sessionId, this.messages);
      }
    }
  }

  async runSdk() {
    const initialPrompt = await this.buildInitialPrompt();

    const opsServer = buildOpsServer(this);
    this.q = query({
      prompt: this.inputStream(initialPrompt),
      options: {
        systemPrompt,
        model: config.model,
        mcpServers: { ops: opsServer },
        allowedTools: allowedToolNames,
        permissionMode: 'bypassPermissions',
        maxTurns: 80,
        ...(this.resume ? { resume: this.resume } : {}),
      },
    });

    try {
      for await (const msg of this.q) {
        if (msg.type === 'system' && msg.subtype === 'init' && msg.session_id) {
          this.sessionId = msg.session_id;
        }
        if (msg.type === 'result') {
          if (msg.subtype !== 'success' && msg.subtype !== 'error_max_turns') {
            await mm.post(`Agent session error: ${msg.subtype}`, this.rootId);
          }
          // Turn finished. Keep the thread open for follow-up questions.
          this.resetIdleTimer();
        }
      }
    } catch (err) {
      console.error(`incident ${this.key} failed`, err);
      await mm.post(`Agent session crashed: ${err.message}`, this.rootId).catch(() => {});
    } finally {
      this.done = true;
      clearTimeout(this.idleTimer);
    }
  }
}
