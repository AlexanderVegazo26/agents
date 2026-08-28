# snagit-clone — UX design decisions, v1

Date: 2026-08-28. Source spec: `snagit-clone/docs/UX-SPEC.md`.

## Decisions made
- Dark-only, rail (72px) + content shell; Library is the launch route. Capture/Record are actions on the rail, not routes.
- Capture overlay, window picker and recording widget are separate always-on-top OS windows.
- Explicit save with dirty-state guard (not autosave). Two discard confirms: never-saved capture (data loss) vs. edited library item (edits only).
- Linear undo stack, depth 50, covers crop and blur; not persisted, cleared on save/close.
- Delete moves to OS trash, single confirm modal, no undo toast.
- 3-stop segmented controls instead of sliders everywhere (stroke, JPG quality, blur intensity, font size).
- WebM-only recordings, PNG/JPG stills. MP4 out of scope (ffmpeg dependency).
- macOS global hotkeys use Ctrl+Opt+Cmd because Cmd+Shift+3/4/5 are OS-owned; Windows avoids PrintScreen and Win+Shift+S.
- **Global stop-recording = Ctrl+Shift+S; in-app Export = Ctrl+Shift+E.** A global binding is intercepted before the focused window sees it, so no combination may be both global and in-app. Do not re-collide these.
- Bare-key shortcuts (tool letters, swatch digits, `[`/`]`, Delete) are inactive while any text input or inline-edit field has focus.
- Single global app-mode state machine (idle / overlay / countdown / recording / editor-dirty); capture and record hotkeys are suppressed during overlay, countdown and recording, and a new capture over a dirty unsaved editor runs the discard confirm before replacing it.
- Text tool commits on Enter and discards on Esc, consistent with Esc-cancels-everywhere.
- Recording is written to the library on stop, so the playback view has no "Save to library" button.

## Assumptions to revisit
- A1 capture:record usage ~10:1 → validates via entry-point instrumentation.
- A2 macOS permission grant may need app relaunch → recovery flow includes "Restart app"; implementer to verify live re-check.
- A3 capture opens straight into the editor rather than landing silently in the library.
- A4 single-user local app, no accounts/sync.
- A5 Ctrl+Shift+<digit> is registrable on Windows — the language-bar / IME layout switcher is the likely collision; test these four first.

## Hypotheses — outcome not yet known
- H1 letter-key tool selection dominates toolbar clicking for repeat users.
- H2 always-on-top widget + global stop hotkey + tray item ⇒ zero "couldn't stop the recording" reports.
- H3 3-stop segmented controls are sufficient; no user requests finer numeric control.

## Open decisions owned by product
- D1 explicit save vs. autosave (spec implements explicit save).
- D2 discarded-unsaved capture deleted outright vs. session holding area (spec implements outright deletion behind a confirm).

## Known bounded accessibility exception
Annotation contrast over an arbitrary screenshot cannot be AA-guaranteed. AA is claimed for chrome only; annotations mitigate via a mandatory 1px contrasting halo plus a text backing plate. Do not let a future spec quietly claim AA over the canvas.

## WCAG numbering note
2.4.11 Focus Not Obscured (Minimum) is the AA criterion and is addressed via toast/widget repositioning. Focus *appearance* (2.4.13) is AAA; this project adopts a focus-ring spec anyway, labelled as a project requirement rather than an AA claim.
