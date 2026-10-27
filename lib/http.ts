/** Standard reply for routes that are planned but not built yet. */
export function notImplemented(todo: string): Response {
  return Response.json({ error: "not_implemented", todo }, { status: 501 });
}
