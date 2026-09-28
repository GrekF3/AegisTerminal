type Status = {
  id?: string; state: string; requiresAttention?: boolean; error?: string; closeError?: string;
  notice?: { code: string; message: string; level: string };
};

// Automatic retries and reconciliation belong in the status panel. Only a
// condition requiring intervention interrupts the user, once per incident.
export function createTradingNotifications() {
  let session: string | undefined;
  const seen = new Set<string>();
  return (status: Status): { kind: 'error' | 'warning'; message: string } | null => {
    if (session !== status.id) { session = status.id; seen.clear(); }
    const critical = (status.requiresAttention && !!(status.error || status.closeError)) ||
      ['emergency', 'error', 'loss_limit'].includes(status.state) || status.notice?.code === 'loss_limit';
    if (!critical) return null;
    const message = status.closeError || status.error || status.notice?.message;
    if (!message) return null;
    const key = `${status.notice?.code || status.state}:${message}`;
    if (seen.has(key)) return null;
    seen.add(key);
    return { kind: status.closeError || status.error ? 'error' : 'warning', message };
  };
}
