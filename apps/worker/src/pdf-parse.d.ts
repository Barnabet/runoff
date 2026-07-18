// The engine imports the internal `pdf-parse/lib/pdf-parse.js` entry point
// (to bypass pdf-parse's index.js debug self-test). `@types/pdf-parse` only
// types the top-level module, and that ambient declaration lives inside the
// engine's own `src`, so it isn't visible to consumers that type-check the
// engine's source transitively. Mirror it here so the worker compiles.
declare module "pdf-parse/lib/pdf-parse.js" {
  import pdfParse = require("pdf-parse");
  export = pdfParse;
}
