// Installs the offline loader hook in-process (Node >= 18.19) so it applies to
// subsequently-imported modules, including server.js. Used via
// `node --import ./test/register-loader.mjs ...`.
import { register } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
register("./loader.mjs", pathToFileURL(here + "/").href);
