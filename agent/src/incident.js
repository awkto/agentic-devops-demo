import { query } from '@anthropic-ai/claude-agent-sdk';
import { config } from './config.js';
import * as zammad from './zammad.js';
import * as sessions from './sessions.js';
import { buildOpsServer, allowedToolNames, openaiToolSchemas, runTool } from './tools.js';
import { runTurn } from './oaichat.js';
import * as activity from './activity.js';
import * as audit from './audit.js';
import * as settings from './settings.js';
import { systemPrompt, incidentPrompt, followupPrompt, mentionPrompt } from './prompts.js';

const CLOSE = Symbol('close');

export class Incident {
  // opts: { rootId, resume, mode, ticketId } for follow-up and mention sessions
  constructor(key, trigger, opts = {}) {
    this.key = key;
    this.profile = opts.profile || 'ops';
    this.mm = opts.mm;
    this.channel = opts.channel;
    this.trigger = trigger;
    this.state = {
      mode: this.readOnlyProfile() ? 'read-only' : (opts.mode || config.defaultMode),
      ticketId: opts.ticketId ?? trigger.ticketId ?? null,
    };
    this.rootId = opts.rootId || null;
    this.resume = opts.resume || null;
    this.onSession = opts.onSession || null;
    this.busy = false;
    this.acked = false;
    this.sessionId = null;
    this.queue = [];
    this.waiter = null;
    this.done = false;
    this.idleTimer = null;
    this.q = null;
    this.postKeys = [];
    this.dupPosts = 0;
    this.postsTotal = 0;
  }

  // A read-only profile never leaves read-only, whatever an engineer says.
  readOnlyProfile() {
    return settings.profile(this.profile)?.mode === 'read-only';
  }

  audit(kind, summary, detail, actor = this.mm?.botName || 'agent') {
    audit.record({ profile: this.profile, kind, rootId: this.rootId, ticketId: this.state.ticketId, actor, summary, detail });
  }

  // Describes what started this session, for the audit trigger row.
  auditTrigger(t = this.trigger) {
    if (t.source === 'icinga') {
      this.audit('trigger', `icinga ${t.type || ''} ${t.host}/${t.service} ${t.state}`, t, 'icinga');
    } else if (t.source === 'zammad') {
      this.audit('trigger', `zammad ticket #${t.ticketNumber}: ${t.title}`, { ticketId: t.ticketId, title: t.title }, 'zammad');
    } else {
      this.audit('trigger', `${t.source} from ${t.username}: ${audit.clip(t.message, 120)}`,
        { message: audit.clip(t.message) }, t.username);
    }
  }

  // A model that loops will happily post the same update forever. Refuse the
  // repeat, tell it so, and close the session if it keeps going.
  guardPost(message, threadId) {
    const key = (threadId || this.rootId || '') + '|' +
      String(message).trim().replace(/\s+/g, ' ').slice(0, 400);
    if (this.postKeys.includes(key)) {
      this.dupPosts += 1;
      if (this.dupPosts >= 3) this.close('repeated updates suppressed, session closed');
      return 'NOT POSTED: you already posted this update in this thread. Do not send it again. ' +
        'If there is nothing new to add, stop calling tools and reply with your final summary.';
    }
    this.postsTotal += 1;
    if (this.postsTotal > 30) {
      this.close('update limit reached, session closed');
      return 'NOT POSTED: this session has posted too many updates. Stop and reply with a final summary.';
    }
    this.postKeys.push(key);
    if (this.postKeys.length > 10) this.postKeys.shift();
    this.dupPosts = 0;
    return null;
  }

  async postUpdate(message, threadId) {
    const root = threadId || this.rootId;
    const posted = await this.mm.post(message, root);
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
    if (reason) this.mm.post(`(${reason})`, this.rootId).catch(() => {});
  }

  // Kill switch hit: cut the in-flight model call and tell the thread.
  async disabledBy(admin) {
    try { this.aborter?.abort(); } catch {}
    if (this.rootId) await this.mm.post(`Agent disabled by ${admin}.`, this.rootId).catch(() => {});
  }

  async stop() {
    this.stopped = true;
    this.close('stopped by engineer');
    try { this.aborter?.abort(); } catch {}
    try { await this.q?.interrupt(); } catch {}
  }

