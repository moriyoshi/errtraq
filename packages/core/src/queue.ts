/** Queue messages must survive JSON serialization without changing their meaning. */
export class InvalidQueueMessageError extends Error {
  override name = "InvalidQueueMessageError";
}
export function validateQueueBody(value: unknown): void {
  const ancestors = new Set<object>();
  const visit = (item: unknown): void => {
    if (item === null || typeof item === "string" || typeof item === "boolean")
      return;
    if (typeof item === "number" && Number.isFinite(item)) return;
    if (typeof item !== "object" || ancestors.has(item))
      throw new InvalidQueueMessageError("Queue body must be plain JSON data");
    const prototype = Object.getPrototypeOf(item);
    if (
      (Array.isArray(item)
        ? prototype !== Array.prototype
        : prototype !== Object.prototype && prototype !== null) ||
      "toJSON" in item ||
      Object.getOwnPropertySymbols(item).length
    )
      throw new InvalidQueueMessageError("Queue body must be plain JSON data");
    ancestors.add(item);
    const descriptors = Object.getOwnPropertyDescriptors(item);
    if (Array.isArray(item)) {
      if (
        Object.keys(descriptors).some(
          (key) =>
            key !== "length" &&
            (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= item.length),
        )
      )
        throw new InvalidQueueMessageError(
          "Queue body must be plain JSON data",
        );
      for (let i = 0; i < item.length; i++) {
        const descriptor = descriptors[String(i)];
        if (!descriptor || !("value" in descriptor) || !descriptor.enumerable)
          throw new InvalidQueueMessageError(
            "Queue body must be plain JSON data",
          );
        visit(descriptor.value);
      }
    } else
      for (const descriptor of Object.values(descriptors)) {
        if (!("value" in descriptor) || !descriptor.enumerable)
          throw new InvalidQueueMessageError(
            "Queue body must be plain JSON data",
          );
        visit(descriptor.value);
      }
    ancestors.delete(item);
  };
  visit(value);
}
