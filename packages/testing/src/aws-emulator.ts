/** A test-only local emulator client. No real AWS endpoints should be accepted by implementations. */
export interface AwsEmulatorClient {
  dynamo(
    action: string,
    input: Record<string, unknown>,
  ): Promise<Record<string, unknown>>;
  sqs(
    action: string,
    input: Record<string, unknown>,
  ): Promise<Record<string, unknown>>;
  emptyBucket(bucket: string): Promise<void>;
  request(
    service: string,
    path: string,
    options?: { method?: string },
  ): Promise<unknown>;
}

/** Allocates independently named resources and deletes only those this call created. */
export async function createAwsTestNamespace(
  client: AwsEmulatorClient,
  tableShape: Record<string, unknown>,
  queueAttributes: Record<string, string>,
  deadLetter?: { attributes: Record<string, string>; maxReceiveCount: number },
  kvShape?: Record<string, unknown>,
  ttlAttribute?: string,
) {
  const name = `errtraq-${globalThis.crypto.randomUUID().replaceAll("-", "")}`;
  const cleanups: (() => Promise<unknown>)[] = [];
  let closed = false;
  async function close() {
    if (closed) return;
    closed = true;
    const failures: unknown[] = [];
    for (const cleanup of cleanups.reverse()) {
      try {
        await cleanup();
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length)
      throw new AggregateError(
        failures,
        "Failed to clean up emulator namespace",
      );
  }
  try {
    await client.request("s3", `/${name}`, { method: "PUT" });
    cleanups.push(async () => {
      await client.emptyBucket(name);
      await client.request("s3", `/${name}`, { method: "DELETE" });
    });
    await client.dynamo("CreateTable", { ...tableShape, TableName: name });
    cleanups.push(() => client.dynamo("DeleteTable", { TableName: name }));
    if (ttlAttribute)
      await client.dynamo("UpdateTimeToLive", {
        TableName: name,
        TimeToLiveSpecification: { Enabled: true, AttributeName: ttlAttribute },
      });
    const kvTable = kvShape ? `${name}-kv` : undefined;
    if (kvTable && kvShape) {
      await client.dynamo("CreateTable", { ...kvShape, TableName: kvTable });
      cleanups.push(() => client.dynamo("DeleteTable", { TableName: kvTable }));
      if (ttlAttribute)
        await client.dynamo("UpdateTimeToLive", {
          TableName: kvTable,
          TimeToLiveSpecification: {
            Enabled: true,
            AttributeName: ttlAttribute,
          },
        });
    }
    let redrivePolicy: string | undefined;
    if (deadLetter) {
      const created = await client.sqs("CreateQueue", {
        QueueName: `${name}-dlq`,
        Attributes: deadLetter.attributes,
      });
      if (typeof created.QueueUrl !== "string")
        throw new Error("CreateQueue did not return the dead-letter queue URL");
      const dlqUrl = created.QueueUrl;
      cleanups.push(() => client.sqs("DeleteQueue", { QueueUrl: dlqUrl }));
      const result = await client.sqs("GetQueueAttributes", {
        QueueUrl: dlqUrl,
        AttributeNames: ["QueueArn"],
      });
      const attributes = result.Attributes;
      if (
        !attributes ||
        typeof attributes !== "object" ||
        !("QueueArn" in attributes) ||
        typeof attributes.QueueArn !== "string"
      )
        throw new Error(
          "GetQueueAttributes did not return the dead-letter queue ARN",
        );
      redrivePolicy = JSON.stringify({
        deadLetterTargetArn: attributes.QueueArn,
        maxReceiveCount: deadLetter.maxReceiveCount,
      });
    }
    const result = await client.sqs("CreateQueue", {
      QueueName: name,
      Attributes: {
        ...queueAttributes,
        ...(redrivePolicy ? { RedrivePolicy: redrivePolicy } : {}),
      },
    });
    const queueUrl = result.QueueUrl;
    if (typeof queueUrl !== "string")
      throw new Error("CreateQueue did not return QueueUrl");
    cleanups.push(() => client.sqs("DeleteQueue", { QueueUrl: queueUrl }));
    return {
      bucket: name,
      prefix: `${name}/`,
      table: name,
      kvTable,
      queueUrl,
      close,
    };
  } catch (error) {
    try {
      await close();
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "Namespace creation and cleanup failed",
      );
    }
    throw error;
  }
}
