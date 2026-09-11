// One id per server process.
//
// A tab left open across a restart keeps running the code it loaded. Its links still
// work — the server answers data requests whatever bundle asked — so nothing looks
// wrong, and a button whose action no longer exists on the server just does nothing.
// That is how "I only see the old Generate prep button and it exits" happened: the
// page was from before the merge and the server was from after it.
//
// The id changes whenever the process does, which is exactly when the code served
// can have changed. The sidebar's existing poll carries it, and a page that sees a
// different id from the one it booted with knows it is stale.
import { randomUUID } from "node:crypto";

export const BUILD_ID = randomUUID();
