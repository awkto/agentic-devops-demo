# Design handover: slides for the demo videos

A 6-slide deck to accompany the recorded demo. Slide 1 opens before the first
clip, slides 2-5 are the architecture deep-dive (shown between or alongside
clips), slide 6 closes. Every fact below is taken from the running system, so
diagrams can be drawn literally as described. Designer notes at the end.

## Slide 1 — "An AI engineer on the ops team" (the setup)

- Title: **An AI engineer on the ops team**
- One-liner: an autonomous agent that watches monitoring, works incidents in
  chat, and closes the paperwork - using the same tools the human team uses.
- Three bullets:
  - **Monitors to resolution**: alert fires, agent investigates on the real
    host, fixes, verifies, closes the ticket. Typical incident: under 2 minutes.
  - **Works where the team works**: chat threads, ticketing, monitoring,
    wiki - no new pane of glass.
  - **Humans stay in charge**: any engineer can steer it mid-incident with a
    chat reply - "read-only", "go ahead", "stop".
- Visual: a timeline strip - alert, magnifier, wrench, checkmark - with
  "~90 seconds" underneath.

## Slide 2 — "The sandbox" (infrastructure and stack)

Purpose: the physical map. Three hosts, real production-grade tools.

- Title: **The sandbox: three hosts, real tools**
- Diagram, three server boxes:
  1. **Ops core** (one VM, everything containerized, TLS via a reverse
     proxy). Chips inside the box, grouped:
     - Monitoring: **Icinga 2** (+ Icinga DB, Icinga Web)
     - Chat: **Mattermost**
     - Ticketing: **Zammad**
     - Docs: **MediaWiki** (customer pages + maintenance calendar)
     - Secrets: **OpenBao** (Vault-compatible)
     - SSO: **Keycloak**
  2. **Agent host** - a ~1,000-line Node.js harness running as a locked-down
     systemd service. No containers, no framework runtime - the harness IS
     the product.
  3. **Customer host** - nginx + Node web app + PostgreSQL, plus
     fault-injection scripts used to break it on camera.
- Arrows: Icinga (on ops core) polls the customer host; the agent host
  connects to everything on the ops core via APIs, and to the customer host
  via SSH.
- Caption line: provisioned by Terraform + one idempotent deploy script;
  full rebuild from nothing in ~17 minutes.

## Slide 3 — "How an incident reaches the agent" (event flow + agent loop)

Purpose: the harness design in one picture. Two halves: ingress (left),
loop (right).

- Title: **Event-driven in, agentic loop out**
- Left half - three ingress paths into the harness:
  - **Icinga webhook**: alert notifications POST to the harness
    (token-authenticated). One alert = one incident session.
  - **Zammad webhook**: new customer tickets POST in the same way (the
    harness ignores tickets it filed itself - no feedback loops).
  - **Mattermost WebSocket**: a bot account listens live in the Incidents
    channel - thread replies steer running sessions; `@agent` mentions start
    ad-hoc Q&A sessions.
  - Small but important detail to show: deduplication. A repeat alert for a
    service already being worked on is forwarded into the existing thread,
    not spawned as a duplicate incident. Recovery notifications flow into
    the open session too, so the agent sees its fix confirmed by monitoring.
- Right half - the loop the harness runs per incident (circular diagram,
  4 nodes):
  1. model proposes tool calls →
  2. harness executes them (SSH, APIs) →
  3. results appended to the session transcript →
  4. back to the model - until it answers in plain text.
  - An arrow entering the circle from outside: **engineer replies are
    injected mid-loop** - steering lands between tool batches, not after the
    incident is over.
- Footnote: **provider-agnostic by design.** The harness owns the loop and
  the transcript; the model is any OpenAI-compatible chat endpoint. One
  config line swaps Qwen (open weights, via Fireworks) for Claude or a
  self-hosted vLLM. This demo runs Qwen.

## Slide 4 — "The tool belt and the guardrails" (tool use + enforcement)

Purpose: what the agent can touch, and why the safety is real.

