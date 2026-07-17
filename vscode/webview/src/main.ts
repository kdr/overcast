// SPA entry: boots the view named by the host's `init` message and routes all
// later host messages to the active view's handler.
import "./styles.css";
import { onMessage, post } from "./vscodeApi.ts";
import { renderRecordDetail } from "./views/recordDetail.ts";
import { renderScanResults } from "./views/scanResults.ts";
import type { HostMsg, RecordViewState, ScanViewState } from "../../src/shared/protocol.ts";

let active: ((msg: HostMsg) => void) | undefined;

onMessage((msg) => {
  if (msg.type === "init") {
    const app = document.getElementById("app");
    if (!app) return;
    app.classList.remove("loading");
    app.textContent = "";
    active =
      msg.view === "record"
        ? renderRecordDetail(app, msg.state as RecordViewState)
        : renderScanResults(app, msg.state as ScanViewState);
    return;
  }
  active?.(msg);
});

post({ type: "ready" });
