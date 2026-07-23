import type { FrozenApprovalPacket } from "./approval-packet";
import { campaignError } from "./remediation-campaign";

export const MARA_AUTONOMOUS_POLICY = "mara-healthy-insert-v1" as const;
export const MARA_AUTONOMOUS_ACKNOWLEDGEMENT = "MARA_HEALTHY_INSERT_V1" as const;

export function assertHealthyAutonomousPacket(packet: FrozenApprovalPacket) {
  if (packet.stage !== "review_ready" || !packet.packet_id || !packet.packet_hash || !packet.expires_at || !packet.items.length) {
    throw campaignError("MARA_AUTONOMY_NOT_READY", "Mara can commit only a fresh, non-empty, review-ready packet.");
  }
  if (packet.operation_family !== "insert" || packet.items.some(item => item.operation !== "INSERT")) {
    throw campaignError("MARA_AUTONOMY_REVIEW_REQUIRED", "Mara autonomous commit is limited to healthy unmatched INSERT candidates. UPDATE records require exact-hash human approval.");
  }
}
