# Start Here

Run these steps once on a fresh clone:

1. Create the Python virtual environment and install dependencies:
   ```powershell
   python -m venv .venv
   .\.venv\Scripts\pip.exe install -e ".[dev]"
   ```
2. Install Node.js and Playwright dependencies:
   ```powershell
   npm install
   npx playwright install chromium
   ```
3. Configure Git hooks and connect Beads:
   ```powershell
   git config core.hooksPath .beads/hooks
   bd dolt start
   bd dolt pull
   bd ping
   ```
4. Build the local Scry SQLite cache:
   ```powershell
   $env:PYTHONUTF8 = "1"
   scry surface
   ```
5. Verify the green bar:
   ```powershell
   .\.venv\Scripts\python.exe -m tools.sdlc_gate green-bar
   npm run test:e2e
   ```
