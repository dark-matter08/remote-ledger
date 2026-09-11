// GET /prep/image/:sid/:n — one screenshot from a prep session, for the thumbnails.
//
// The path on disk is built from two integers and the stored mime type; nothing the
// browser sends is used as a file name, so there is no traversal to guard against
// beyond "is that a number".
import { createReadStream, existsSync } from "node:fs";
import { Readable } from "node:stream";
import type { Route } from "./+types/prep-image";
import { getSession, imagePath } from "../services/prep.server";

export async function loader({ params }: Route.LoaderArgs) {
  const sid = Number(params.sid);
  const n = Number(params.n);
  const session = Number.isInteger(sid) && Number.isInteger(n) ? getSession(sid) : null;
  const path = session ? imagePath(session, n) : null;
  if (!session || !path || !existsSync(path)) return new Response("not found", { status: 404 });
  const img = session.images.find((i) => i.n === n)!;
  return new Response(Readable.toWeb(createReadStream(path)) as unknown as ReadableStream, {
    headers: { "content-type": img.mime, "cache-control": "private, max-age=3600" },
  });
}
