import type { ClientMsg, ServerMsg } from "./protocol.ts";
import { SYSTEM, type TableService } from "./service.ts";

export interface Connection {
  receive(msg: ClientMsg): void;
  close(): void;
}

// One client connection, independent of the transport. The WebSocket server
// and the simulator both drive this.
export function openConnection(service: TableService, send: (msg: ServerMsg) => void): Connection {
  let open = true;
  let viewer: string | null | undefined; // undefined until hello
  let unsubscribe = () => {};
  const out = (msg: ServerMsg) => open && send(msg);

  return {
    receive(msg) {
      if (!open) return;
      if (msg?.t === "hello") {
        if (viewer !== undefined) return out({ t: "error", message: "hello sent twice" });
        if (msg.playerId === SYSTEM) return out({ t: "error", message: "reserved name" });
        viewer = typeof msg.playerId === "string" && msg.playerId ? msg.playerId : null;
        const lastSeq = Number.isInteger(msg.lastSeq) && msg.lastSeq >= 0 ? msg.lastSeq : 0;
        out({ t: "welcome", head: service.head });
        unsubscribe = service.subscribe(viewer, lastSeq, (e) => out({ t: "event", seq: e.seq, event: e.event }));
        return;
      }
      if (msg?.t === "cmd" && typeof msg.id === "string") {
        if (!viewer) return out({ t: "result", id: msg.id, result: { ok: false, code: "not_authorized", message: "say hello as a player first" } });
        void service.submit(viewer, msg.id, msg.cmd).then((result) => out({ t: "result", id: msg.id, result }));
        return;
      }
      out({ t: "error", message: "unknown message" });
    },
    close() {
      open = false;
      unsubscribe();
    },
  };
}
