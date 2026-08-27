import WebSocket from "ws";
const instanceUrl = process.argv[2];
const deviceB64 = process.argv[3];
const url = instanceUrl.replace(/^http/, "ws") + "/api/events";
const ws = new WebSocket(url, { headers: { authorization: "Basic " + deviceB64 } });
const started = Date.now();
ws.on("message", (raw) => {
  console.log("FRAME", Date.now() - started, "ms:", String(raw).slice(0, 120));
});
ws.on("open", () => console.log("WS-OPEN"));
ws.on("error", (e) => { console.log("WS-ERROR", e.message); process.exit(1); });
setTimeout(() => { console.log("DONE-WAIT"); process.exit(0); }, 12000);
