const YOCTO_PER_NEAR = 10n ** 24n;

/** yoctoNEAR string -> short human string, e.g. "1.5". Exact, no float math. */
export function formatNear(yocto: string, maxDecimals = 4): string {
  let v: bigint;
  try {
    v = BigInt(yocto);
  } catch {
    return "0";
  }
  const neg = v < 0n;
  if (neg) v = -v;

  const whole = v / YOCTO_PER_NEAR;
  const frac = v % YOCTO_PER_NEAR;

  let fracStr = frac.toString().padStart(24, "0").slice(0, maxDecimals).replace(/0+$/, "");
  // Don't render a non-zero amount as a flat "0".
  if (fracStr === "" && frac > 0n && whole === 0n) fracStr = "0".repeat(maxDecimals - 1) + "1";

  return `${neg ? "-" : ""}${whole}${fracStr ? `.${fracStr}` : ""}`;
}

export const nearLabel = (yocto: string, maxDecimals = 4): string =>
  `${formatNear(yocto, maxDecimals)} NEAR`;

/**
 * Decimal NEAR string -> yoctoNEAR string. Returns null for anything that is
 * not a plain non-negative decimal, so the caller can show a field error
 * instead of sending nonsense to the chain.
 */
export function parseNear(input: string): string | null {
  const s = input.trim();
  if (!/^\d*\.?\d*$/.test(s) || s === "" || s === ".") return null;
  const [whole = "0", frac = ""] = s.split(".");
  if (frac.length > 24) return null;
  return (BigInt(whole) * YOCTO_PER_NEAR + BigInt((frac + "0".repeat(24)).slice(0, 24))).toString();
}

export function pctOf(part: string, whole: string): number {
  try {
    const w = BigInt(whole);
    if (w === 0n) return 0;
    const p = (BigInt(part) * 10000n) / w;
    return Math.min(100, Number(p) / 100);
  } catch {
    return 0;
  }
}

export function timeAgo(msString: string): string {
  const then = Number(msString);
  if (!Number.isFinite(then) || then === 0) return "—";
  const s = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export function clockTime(msString: string): string {
  const n = Number(msString);
  if (!Number.isFinite(n) || n === 0) return "—";
  return new Date(n).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export function shortAccount(id: string): string {
  const parts = id.split(".");
  return parts.length > 1 && id.length > 24 ? `${parts[0]}.…${parts[parts.length - 1]}` : id;
}

export function msToHuman(ms: number): string {
  if (ms % 86_400_000 === 0) return `${ms / 86_400_000}d`;
  if (ms % 3_600_000 === 0) return `${ms / 3_600_000}h`;
  if (ms % 60_000 === 0) return `${ms / 60_000}m`;
  return `${ms}ms`;
}
