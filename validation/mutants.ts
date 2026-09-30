import { type Fault, FAULTS } from "../src/engine/faults.ts";
import { type Check, CHECKS } from "./checks.ts";

export interface Row {
  fault: Fault;
  description: string;
  caughtBy: Check[];
}

export async function runMutants(): Promise<Row[]> {
  const rows: Row[] = [];
  for (const fault of Object.keys(FAULTS) as Fault[]) {
    const caughtBy: Check[] = [];
    for (const check of CHECKS) {
      try {
        await check.run(new Set([fault]));
      } catch {
        caughtBy.push(check);
      }
    }
    rows.push({ fault, description: FAULTS[fault], caughtBy });
  }
  return rows;
}

export function markdown(rows: Row[]): string {
  const lines = ["| Seeded bug | Caught by |", "|---|---|"];
  for (const r of rows) {
    const by = r.caughtBy.map((c) => `${c.id} (${c.layer})`).join(", ") || "**nothing**";
    lines.push(`| ${r.description} | ${by} |`);
  }
  const caught = rows.filter((r) => r.caughtBy.length).length;
  lines.push("", `${caught} of ${rows.length} seeded bugs caught.`);
  return lines.join("\n");
}
