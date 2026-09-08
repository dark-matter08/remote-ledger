// Download everything as one file, for moving to another machine.
//
// A GET so it can be an ordinary link — a form post would work too, but then the
// browser would have to be told how to save the response, and a link already knows.
import { exportGzip, exportFilename } from "../services/portability.server";
import type { Route } from "./+types/api-export";

export async function loader({ request }: Route.LoaderArgs) {
  const profile = new URL(request.url).searchParams.get("profile") || undefined;
  const body = exportGzip(profile);
  return new Response(new Uint8Array(body), {
    headers: {
      "content-type": "application/gzip",
      "content-disposition": `attachment; filename="${exportFilename(profile)}"`,
      "content-length": String(body.length),
      // It is your data leaving your machine on your instruction; nothing should
      // hold a copy on the way past.
      "cache-control": "no-store",
    },
  });
}
