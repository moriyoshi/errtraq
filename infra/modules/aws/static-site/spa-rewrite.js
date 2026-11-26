// CloudFront Function (cloudfront-js-2.0), viewer request, default behavior only. main.tf prepends
//   var ROOT_FILES = [...];  // "/<file>" for each file at the root of the build
//   var PREFIXES = [...];    // "/<dir>/" for each top-level directory of the build
// and tests/spa-rewrite.test.mjs (run by `pnpm test`) executes this file under Node.
//
// The rule is the standalone server's (packages/platforms/standalone/src/static-ui.ts): a request
// that is not for a file of the build is a client-side route only when the viewer accepts
// `text/html` (a navigation); anything else (an image, script, stylesheet or fetch for a missing
// file) passes through, so a missing object is a 404 instead of index.html with status 200.
// Keep the two in step. The one difference: this function cannot see which files exist, so it
// treats the build's root files and everything under its top-level directories as present,
// whereas the standalone server checks the disk. Whether the last path segment has a dot is
// never used: project and issue slugs may contain dots, and so may tag keys (`os.name`).
// biome-ignore lint/correctness/noUnusedVariables: the entry point CloudFront calls
function handler(event) {
  var request = event.request;
  var uri = request.uri;
  var accept = request.headers.accept;
  var values = [];
  var i;
  if (ROOT_FILES.indexOf(uri) !== -1) return request;
  for (i = 0; i < PREFIXES.length; i++) {
    if (uri.indexOf(PREFIXES[i]) === 0) return request;
  }
  if (accept) {
    if (accept.value) values.push(accept.value);
    if (accept.multiValue) {
      for (i = 0; i < accept.multiValue.length; i++) {
        values.push(accept.multiValue[i].value);
      }
    }
  }
  if (values.join(",").toLowerCase().indexOf("text/html") === -1)
    return request;
  request.uri = "/index.html";
  return request;
}
