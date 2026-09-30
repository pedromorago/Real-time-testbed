import { beforeAll, describe, expect, it } from "vitest";
import { type Fault, FAULTS } from "../src/engine/faults.ts";
import { type Row, runMutants } from "../validation/mutants.ts";

describe("every seeded bug is caught by at least one check", () => {
  let rows: Row[];
  beforeAll(async () => {
    rows = await runMutants();
  }, 300_000);
  for (const fault of Object.keys(FAULTS) as Fault[]) {
    it(fault, () => {
      const row = rows.find((r) => r.fault === fault)!;
      expect(row.caughtBy.map((c) => c.id)).not.toEqual([]);
    });
  }
});
