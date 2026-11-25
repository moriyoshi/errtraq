import type { PubsubPushRequest, PubsubPushResponse } from "./runtime.js";

export const PROJECT = "test-project";
export const TOKEN = "fake-oidc-token";
export type FakeMessage = {
  messageId: string;
  data: string;
  attributes: Record<string, string>;
  orderingKey?: string;
  attempt: number;
};
export type PublishCall = {
  url: string;
  authorization: string | undefined;
  messages: {
    data: string;
    attributes: Record<string, string>;
    orderingKey?: string;
  }[];
};

/** A small in-memory Pub/Sub: topics, one subscription per topic, publish REST and a push driver. */
export class FakePubsub {
  readonly calls: PublishCall[] = [];
  /** HTTP statuses to answer the next publish requests with instead of publishing. */
  readonly failures: number[] = [];
  private readonly pending = new Map<string, FakeMessage[]>();
  private nextId = 1;
  topicOf(subscription: string): string {
    return subscription.replace("/subscriptions/", "/topics/");
  }
  readonly fetch: typeof fetch = async (input, init) => {
    const url = String(input);
    const match = /\/v1\/(projects\/[^/]+\/topics\/[^/:]+):publish$/.exec(url);
    if (!match?.[1]) return new Response("not found", { status: 404 });
    const body = JSON.parse(String(init?.body)) as {
      messages: PublishCall["messages"];
    };
    const headers = new Headers(init?.headers);
    this.calls.push({
      url,
      authorization: headers.get("authorization") ?? undefined,
      messages: body.messages,
    });
    const failure = this.failures.shift();
    if (failure !== undefined)
      return new Response(
        JSON.stringify({ error: { code: failure, status: "UNAVAILABLE" } }),
        { status: failure },
      );
    const subscription = match[1].replace("/topics/", "/subscriptions/");
    const queue = this.pending.get(subscription) ?? [];
    this.pending.set(subscription, queue);
    const ids = body.messages.map((message) => {
      const messageId = String(this.nextId++);
      queue.push({ messageId, ...message, attempt: 1 });
      return messageId;
    });
    return new Response(JSON.stringify({ messageIds: ids }), {
      headers: { "content-type": "application/json" },
    });
  };
  pendingCount(subscription: string): number {
    return this.pending.get(subscription)?.length ?? 0;
  }
  /**
   * One push round: every outstanding message is pushed once, in order. An
   * ordering key stops at its first nack, like Pub/Sub's one outstanding
   * message per key. Returns the response statuses.
   */
  async push(
    subscription: string,
    handle: (request: PubsubPushRequest) => Promise<PubsubPushResponse>,
    options: { deadLetter?: boolean; token?: string } = {},
  ): Promise<number[]> {
    const queue = this.pending.get(subscription) ?? [];
    const statuses: number[] = [];
    const blocked = new Set<string>();
    const kept: FakeMessage[] = [];
    for (const message of queue) {
      if (
        message.orderingKey !== undefined &&
        blocked.has(message.orderingKey)
      ) {
        kept.push(message);
        continue;
      }
      const response = await handle({
        method: "POST",
        headers: { authorization: `Bearer ${options.token ?? TOKEN}` },
        body: JSON.stringify({
          message: {
            data: message.data,
            attributes: message.attributes,
            messageId: message.messageId,
            message_id: message.messageId,
            publishTime: "2026-11-26T00:00:00Z",
            publish_time: "2026-11-26T00:00:00Z",
            ...(message.orderingKey === undefined
              ? {}
              : { orderingKey: message.orderingKey }),
          },
          subscription,
          ...(options.deadLetter === false
            ? {}
            : { deliveryAttempt: message.attempt }),
        }),
      });
      statuses.push(response.status);
      if (![102, 200, 201, 202, 204].includes(response.status)) {
        message.attempt++;
        kept.push(message);
        if (message.orderingKey !== undefined) blocked.add(message.orderingKey);
      }
    }
    this.pending.set(subscription, kept);
    return statuses;
  }
}
export const verifyToken = async (request: PubsubPushRequest) => {
  const headers = new Headers(
    request.headers instanceof Headers
      ? request.headers
      : (Object.fromEntries(
          Object.entries(request.headers).filter(([, v]) => v !== undefined),
        ) as Record<string, string>),
  );
  return headers.get("authorization") === `Bearer ${TOKEN}`;
};
