// Focus community query: the Gmail query clause for the communities note's
// senders, or '' when there are none. communityQuery(senders) is pure; the
// senders come from vault.communitySenders(), so no model ever decides which
// lists matter. It never reads the vault itself.

export function communityQuery(senders) {
  const list = [...(senders ?? [])];
  return list.length ? `from:(${list.join(' OR ')}) newer_than:14d` : '';
}
