export type ApprovalPacketAuthorization = {
  migration_run_id: string;
  packet_id: string;
  packet_hash: string;
  expires_at: string;
  authorized_at: string;
};

type ApprovalPacketAuthorityState = {
  current?: ApprovalPacketAuthorization;
};

const authorityGlobal = globalThis as typeof globalThis & {
  __keystoneApprovalPacketAuthority?: ApprovalPacketAuthorityState;
};

function authorityState() {
  return authorityGlobal.__keystoneApprovalPacketAuthority ??= {};
}

export function authorizeApprovalPacket(
  input: Omit<ApprovalPacketAuthorization, "authorized_at">,
  now = Date.now(),
) {
  const expiresAt = Date.parse(input.expires_at);
  if (!Number.isFinite(expiresAt) || expiresAt <= now) {
    throw new Error("Only a fresh review-ready approval packet can be authorized.");
  }
  const authorization: ApprovalPacketAuthorization = {
    migration_run_id: input.migration_run_id.toLowerCase(),
    packet_id: input.packet_id.toUpperCase(),
    packet_hash: input.packet_hash.toUpperCase(),
    expires_at: new Date(expiresAt).toISOString(),
    authorized_at: new Date(now).toISOString(),
  };
  authorityState().current = authorization;
  return authorization;
}

export function approvalPacketAuthorized(
  input: Pick<ApprovalPacketAuthorization, "migration_run_id" | "packet_id" | "packet_hash">,
  now = Date.now(),
) {
  const current = authorityState().current;
  if (!current) return false;
  if (Date.parse(current.expires_at) <= now) {
    authorityState().current = undefined;
    return false;
  }
  return current.migration_run_id === input.migration_run_id.toLowerCase()
    && current.packet_id === input.packet_id.toUpperCase()
    && current.packet_hash === input.packet_hash.toUpperCase();
}

export function consumeApprovalPacketAuthorization(
  input: Pick<ApprovalPacketAuthorization, "migration_run_id" | "packet_id" | "packet_hash">,
  now = Date.now(),
) {
  if (!approvalPacketAuthorized(input, now)) return false;
  authorityState().current = undefined;
  return true;
}

export function clearApprovalPacketAuthorization() {
  authorityState().current = undefined;
}
