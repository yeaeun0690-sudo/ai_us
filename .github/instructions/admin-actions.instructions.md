---
description: "Use when adding or changing researcher/admin action buttons, downloads, server requests, or progress dialogs."
applyTo: "**/researcher.html,**/admin*.html"
---

# Admin Action Policy

- Review whether each action calls the server, generates data locally, or both. Apply the same waiting and duplicate-prevention policy in all three cases.
- Downloads in researcher.html use runAdminDownload and the shared accessible full-modal progress dialog. Use downloadAdminFile for authenticated files and downloadAdminArchive for queued ZIP jobs.
- Acquire the busy lock synchronously before any asynchronous work. Disable the initiating button and block conflicting actions, including clicks on another button. Release locks and restore the original button state in finally.
- Show the progress modal before work starts. Yield to a browser paint before synchronous local CSV generation. While processing, provide no OK, Cancel, close, backdrop dismissal, or Escape dismissal action.
- Close the download modal only after the browser receives the file handoff, not after job creation or polling completion. Do not claim that the browser has finished saving the file.
- Errors keep a dismissible message visible, unlock the operation, and permit an explicit retry after dismissal. Restore background inert states and initiating-button focus; preserve keyboard focus trapping and dialog labels.
- Bound request and polling wait times. Clean up abort timers and object URLs on all paths. Keep known queued job IDs after polling/file-transfer errors so retry observes the existing job instead of creating a duplicate.
- Do not automatically retry mutations when the server outcome is unknown. Frontend locks do not ensure backend idempotency. For state-changing admin actions, review backend idempotency or reconcile server state before allowing a repeat.
- When applying this policy to additional admin features, inspect each owning handler and its server behavior. Do not migrate unrelated actions blindly. Add focused tests for immediate duplicate clicks, local generation, success, error cleanup, timeout, and retry behavior.