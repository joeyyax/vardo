// ---------------------------------------------------------------------------
// Shaping an invitation for the client.
//
// The token is the invite. Anyone holding it can accept the role it carries,
// so it never leaves the server — an admin gets a ready-made link instead.
// ---------------------------------------------------------------------------

export type InvitationRow = {
  id: string;
  email: string;
  role: string;
  status: string;
  token: string;
  createdAt: Date | string;
  expiresAt: Date | string;
};

export type SerializedInvitation = Omit<InvitationRow, "token"> & {
  inviteUrl: string | null;
};

/** Drops the token and adds a link only an admin can act on. */
export function serializeInvitation<T extends InvitationRow>(
  row: T,
  { canManage, appUrl }: { canManage: boolean; appUrl: string },
): Omit<T, "token"> & { inviteUrl: string | null } {
  const { token, ...rest } = row;
  return {
    ...rest,
    inviteUrl: canManage && row.status === "pending" ? `${appUrl}/invite/${token}` : null,
  };
}
