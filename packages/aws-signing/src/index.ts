import { AwsV4Signer } from "aws4fetch";

/** Sign an AWS HTTP request with WebCrypto; credentials are supplied by the caller. */
export function signAwsRequest(
  input: ConstructorParameters<typeof AwsV4Signer>[0],
) {
  return new AwsV4Signer(input).sign();
}
