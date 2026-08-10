## What's Changed

### ✨ New Features
- Wireless dust boots now retract automatically when a job finishes, so the boot no longer stays parked over the workpiece after the last line runs
- Manual terminal commands for retracting and expanding the boot continue to work in both wired and wireless setups

### 🐛 Bug Fixes
- Fixed the boot failing to expand when starting a job from a specific line without a tool change; retract and expand are now detected live as the job runs instead of being pre-planned before it starts
- Fixed wireless boots retracting far too early during a tool change; the boot now moves at the actual tool-change moment rather than ahead of the machine
- Fixed wireless boots ignoring retract and expand requests by sending commands the dust boot firmware actually understands

### 🔧 Improvements
- Wireless expand now returns the boot to the position saved on the device itself, so it lands where you set it
- Job start, tool change, and first rapid move are all recognized automatically, giving more reliable boot behavior across resumed and start-from-line jobs
- The plugin now works correctly on both older and newer ncSender versions, so you can update either one in any order