- Title: **Nine tools, hard guardrails**
- Left: the tool belt, grouped by system (a compact grid of chips):
  - **Chat**: post_update (narrate every step into the incident thread)
  - **Host access**: ssh_exec (run commands on customer hosts)
  - **Monitoring**: icinga_status
  - **Ticketing**: list_open_tickets, recent tickets, ticket history,
    update_ticket (note + close)
  - **Docs**: get_wiki_page (runbooks, customer pages, maintenance calendar)
  - **Secrets**: vault_list / vault_read
- Right: the guardrails - the key message is *enforced by the harness, not
  by trusting the model*:
  - **Read-only mode is code, not a request**: in read-only, ssh_exec checks
    every command against a diagnostic allowlist and write-pattern filters;
    anything else returns BLOCKED to the model. On camera you can see the
    model try, get blocked, and back off.
  - **Secrets never reach the model**: vault_read redacts keys and
    passwords; ssh_exec fetches credentials from the vault itself and uses
    them without showing them.
  - **Access is granted per system, at the vault**: the agent's own vault
    identity only carries the systems engineers have granted; an ungranted
    system comes back ACCESS DENIED and the agent asks instead of acting.
    Grant and revoke are one command, no redeploy.
  - **stop is a kill switch**: the chat commands ("stop", "read-only",
    "go ahead") are intercepted by the harness before the model ever sees
    them - stop aborts the in-flight model call.
  - **Everything on the record**: the agent must narrate via the thread and
    close out via the ticket; there is no silent action path.

## Slide 5 — "Memory" (sessions and resumability)

Purpose: why you can ask it questions about last week's incident.

- Title: **Every incident is a session it can return to**
- Diagram: a chat thread on the left, a document/file icon on the right,
  double-headed arrow between them.
  - One incident = one session = one transcript on disk: every model
    message, tool call, and result, in order.
  - A small state map links each chat thread to its session, ticket, and
    mode - so the *thread is the handle to the memory*.
- Behavior bullets:
  - Reply in any old incident thread and the original session resumes with
    full context: "which exact commands did you run?" gets an accurate
    answer in seconds.
  - Survives restarts and redeploys of the harness - the memory is plain
    files, not process state.
  - Engineer interventions are recorded too: a "stop" is written into the
    transcript, so a later resume knows the session was interrupted, not
    finished.
- Caption: transcripts double as the audit log.

## Slide 6 — "Autonomy with guardrails" (the takeaways)

- Title: **Autonomy with guardrails**
- Four takeaways:
  - **Steerable live**: a chat reply changes behavior mid-incident;
    enforcement lives in the harness, not in the prompt.
  - **Context-aware**: checks the maintenance calendar and open tickets
    before acting; stands down during planned windows.
  - **Auditable**: thread + ticket + persisted transcript for every action.
  - **Small and portable**: ~1,000 lines of harness, nine tools, any
    OpenAI-compatible model - the capability is the integrations and the
    guardrails, not the model vendor.
- Closing line: runs on open-weights models today.

## Notes for the designer

- Audience: technical ops/engineering colleagues; they will appreciate the
  architecture slides being literal, not marketing-abstract.
- Slides 2-5 each carry ONE diagram; keep text around it minimal - the
  bullets above are speaker material, not all slide copy. Pull the bolded
  phrases as the on-slide text.
- No employer or customer names anywhere. The sandbox domain gobyl.cc may
  appear in video screenshots; fine.
- Tone: matter-of-fact. No hype words, no emoji.
- Tool/product names are safe and part of the story: Icinga, Mattermost,
  Zammad, MediaWiki, OpenBao, Keycloak, Terraform, Qwen, Fireworks, vLLM,
  Claude, Node.js, PostgreSQL, nginx.
- It is a single agent (one persona, one session per incident) - do not
  depict a multi-agent swarm.
- Dark theme preferred, to match terminal/chat screenshots in the videos.
- Suggested visual language: server boxes with rounded rects and small tool
  chips; the agent loop as a circle of 4 nodes; arrows labeled with protocol
  where it helps (webhook, WebSocket, SSH, API).
