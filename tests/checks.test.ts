import { describe, it } from "vitest";
import { NO_FAULTS } from "../src/engine/faults.ts";
import { CHECKS } from "../validation/checks.ts";

describe("the real table passes every check", () => {
  for (const check of CHECKS) it(`${check.layer}: ${check.title}`, () => check.run(NO_FAULTS));
});
