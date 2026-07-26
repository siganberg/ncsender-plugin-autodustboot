## What's Changed

### 🔧 Improvements
- Retract and expand now insert a `G4 P0` planner-sync as a separate command, so the dust boot only moves once the machine has physically finished its positioning move — no more actuating mid-rapid
- With "Show added G-code" on, the injected `G4 P0` is wrapped inside the plugin's Start/End comment block for a cleaner console view
- Updated the default retract and expand sequences
