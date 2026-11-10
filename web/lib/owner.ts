/** What the dashboard needs from a connected wallet. */
export interface OwnerActions {
  ready: boolean;
  accountId: string | null;
  isOwner: boolean;
  busy: string | null;
  error: string | null;
  connect: () => void;
  disconnect: () => void;
  /** Signs a 1-yoctoNEAR owner call and resolves once it is on chain. */
  call: (method: string, args: Record<string, unknown>) => Promise<void>;
}
