Warning: no stdin data received in 3s, proceeding without it. If piping from a slow command, redirect stdin explicitly: < /dev/null to skip, or wait longer.
## What's Changed

### ✨ New Features
- The dust boot now stands down automatically while ncSender is in laser mode, so it stays out of the beam's path during laser jobs
- In laser mode, all automatic triggers are skipped: retract at job start, retract on tool change, expand on the first rapid move, and retract on home or manual rapids
- Wireless dust boots no longer send a retract command at the end of a laser job
- Manually typed ADB retract and expand markers still work in laser mode, so you keep full control when you need it
- Switching back to a spindle job after a laser job resumes normal automatic behavior, including the job-start retract
- Older ncSender versions that do not report laser mode continue to behave exactly as before
