// The `@types/pdf-parse` package only types the top-level module. We import the
// internal `pdf-parse/lib/pdf-parse.js` entry point directly to bypass the
// package's index.js debug self-test (it reads a bundled test PDF at import
// time). Re-declare the subpath with the same signature as the typed module.
declare module "pdf-parse/lib/pdf-parse.js" {
  import pdfParse = require("pdf-parse");
  export = pdfParse;
}
