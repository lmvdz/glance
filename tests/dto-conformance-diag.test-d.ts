import type { AgentDTO as SrcAgentDTO } from "../src/types.ts";
import type { AgentDTO } from "../webapp/src/lib/dto.ts";
import type { MismatchedSharedKeys, UnmirroredSourceKeys } from "./dto-conformance.test-d.ts";
const m: { [K in MismatchedSharedKeys<AgentDTO, SrcAgentDTO>]: 1 } = {};
const u: { [K in UnmirroredSourceKeys<AgentDTO, SrcAgentDTO>]: 1 } = {};
export { m, u };
