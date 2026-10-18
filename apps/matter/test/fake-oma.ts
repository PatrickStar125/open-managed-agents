/**
 * In-memory stand-in for the public OpenMA API: sessions, an append-only
 * session event log with sequences, and SSE streams with Last-Event-ID replay.
 */

export interface FakeEvent {
  readonly type: string;
  readonly [key: string]: unknown;
}

interface Session {
  id: string;
  title: string;
  agent: string;
  environment_id?: string;
  vault_ids: string[];
  status: string;
  archived_at: string | null;
  events: (FakeEvent & { seq: number })[];
  subscribers: Set<(event: FakeEvent & { seq: number }) => void>;
}

export type Responder = (
  sessionId: string,
  event: FakeEvent,
) => readonly FakeEvent[] | undefined;

export class FakeOma {
  readonly sessions = new Map<string, Session>();
  readonly requests: { method: string; path: string; body?: unknown }[] = [];
  apiKey = "test-key";
  responder: Responder = () => undefined;
  private next = 0;

  createSession(title: string, agent = "agent-1"): string {
    const id = `sesn_${++this.next}`;
    this.sessions.set(id, {
      id,
      title,
      agent,
      vault_ids: [],
      status: "idle",
      archived_at: null,
      events: [],
      subscribers: new Set(),
    });
    return id;
  }

  append(sessionId: string, event: FakeEvent): void {
    const session = this.sessions.get(sessionId);
    if (session === undefined) throw new Error(`no session ${sessionId}`);
    const stored = { ...event, seq: session.events.length + 1 };
    session.events.push(stored);
    for (const subscriber of session.subscribers) subscriber(stored);
  }

  readonly fetch = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const headers = new Headers(init?.headers);
    const body =
      typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : undefined;
    this.requests.push({ method, path: url.pathname + url.search, body });
    if (headers.get("x-api-key") !== this.apiKey) {
      return Response.json({ error: "unauthorized" }, { status: 401 });
    }
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts[0] !== "v1" || parts[1] !== "sessions") {
      return Response.json({ error: "not found" }, { status: 404 });
    }
    const id = parts[2];
    if (id === undefined) {
      if (method === "POST") {
        const b = body as {
          agent: string;
          title: string;
          environment_id?: string;
          vault_ids?: string[];
        };
        const sid = this.createSession(b.title, b.agent);
        const session = this.sessions.get(sid)!;
        if (b.environment_id !== undefined) session.environment_id = b.environment_id;
        session.vault_ids = b.vault_ids ?? [];
        return Response.json(this.view(session));
      }
      const agent = url.searchParams.get("agent_id");
      const q = (url.searchParams.get("q") ?? "").toLowerCase();
      const data = [...this.sessions.values()]
        .filter(
          (s) =>
            s.archived_at === null &&
            (agent === null || s.agent === agent) &&
            s.title.toLowerCase().includes(q),
        )
        .map((s) => this.view(s));
      return Response.json({ data });
    }
    const session = this.sessions.get(id);
    if (session === undefined) {
      return Response.json({ error: "Session not found" }, { status: 404 });
    }
    const action = parts.slice(3).join("/");
    if (action === "" && method === "GET") return Response.json(this.view(session));
    if (action === "archive" && method === "POST") {
      session.archived_at = new Date(0).toISOString();
      return Response.json(this.view(session));
    }
    if (action === "events" && method === "POST") {
      const events = (body as { events: FakeEvent[] }).events;
      for (const event of events) {
        this.append(id, event);
        const replies = this.responder(id, event) ?? [];
        // Like the harness, replies arrive after the request returns.
        queueMicrotask(() => {
          for (const reply of replies) this.append(id, reply);
        });
      }
      return Response.json({});
    }
    if (action === "events/stream" && method === "GET") {
      const last = headers.get("last-event-id");
      return this.stream(session, last === null ? undefined : Number(last), init?.signal);
    }
    return Response.json({ error: "not found" }, { status: 404 });
  };

  private view(session: Session) {
    return {
      id: session.id,
      title: session.title,
      status: session.status,
      archived_at: session.archived_at,
      vault_ids: session.vault_ids,
      environment_id: session.environment_id,
    };
  }

  private stream(
    session: Session,
    afterSeq: number | undefined,
    signal: AbortSignal | null | undefined,
  ): Response {
    const encoder = new TextEncoder();
    let subscriber: ((event: FakeEvent & { seq: number }) => void) | undefined;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        const send = (event: FakeEvent & { seq: number }) => {
          try {
            controller.enqueue(
              encoder.encode(
                `: keepalive\n\nevent: ${event.type}\nid: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`,
              ),
            );
          } catch {
            // closed
          }
        };
        controller.enqueue(encoder.encode("retry: 1000\n\n"));
        if (afterSeq !== undefined) {
          for (const event of session.events) if (event.seq > afterSeq) send(event);
        }
        subscriber = send;
        session.subscribers.add(send);
        signal?.addEventListener("abort", () => {
          session.subscribers.delete(send);
          try {
            controller.close();
          } catch {
            // closed
          }
        });
      },
      cancel() {
        if (subscriber !== undefined) session.subscribers.delete(subscriber);
      },
    });
    return new Response(body, { headers: { "content-type": "text/event-stream" } });
  }
}
