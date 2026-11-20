/** Stack files use default TypeScript stripping in Node 22.18 and 23.6 onwards. */
export function assertNodeVersion(version: string): void {
  const match = /^(\d+)\.(\d+)\./.exec(version);
  if (
    !match ||
    Number(match[1]) < 22 ||
    (Number(match[1]) === 22 && Number(match[2]) < 18) ||
    (Number(match[1]) === 23 && Number(match[2]) < 6)
  )
    throw new Error("Node.js ^22.18.0 or >=23.6.0 is required");
}
