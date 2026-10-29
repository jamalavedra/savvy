const teamPages = ["/team", "/team/join"];
export function teamReturn(url: URL, stored: string | null) {
  if (
    [
      "oauth_query",
      "client_id",
      "redirect_uri",
      "state",
      "code_challenge",
    ].some((key) => url.searchParams.has(key))
  )
    return null;
  const requested = url.searchParams.get("returnTo");
  const target = requested === null ? stored : requested;
  return target !== null && teamPages.includes(target) ? target : null;
}
