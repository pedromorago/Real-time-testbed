// Runs every check against every seeded bug and prints a Markdown table.
import { markdown, runMutants } from "../validation/mutants.ts";

const rows = await runMutants();
console.log(markdown(rows));
if (rows.some((r) => r.caughtBy.length === 0)) process.exit(1);
