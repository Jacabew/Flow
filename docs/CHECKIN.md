# Jake's check-in
Max 3 items. Each is a yes/no or a 1-minute test. Newest at top.

## Wed 28 Oct — one-time setup (≈30 min, then never again)
1. **Install on the HUB.** Open PowerShell *as Administrator* and run:
   `powershell -ExecutionPolicy Bypass -File "C:\Users\Owner\OneDrive\FLOW\install.ps1"`
   - It asks for a GitHub read-only token (only if the repo is private). Make one at GitHub → Settings → Developer settings → Fine-grained tokens → repo **Jacabew/Flow** → Contents: **Read-only**.
   - It asks for an ntfy topic for phone alerts. Optional: install the free **ntfy** app, subscribe to a long private word (e.g. `darkspace-flow-7q2x9`), type the same word here.
2. **Automatic approval on the build task.** In Claude's scheduled tasks, open **"DS Flow background build"** and turn on **Automatically approve**.
3. Done. Reply "installed" in the DS Flow project.
