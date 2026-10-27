# Jake's check-in
Max 3 items. Each is a yes/no or a 1-minute test. Newest at top.

## Wed 28 Oct — one-time setup (≈30 min, then never again)
1. **Install on the HUB.** Open PowerShell *as Administrator* and run:
   `powershell -ExecutionPolicy Bypass -File "C:\Users\Owner\OneDrive\FLOW\install.ps1"`
   - It asks for a GitHub read-only token (only if the repo is private). Make one at GitHub → Settings → Developer settings → Fine-grained tokens → repo **Jacabew/Flow** → Contents: **Read-only**.
   - It asks for an ntfy topic for phone alerts. Optional: install the free **ntfy** app, subscribe to a long private word (e.g. `darkspace-flow-7q2x9`), type the same word here.
2. Done. Reply "installed" in the DS Flow project. (The nightly build task already runs without asking for approvals.)
3. **Yes/no:** take `docs/DSOS_REQUESTS.md` (2 items: phone route `flow.darkspace.au` + Mission Control "Automations" tile) to the DSOS Build project after install? Both are copy-paste ready.