  async handleThreadReply(text, username) {
    const cmd = text.trim().toLowerCase().replace(new RegExp(`^@${this.mm.botName}[,:]?\\s*`), '');
    if (cmd === 'stop' || cmd === 'read-only' || cmd === 'read-write' || cmd === 'go ahead') {
      this.audit('trigger', `thread command from ${username}: ${cmd}`, { message: audit.clip(text) }, username);
    }
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
    if ((cmd === 'read-write' || cmd === 'go ahead') && this.readOnlyProfile()) {
      await this.postUpdate('I am a read-only agent, I cannot switch to read-write.');
      return;
    }
    if (cmd === 'read-write' || cmd === 'go ahead') {
      this.state.mode = 'read-write';
      await this.postUpdate('Mode set to read-write. Fixes are allowed again.');
      this.enqueue(`[${username} in Mattermost] Read-write mode restored: you may apply fixes now.`);
      this.resetIdleTimer();
      return;
    }
    this.audit('trigger', `thread reply from ${username}: ${audit.clip(text, 120)}`, { message: audit.clip(text) }, username);
    // A reply queued mid-turn is only read between model calls; say so once
    // per turn so it does not look ignored.
    if (this.busy && !this.acked) {
      this.acked = true;
      await this.postUpdate("Noted, I'll pick that up after the current step.").catch(() => {});
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

    if (t.source === 'followup' || t.source === 'mention') this.auditTrigger();
    if (t.source === 'followup') {
      return followupPrompt(t.username, t.message, this.state.mode);
    }
    if (t.source === 'mention') {
      return mentionPrompt(t.username, t.message, this.state.mode, t.transcript);
    }

    const title = t.source === 'icinga'
      ? `[${t.host}] ${t.service} ${t.state}`
      : `Ticket #${t.ticketNumber}: ${t.title}`;

    const root = await this.mm.post(
      `Incident: ${title}\nSource: ${t.source}. Investigating, updates follow in this thread. ` +
      `Reply here to guide me ("stop", "read-only", "read-write", or free text).`,
      null, this.channel,
    );
    this.rootId = root.id;
    this.auditTrigger();
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
        this.audit('ticket', `created #${ticket.number}`, { id: ticket.id, number: ticket.number, title: ticket.title });
        const link = zammad.ticketLink(ticket);
        ticketInfo = `Zammad ticket ${link} (id ${ticket.id}) was created for this alert.`;
        await this.postUpdate(`Created Zammad ticket ${link} for this alert.`);
      } catch (err) {
        console.error('zammad ticket create failed', err);
        ticketInfo = 'Ticket creation in Zammad failed; continue without a ticket and mention this in the summary.';
        await this.postUpdate('Could not create a Zammad ticket (API error). Continuing without one.');
      }
    } else {
      ticketInfo = `This incident came from Zammad ticket ${zammad.ticketLink({ id: this.state.ticketId, number: t.ticketNumber })} (id ${this.state.ticketId}).`;
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
    // Map root -> session now, so a restart mid-incident can still resume it.
    this.onSession?.(this);
    const tools = openaiToolSchemas();

    let input = initialPrompt;
    try {
      while (true) {
        this.messages.push({ role: 'user', content: input });
        this.busy = true;
        this.acked = false;
        this.aborter = new AbortController();
        const r = await runTurn({
          baseUrl: config.modelBaseUrl,
          apiKey: config.modelApiKey,
          model: config.model,
          messages: this.messages,
          tools,
          invoke: (name, args) => this.auditedTool(name, args),
          onCall: (c) => this.audit('model_call', `${c.model} ${c.latencyMs}ms, ${c.chars} chars, ${c.toolCalls} tool calls`, c),
          isAborted: () => this.done || !settings.isEnabled(this.profile),
          injectUser: () => this.drainQueued(),
          onBatch: () => {
            sessions.save(this.sessionId, this.messages);
            this.onSession?.(this);
          },
          timeoutMs: config.modelTimeoutMs,
          signal: this.aborter.signal,
          maxTokens: config.maxTokens,
          temperature: config.temperature,
        });
        this.busy = false;
        sessions.save(this.sessionId, this.messages);
        if (r.stop === 'degenerate') {
          await this.mm.post('(stopped: the model output degenerated into repetition)', this.rootId);
        }
        if (r.stop === 'max_iters') {
          await this.mm.post('Agent session hit the turn limit and stopped.', this.rootId);
        }
        if (r.stop === 'repeat_loop') {
          await this.mm.post('(stopped: the model repeated the same action)', this.rootId);
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
      await this.mm.post(`Agent session crashed: ${err.message}`, this.rootId).catch(() => {});
    } finally {
      this.busy = false;
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

  async auditedTool(name, args) {
    let out;
    let status = 'ok';
    try {
      out = String(await runTool(this, name, args));
    } catch (err) {
      out = `tool error: ${err.message}`;
      status = 'error';
    }
    if (status === 'ok' && /^(BLOCKED|NOT POSTED)/.test(out)) status = 'blocked';
    else if (status === 'ok' && /^(tool error|invalid arguments|unknown tool)/.test(out)) status = 'error';
    this.audit('tool_call', `${name} ${status}`, { name, args: audit.clip(args), status, result: audit.clip(out) });
    if (name === 'update_ticket' && status === 'ok') {
      this.audit('ticket', args.state === 'closed' ? 'closed' : 'updated', { note: audit.clip(args.note, 500), state: args.state || null });
    }
    if (status === 'error') throw new Error(out.replace(/^tool error: /, ''));
    return out;
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
            await this.mm.post(`Agent session error: ${msg.subtype}`, this.rootId);
          }
          // Turn finished. Keep the thread open for follow-up questions.
          this.resetIdleTimer();
        }
      }
    } catch (err) {
      console.error(`incident ${this.key} failed`, err);
      await this.mm.post(`Agent session crashed: ${err.message}`, this.rootId).catch(() => {});
    } finally {
      this.done = true;
      clearTimeout(this.idleTimer);
    }
  }
}
